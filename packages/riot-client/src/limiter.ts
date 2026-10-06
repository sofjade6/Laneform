import type Redis from 'ioredis';
import type { RateLimit } from './limits.ts';

export interface Bucket {
  /** Identifiant logique, p.ex. `app` ou `m:match-v5.getMatch:euw1`. */
  readonly scope: string;
  readonly limit: RateLimit;
}

export type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateObservation {
  scope: string;
  count: number;
  windowSeconds: number;
}

/**
 * Contrat du limiteur de débit.
 *
 * Deux implémentations, pour deux contextes :
 *  - `MemoryRateLimiter` quand un seul process détient la clé (app de bureau) ;
 *  - `RedisRateLimiter` quand plusieurs workers la partagent (backend).
 *
 * Le client Riot ne connaît que cette interface : passer de l'un à l'autre ne
 * change pas une ligne de son code.
 */
export interface RateLimiter {
  acquire(buckets: readonly Bucket[]): Promise<AcquireResult>;
  sync(observations: readonly RateObservation[]): Promise<void>;
  openBreaker(durationMs: number): Promise<void>;
  breakerRemainingMs(): Promise<number>;
}

interface Counter {
  count: number;
  /** Epoch ms de fin de fenêtre. */
  expiresAt: number;
}

/**
 * Compteurs en fenêtre fixe, en mémoire du process.
 *
 * Suffisant — et préférable — quand l'application est seule à utiliser la clé :
 * pas de Redis à installer, pas de latence réseau sur chaque acquisition. Les
 * compteurs repartent de zéro au redémarrage, ce qui est sans conséquence
 * puisque les fenêtres Riot font au plus quelques minutes.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private breakerUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private key(scope: string, windowSeconds: number): string {
    return `${scope}:${windowSeconds}`;
  }

  private live(key: string): Counter | null {
    const entry = this.counters.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.counters.delete(key);
      return null;
    }
    return entry;
  }

  async acquire(buckets: readonly Bucket[]): Promise<AcquireResult> {
    // Deux phases, comme la version Redis : on vérifie TOUS les buckets avant
    // d'en incrémenter un seul. Sinon un refus sur le second laisse le premier
    // incrémenté, et la fuite de quota ne se résorbe qu'à l'expiration.
    for (const b of buckets) {
      const entry = this.live(this.key(b.scope, b.limit.windowSeconds));
      if (entry && entry.count + 1 > b.limit.count) {
        return { ok: false, retryAfterMs: Math.max(0, entry.expiresAt - this.now()) };
      }
    }

    for (const b of buckets) {
      const key = this.key(b.scope, b.limit.windowSeconds);
      const entry = this.live(key);
      if (entry) entry.count += 1;
      else {
        this.counters.set(key, {
          count: 1,
          expiresAt: this.now() + b.limit.windowSeconds * 1000,
        });
      }
    }
    return { ok: true };
  }

  async sync(observations: readonly RateObservation[]): Promise<void> {
    for (const o of observations) {
      const key = this.key(o.scope, o.windowSeconds);
      const entry = this.live(key);
      // On ne retient l'observation de Riot que si elle est SUPÉRIEURE : nos
      // requêtes en vol ne sont pas encore comptées chez eux, et rabaisser le
      // compteur rouvrirait du quota qui n'existe pas.
      if (!entry) {
        this.counters.set(key, { count: o.count, expiresAt: this.now() + o.windowSeconds * 1000 });
      } else if (o.count > entry.count) {
        entry.count = o.count;
      }
    }
  }

  async openBreaker(durationMs: number): Promise<void> {
    if (durationMs <= 0) return;
    this.breakerUntil = Math.max(this.breakerUntil, this.now() + durationMs);
  }

  async breakerRemainingMs(): Promise<number> {
    return Math.max(0, this.breakerUntil - this.now());
  }
}

/**
 * Compteurs partagés entre plusieurs process via Redis.
 *
 * Toute la logique est en Lua pour que la vérification et l'incrément de
 * PLUSIEURS buckets soient atomiques : vérifier en JS puis incrémenter laisse
 * une fenêtre où deux workers passent tous les deux le dernier jeton.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly prefix: string;

  constructor(private readonly redis: Redis, prefix = 'rl') {
    this.prefix = prefix;

    this.redis.defineCommand('laneformAcquire', {
      numberOfKeys: 0,
      lua: `
        local n = #ARGV / 3
        for i = 1, n do
          local key   = ARGV[(i-1)*3 + 1]
          local limit = tonumber(ARGV[(i-1)*3 + 2])
          local cur   = tonumber(redis.call('GET', key) or '0')
          if cur + 1 > limit then
            local ttl = redis.call('PTTL', key)
            if ttl < 0 then ttl = 0 end
            return {0, ttl}
          end
        end
        for i = 1, n do
          local key    = ARGV[(i-1)*3 + 1]
          local window = tonumber(ARGV[(i-1)*3 + 3])
          local v = redis.call('INCR', key)
          if v == 1 then
            redis.call('PEXPIRE', key, window * 1000)
          end
        end
        return {1, 0}
      `,
    });

    this.redis.defineCommand('laneformSync', {
      numberOfKeys: 0,
      lua: `
        local n = #ARGV / 3
        for i = 1, n do
          local key      = ARGV[(i-1)*3 + 1]
          local observed = tonumber(ARGV[(i-1)*3 + 2])
          local window   = tonumber(ARGV[(i-1)*3 + 3])
          local cur = tonumber(redis.call('GET', key) or '0')
          if observed > cur then
            redis.call('SET', key, observed)
            redis.call('PEXPIRE', key, window * 1000)
          end
        end
        return 1
      `,
    });
  }

  private key(scope: string, windowSeconds: number): string {
    return `${this.prefix}:${scope}:${windowSeconds}`;
  }

  async acquire(buckets: readonly Bucket[]): Promise<AcquireResult> {
    if (buckets.length === 0) return { ok: true };
    const argv: string[] = [];
    for (const b of buckets) {
      argv.push(
        this.key(b.scope, b.limit.windowSeconds),
        String(b.limit.count),
        String(b.limit.windowSeconds),
      );
    }
    const [allowed, ttl] = (await (this.redis as never as RedisWithScripts).laneformAcquire(
      ...argv,
    )) as [number, number];
    return allowed === 1 ? { ok: true } : { ok: false, retryAfterMs: ttl };
  }

  async sync(observations: readonly RateObservation[]): Promise<void> {
    if (observations.length === 0) return;
    const argv: string[] = [];
    for (const o of observations) {
      argv.push(this.key(o.scope, o.windowSeconds), String(o.count), String(o.windowSeconds));
    }
    await (this.redis as never as RedisWithScripts).laneformSync(...argv);
  }

  /**
   * Coupe-circuit global. Déclenché sur 429 : plus AUCUN appel ne sort pendant
   * la fenêtre. Un 429 signale que notre vision du quota est fausse ; continuer
   * à émettre aggrave le dépassement et met la clé en danger.
   */
  async openBreaker(durationMs: number): Promise<void> {
    if (durationMs <= 0) return;
    await this.redis.set(`${this.prefix}:breaker`, '1', 'PX', Math.ceil(durationMs));
  }

  async breakerRemainingMs(): Promise<number> {
    const ttl = await this.redis.pttl(`${this.prefix}:breaker`);
    return ttl > 0 ? ttl : 0;
  }
}

interface RedisWithScripts {
  laneformAcquire(...args: string[]): Promise<[number, number]>;
  laneformSync(...args: string[]): Promise<number>;
}
