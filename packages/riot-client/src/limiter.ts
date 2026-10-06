import type Redis from 'ioredis';
import type { RateLimit } from './limits.ts';

export interface Bucket {
  /** Identifiant logique, p.ex. `app` ou `m:match-v5.getMatch:euw1`. */
  readonly scope: string;
  readonly limit: RateLimit;
}

export type AcquireResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Compteurs en fenêtre fixe, partagés entre tous les workers via Redis.
 *
 * Fenêtre fixe et non glissante : c'est la sémantique réelle de Riot (les
 * compteurs des en-têtes repartent de zéro à l'expiration), et c'est ce qui
 * permet de resynchroniser nos compteurs sur les leurs en §sync.
 *
 * Toute la logique est en Lua pour que la vérification et l'incrément de
 * PLUSIEURS buckets soient atomiques : vérifier en JS puis incrémenter laisse
 * une fenêtre où deux workers passent tous les deux le dernier jeton.
 */
export class RedisRateLimiter {
  private readonly prefix: string;

  constructor(private readonly redis: Redis, prefix = 'rl') {
    this.prefix = prefix;

    // Phase 1 : on vérifie TOUS les buckets. Phase 2 : on incrémente seulement
    // si aucun ne refuse. Sans ce découpage, un refus sur le 2e bucket laisse le
    // 1er incrémenté — fuite de quota qui ne se résorbe qu'à l'expiration.
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

    // Resynchronisation sur les en-têtes de réponse. On ne prend la valeur de
    // Riot que si elle est SUPÉRIEURE à la nôtre : notre compteur peut être en
    // avance (requêtes en vol non encore comptées côté Riot), et le rabaisser
    // rouvrirait du quota qui n'existe pas.
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

  /** Consomme un jeton sur chaque bucket, ou refuse en indiquant l'attente. */
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

  /** Aligne les compteurs sur les en-têtes `X-*-Rate-Limit-Count` de Riot. */
  async sync(
    observations: readonly { scope: string; count: number; windowSeconds: number }[],
  ): Promise<void> {
    if (observations.length === 0) return;
    const argv: string[] = [];
    for (const o of observations) {
      argv.push(this.key(o.scope, o.windowSeconds), String(o.count), String(o.windowSeconds));
    }
    await (this.redis as never as RedisWithScripts).laneformSync(...argv);
  }

  /**
   * Coupe-circuit global. Déclenché sur 429 : plus AUCUN appel ne sort pendant
   * la fenêtre, tous workers confondus. Un 429 signale que notre vision du
   * quota est fausse ; continuer à émettre, même sur d'autres endpoints,
   * aggrave le dépassement et met la clé en danger.
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
