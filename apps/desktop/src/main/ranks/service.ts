import { isPlatform, type Platform } from '@laneform/shared';
import { lookupRanks } from './backend.ts';
import {
  MemoryRateLimiter,
  NotFoundError,
  parseRateLimits,
  RiotApiError,
  RiotClient,
  type RateLimiter,
} from '@laneform/riot-client';

/**
 * Rangs des joueurs d'une partie, via l'API Riot publique.
 *
 * Appel direct depuis l'application, sans backend : la clé est personnelle et
 * ne quitte pas la machine de son propriétaire. Le jour où l'app sera
 * distribuée, il faudra une clé de production derrière un service — la clé
 * serait sinon extraite du binaire, puis révoquée.
 */

export interface RiotId {
  gameName: string;
  tagLine: string;
}

export interface RankInfo {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

/** Clé de cache insensible à la casse : les Riot ID ne le sont pas. */
function idKey(id: RiotId): string {
  return `${id.gameName.toLowerCase()}#${id.tagLine.toLowerCase()}`;
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

const PUUID_TTL_MS = 30 * 24 * 60 * 60 * 1000; // le PUUID est stable
const RANK_TTL_MS = 10 * 60 * 1000;            // le rang bouge d'une partie à l'autre
const MISSING_TTL_MS = 5 * 60 * 1000;          // cache négatif : évite de retaper un 404

export interface RankServiceStatus {
  /** `true` si la clé a été refusée : l'UI doit le dire, pas rester vide. */
  invalidKey: boolean;
  rateLimited: boolean;
  /** Message du backend quand il est injoignable ou en erreur. */
  backendError: string | null;
}

export class RankService {
  private readonly client: RiotClient | null;
  private readonly apiUrl: string | null;
  private readonly puuids = new Map<string, Cached<string | null>>();
  private readonly ranks = new Map<string, Cached<RankInfo | null>>();
  readonly status: RankServiceStatus = {
    invalidKey: false,
    rateLimited: false,
    backendError: null,
  };

  /**
   * Deux modes exclusifs.
   *
   * Avec une URL de backend, aucune clé n'est nécessaire ici — le serveur la
   * détient. Sans backend, on appelle Riot directement avec la clé locale,
   * ce qui convient à un usage personnel.
   */
  constructor(
    apiKey: string | null,
    appLimits = '20:1,100:120',
    limiter?: RateLimiter,
    apiUrl: string | null = null,
  ) {
    this.apiUrl = apiUrl;

    if (apiUrl || !apiKey) {
      this.client = null;
      return;
    }

    this.client = new RiotClient({
      apiKey,
      // Un seul process détient la clé : pas besoin de Redis. En revanche le
      // limiteur doit être PARTAGÉ avec le collecteur, sinon chacun croit
      // disposer du quota entier et la clé prend des 429.
      limiter: limiter ?? new MemoryRateLimiter(),
      appLimits: parseRateLimits(appLimits),
      // L'overlay doit rester réactif : mieux vaut renoncer à un rang que
      // bloquer 30 secondes en attendant un créneau.
      maxWaitMs: 8000,
    });
  }

  static platformFrom(raw: string | null): Platform | null {
    const candidate = (raw ?? '').toLowerCase();
    return isPlatform(candidate) ? candidate : null;
  }

  private fresh<T>(store: Map<string, Cached<T>>, key: string): Cached<T> | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  private async resolvePuuid(platform: Platform, id: RiotId): Promise<string | null> {
    if (!this.client) return null;
    const key = idKey(id);
    const cached = this.fresh(this.puuids, key);
    if (cached) return cached.value;

    try {
      const account = await this.client.accountByRiotId(platform, id.gameName, id.tagLine);
      this.puuids.set(key, { value: account.puuid, expiresAt: Date.now() + PUUID_TTL_MS });
      return account.puuid;
    } catch (err) {
      if (err instanceof NotFoundError) {
        this.puuids.set(key, { value: null, expiresAt: Date.now() + MISSING_TTL_MS });
        return null;
      }
      this.noteFailure(err);
      return null;
    }
  }

  private noteFailure(err: unknown): void {
    if (err instanceof RiotApiError) {
      // 401/403 : clé expirée ou invalide. C'est le cas le plus fréquent avec
      // une clé de développement, qui meurt toutes les 24 h.
      if (err.status === 401 || err.status === 403) this.status.invalidKey = true;
      if (err.status === 429) this.status.rateLimited = true;
    }
  }

  /**
   * Rang d'un joueur, file classée solo en priorité.
   *
   * `null` couvre indifféremment « non classé », « joueur introuvable » et
   * « appel échoué » : du point de vue de l'affichage, c'est le même résultat.
   */
  async rankOf(platform: Platform, id: RiotId): Promise<RankInfo | null> {
    if (!this.client) return null;
    const key = idKey(id);
    const cached = this.fresh(this.ranks, key);
    if (cached) return cached.value;

    const puuid = await this.resolvePuuid(platform, id);
    if (!puuid) return null;

    let value: RankInfo | null = null;
    try {
      const entries = await this.client.leagueEntriesByPuuid(platform, puuid);
      const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5');
      const chosen = solo ?? entries[0];
      if (chosen) {
        value = {
          queueType: chosen.queueType,
          tier: chosen.tier,
          rank: chosen.rank,
          leaguePoints: chosen.leaguePoints,
          wins: chosen.wins,
          losses: chosen.losses,
        };
      }
    } catch (err) {
      if (!(err instanceof NotFoundError)) this.noteFailure(err);
      // Échec ponctuel : TTL court, on retentera à la prochaine partie.
      this.ranks.set(key, { value: null, expiresAt: Date.now() + MISSING_TTL_MS });
      return null;
    }

    this.ranks.set(key, { value, expiresAt: Date.now() + RANK_TTL_MS });
    return value;
  }

  /**
   * Résout une liste de joueurs.
   *
   * Séquentiel, délibérément : dix joueurs font jusqu'à vingt appels, et le
   * plafond d'une clé personnelle est de vingt par seconde. Les lancer en
   * parallèle déclencherait un 429 — donc un coupe-circuit — pour un gain de
   * latence invisible à l'échelle d'une partie.
   */
  async ranksFor(platform: Platform, ids: readonly RiotId[]): Promise<Map<string, RankInfo | null>> {
    if (this.apiUrl) return this.ranksViaBackend(platform, ids);

    const out = new Map<string, RankInfo | null>();
    for (const id of ids) {
      out.set(idKey(id), await this.rankOf(platform, id));
    }
    return out;
  }

  /**
   * Résolution par le backend : une seule requête pour toute la partie.
   *
   * Le cache local reste utile même ici — il évite un aller-retour réseau
   * quand plusieurs parties s'enchaînent avec les mêmes joueurs.
   */
  private async ranksViaBackend(
    platform: Platform,
    ids: readonly RiotId[],
  ): Promise<Map<string, RankInfo | null>> {
    const out = new Map<string, RankInfo | null>();
    const missing: RiotId[] = [];

    for (const id of ids) {
      const cached = this.fresh(this.ranks, idKey(id));
      if (cached) out.set(idKey(id), cached.value);
      else missing.push(id);
    }

    if (missing.length === 0) return out;

    const outcome = await lookupRanks(this.apiUrl!, platform, missing);
    if (outcome.error) {
      this.status.backendError = outcome.error;
    } else {
      this.status.backendError = null;
    }

    for (const id of missing) {
      const value = outcome.ranks.get(idKey(id)) ?? null;
      out.set(idKey(id), value);
      // Échec réseau : TTL court, on retentera à la partie suivante.
      this.ranks.set(idKey(id), {
        value,
        expiresAt: Date.now() + (outcome.error ? MISSING_TTL_MS : RANK_TTL_MS),
      });
    }

    return out;
  }

  static key(id: RiotId): string {
    return idKey(id);
  }
}

/** `OR 42 LP` — compact, pour tenir dans une ligne d'overlay. */
export function formatRank(rank: RankInfo | null): string {
  if (!rank) return 'Non classé';
  return `${rank.tier} ${rank.rank} · ${rank.leaguePoints} LP`;
}
