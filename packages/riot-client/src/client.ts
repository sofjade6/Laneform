import {
  type Platform,
  platformHost,
  regionalHost,
} from '@laneform/shared';
import type { Bucket, RateLimiter } from './limiter.ts';
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
  LeagueListDto,
  MatchDto,
  MatchIdsQuery,
  SummonerDto,
  TimelineDto,
} from './types.ts';

export interface RiotClientOptions {
  apiKey: string;
  /** `MemoryRateLimiter` en mono-process, `RedisRateLimiter` si la clé est partagée. */
  limiter: RateLimiter;
  /** Plafonds applicatifs de la clé, p.ex. `[{count:20,windowSeconds:1}, …]`. */
  appLimits: RateLimit[];
  /** Fraction du quota réellement consommée (0.9 = 10 % de marge). */
  headroom?: number;
  /** Attente max pour obtenir un créneau avant d'abandonner le job. */
  maxWaitMs?: number;
  /** Tentatives sur erreur serveur (5xx / réseau). */
  maxRetries?: number;
  /**
   * Budget secondaire, plus strict que le plafond applicatif.
   *
   * Sert à borner le trafic de fond : le collecteur consomme à la fois le
   * bucket `app` et ce bucket-ci, alors que les appels interactifs ne
   * consomment que `app`. Quand le budget de fond est épuisé, la collecte
   * attend mais l'interactif garde du quota disponible. Sans ce mécanisme, un
   * crawler sature la clé et les rangs n'arrivent jamais en début de partie.
   */
  secondaryBudget?: { scope: string; fraction: number };
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
  private readonly limiter: RateLimiter;
  private readonly appLimits: RateLimit[];
  private readonly headroom: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private readonly logger: NonNullable<RiotClientOptions['logger']>;
  /** Cache process des plafonds par méthode, découverts via les en-têtes. */
  private readonly methodLimits = new Map<string, RateLimit[]>();

  constructor(private readonly opts: RiotClientOptions) {
    this.limiter = opts.limiter;
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

  /**
   * Ladder Challenger d'une file. Sert d'amorce au collecteur : ces comptes
   * jouent beaucoup, et leurs parties donnent accès à neuf autres joueurs
   * chacune.
   */
  async challengerLeague(platform: Platform, queue = 'RANKED_SOLO_5x5') {
    return this.call<LeagueListDto>({
      method: 'league-v4.challengerLeague',
      host: platformHost(platform),
      path: `/lol/league/v4/challengerleagues/by-queue/${queue}`,
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

    const budget = this.opts.secondaryBudget;
    if (budget) {
      for (const limit of applyHeadroom(this.appLimits, budget.fraction)) {
        out.push({ scope: budget.scope, limit });
      }
    }

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
    headers: Headers,
  ): Promise<void> {
    // Les plafonds de méthode ne sont pas documentés par endpoint : Riot les
    // annonce dans la réponse. On les mémorise au premier appel réussi.
    const methodLimitHeader = headers.get('x-method-rate-limit');
    if (methodLimitHeader) {
      const parsed = parseRateLimits(methodLimitHeader);
      if (parsed.length > 0) this.methodLimits.set(`${method}:${platform}`, parsed);
    }

    const obs: { scope: string; count: number; windowSeconds: number }[] = [];
    for (const l of parseRateLimits(headers.get('x-app-rate-limit-count'))) {
      obs.push({ scope: 'app', count: l.count, windowSeconds: l.windowSeconds });
    }
    for (const l of parseRateLimits(headers.get('x-method-rate-limit-count'))) {
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

      let response: Response;
      let body: string;
      try {
        // `fetch` natif : identique sous Node 18+, et seul transport
        // disponible dans un runtime de périphérie comme Cloudflare Workers.
        response = await fetch(url, {
          method: 'GET',
          headers: { 'X-Riot-Token': this.opts.apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        body = await response.text();
      } catch (err) {
        // Panne réseau : on retente, sans toucher au coupe-circuit — le quota
        // n'est pas en cause.
        if (attempt++ >= this.maxRetries) throw err;
        await sleep(2 ** attempt * 250 + Math.random() * 250);
        continue;
      }

      await this.syncFromHeaders(o.method, o.platform, response.headers);

      if (response.ok) return JSON.parse(body) as T;

      if (response.status === 404) throw new NotFoundError(o.method, url);

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        this.logger.warn(
          { method: o.method, retryAfterMs, type: response.headers.get('x-rate-limit-type') },
          'riot 429',
        );
        await this.limiter.openBreaker(retryAfterMs);
        // On ne retente pas ici : l'appelant replanifie, ce qui laisse le
        // coupe-circuit faire son travail.
        throw new RateLimitedError(o.method, url, retryAfterMs);
      }

      if (response.status >= 500 && attempt++ < this.maxRetries) {
        await sleep(2 ** attempt * 250 + Math.random() * 250);
        continue;
      }

      throw new RiotApiError(response.status, o.method, url, body.slice(0, 200));
    }
  }

  /** Expose la config effective (après marge) — utile en logs de démarrage. */
  describeLimits(): string {
    return formatRateLimits(this.appLimits);
  }
}
