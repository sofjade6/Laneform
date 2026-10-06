import { request } from 'undici';
import type Redis from 'ioredis';
import {
  type Platform,
  platformHost,
  regionalHost,
} from '@laneform/shared';
import { RedisRateLimiter, type Bucket } from './limiter.ts';
import {
  applyHeadroom,
  formatRateLimits,
  parseRateLimits,
  parseRetryAfterMs,
  type RateLimit,
} from './limits.ts';
import {
  NotFoundError,
  RateLimitedError,
  RateLimitTimeoutError,
  RiotApiError,
} from './errors.ts';
import type {
  AccountDto,
  CurrentGameDto,
  LeagueEntryDto,
  MatchDto,
  MatchIdsQuery,
  SummonerDto,
  TimelineDto,
} from './types.ts';

export interface RiotClientOptions {
  apiKey: string;
  redis: Redis;
  /** Plafonds applicatifs de la clé, p.ex. `[{count:20,windowSeconds:1}, …]`. */
  appLimits: RateLimit[];
  /** Fraction du quota réellement consommée (0.9 = 10 % de marge). */
  headroom?: number;
  /** Attente max pour obtenir un créneau avant d'abandonner le job. */
  maxWaitMs?: number;
  /** Tentatives sur erreur serveur (5xx / réseau). */
  maxRetries?: number;
  logger?: { warn(o: unknown, m?: string): void; debug(o: unknown, m?: string): void };
}

interface CallOptions {
  method: string;
  host: string;
  path: string;
  /** Scope du bucket "method" : Riot limite par (endpoint × plateforme). */
  platform: Platform;
  query?: Record<string, string | number | undefined>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Unique point de sortie vers l'API Riot.
 *
 * Rien d'autre dans le repo ne doit émettre de requête vers riotgames.com :
 * le rate limiter n'a de sens que s'il voit 100 % du trafic.
 */
export class RiotClient {
  private readonly limiter: RedisRateLimiter;
  private readonly appLimits: RateLimit[];
  private readonly headroom: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly logger: NonNullable<RiotClientOptions['logger']>;
  /** Cache process des plafonds par méthode, découverts via les en-têtes. */
  private readonly methodLimits = new Map<string, RateLimit[]>();

  constructor(private readonly opts: RiotClientOptions) {
    this.limiter = new RedisRateLimiter(opts.redis);
    this.headroom = opts.headroom ?? 0.9;
    this.appLimits = applyHeadroom(opts.appLimits, this.headroom);
    this.maxWaitMs = opts.maxWaitMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.logger = opts.logger ?? { warn: () => {}, debug: () => {} };
  }

  // ---------------------------------------------------------------- endpoints

  /** Riot ID -> PUUID. Routé par RÉGION. */
  async accountByRiotId(platform: Platform, gameName: string, tagLine: string) {
    return this.call<AccountDto>({
      method: 'account-v1.byRiotId',
      host: regionalHost(platform),
      path: `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      platform,
    });
  }

  /** Routé par PLATEFORME. */
  async summonerByPuuid(platform: Platform, puuid: string) {
    return this.call<SummonerDto>({
      method: 'summoner-v4.byPuuid',
      host: platformHost(platform),
      path: `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`,
      platform,
    });
  }

  async leagueEntriesByPuuid(platform: Platform, puuid: string) {
    return this.call<LeagueEntryDto[]>({
      method: 'league-v4.entriesByPuuid',
      host: platformHost(platform),
      path: `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`,
      platform,
    });
  }

  /** Routé par RÉGION. */
  async matchIdsByPuuid(platform: Platform, puuid: string, q: MatchIdsQuery = {}) {
    return this.call<string[]>({
      method: 'match-v5.idsByPuuid',
      host: regionalHost(platform),
      path: `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids`,
      platform,
      query: { start: q.start, count: q.count ?? 20, queue: q.queue, startTime: q.startTime, endTime: q.endTime },
    });
  }

  /** Immuable une fois la partie terminée : ne jamais refetch. */
  async matchById(platform: Platform, matchId: string) {
    return this.call<MatchDto>({
      method: 'match-v5.getMatch',
      host: regionalHost(platform),
      path: `/lol/match/v5/matches/${encodeURIComponent(matchId)}`,
      platform,
    });
  }

  /** ~2 Mo de JSON. Immuable : ne jamais refetch, stocker compressé. */
  async matchTimelineById(platform: Platform, matchId: string) {
    return this.call<TimelineDto>({
      method: 'match-v5.getTimeline',
      host: regionalHost(platform),
      path: `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`,
      platform,
    });
  }

  /** `null` si le joueur n'est pas en partie (404 attendu, pas une erreur). */
  async activeGameByPuuid(platform: Platform, puuid: string): Promise<CurrentGameDto | null> {
    try {
      return await this.call<CurrentGameDto>({
        method: 'spectator-v5.activeGame',
        host: platformHost(platform),
        path: `/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`,
        platform,
      });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  // ------------------------------------------------------------------ interne

  private buckets(method: string, platform: Platform): Bucket[] {
    const out: Bucket[] = this.appLimits.map((limit) => ({ scope: 'app', limit }));
    // Tant que le plafond de la méthode n'a pas été découvert via les en-têtes,
    // seul le plafond applicatif s'applique. C'est le comportement voulu : le
    // premier appel sert de sonde, et les suivants sont correctement bornés.
    const learned = this.methodLimits.get(`${method}:${platform}`);
    if (learned) {
      for (const limit of applyHeadroom(learned, this.headroom)) {
        out.push({ scope: `m:${method}:${platform}`, limit });
      }
    }
    return out;
  }

  private async waitForSlot(method: string, platform: Platform): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const breaker = await this.limiter.breakerRemainingMs();
      if (breaker > 0) {
        if (Date.now() + breaker > deadline) {
          throw new RateLimitTimeoutError(method, this.maxWaitMs);
        }
        await sleep(Math.min(breaker, 1000));
        continue;
      }
      const res = await this.limiter.acquire(this.buckets(method, platform));
      if (res.ok) return;
      if (Date.now() + res.retryAfterMs > deadline) {
        throw new RateLimitTimeoutError(method, this.maxWaitMs);
      }
      // Plafonné à 1 s pour re-tester le coupe-circuit régulièrement, et
      // jitter pour éviter que tous les workers ne repartent à la même ms.
      await sleep(Math.min(res.retryAfterMs, 1000) + Math.random() * 100);
    }
  }

  private async syncFromHeaders(
    method: string,
    platform: Platform,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const h = (name: string): string | null => {
      const v = headers[name];
      return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
    };

    // Les plafonds de méthode ne sont pas documentés par endpoint : Riot les
    // annonce dans la réponse. On les mémorise au premier appel réussi.
    const methodLimitHeader = h('x-method-rate-limit');
    if (methodLimitHeader) {
      const parsed = parseRateLimits(methodLimitHeader);
      if (parsed.length > 0) this.methodLimits.set(`${method}:${platform}`, parsed);
    }

    const obs: { scope: string; count: number; windowSeconds: number }[] = [];
    for (const l of parseRateLimits(h('x-app-rate-limit-count'))) {
      obs.push({ scope: 'app', count: l.count, windowSeconds: l.windowSeconds });
    }
    for (const l of parseRateLimits(h('x-method-rate-limit-count'))) {
      obs.push({ scope: `m:${method}:${platform}`, count: l.count, windowSeconds: l.windowSeconds });
    }
    await this.limiter.sync(obs);
  }

  private async call<T>(o: CallOptions): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const url = `${o.host}${o.path}${qs.size > 0 ? `?${qs}` : ''}`;

    let attempt = 0;
    for (;;) {
      await this.waitForSlot(o.method, o.platform);

      let status: number;
      let headers: Record<string, string | string[] | undefined>;
      let body: string;
      try {
        const res = await request(url, {
          method: 'GET',
          headers: { 'X-Riot-Token': this.opts.apiKey, 'Accept': 'application/json' },
          headersTimeout: 10_000,
          bodyTimeout: 30_000,
        });
        status = res.statusCode;
        headers = res.headers as Record<string, string | string[] | undefined>;
        body = await res.body.text();
      } catch (err) {
        // Panne réseau : on retente, mais sans toucher au coupe-circuit — le
        // quota n'est pas en cause.
        if (attempt++ >= this.maxRetries) throw err;
        await sleep(2 ** attempt * 250 + Math.random() * 250);
        continue;
      }

      await this.syncFromHeaders(o.method, o.platform, headers);

      if (status >= 200 && status < 300) {
        return JSON.parse(body) as T;
      }

      if (status === 404) throw new NotFoundError(o.method, url);

      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(
          typeof headers['retry-after'] === 'string' ? headers['retry-after'] : null,
        );
        const type = headers['x-rate-limit-type'];
        this.logger.warn({ method: o.method, retryAfterMs, type }, 'riot 429');
        await this.limiter.openBreaker(retryAfterMs);
        // On ne retente pas dans le process : le job retourne en file avec son
        // backoff, ce qui laisse le coupe-circuit faire son travail.
        throw new RateLimitedError(o.method, url, retryAfterMs);
      }

      if (status >= 500 && attempt++ < this.maxRetries) {
        await sleep(2 ** attempt * 250 + Math.random() * 250);
        continue;
      }

      throw new RiotApiError(status, o.method, url, body.slice(0, 200));
    }
  }

  /** Expose la config effective (après marge) — utile en logs de démarrage. */
  describeLimits(): string {
    return formatRateLimits(this.appLimits);
  }
}
