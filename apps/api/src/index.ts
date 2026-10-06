import { isPlatform, type Platform } from '@laneform/shared';
import {
  MemoryRateLimiter,
  NotFoundError,
  parseRateLimits,
  RiotApiError,
  RiotClient,
} from '@laneform/riot-client';

/**
 * Backend Laneform.
 *
 * Son unique raison d'être : détenir la clé API Riot, qui ne peut pas vivre
 * dans un exécutable distribué — elle en serait extraite puis révoquée.
 *
 * Deux endpoints seulement, et un cache agressif : les rangs changent d'une
 * partie à l'autre, pas d'une seconde à l'autre.
 */

/** Durée de vie des rangs en cache. */
const RANK_TTL_SECONDS = 600;

/** Au-delà, la requête est refusée : une partie compte dix joueurs. */
const MAX_LOOKUP = 10;

/**
 * Limiteur partagé par les requêtes d'un même isolat.
 *
 * C'est un état module volontaire, et non une fuite de données de requête :
 * un quota n'a de sens que partagé. La limite connue de ce choix est que les
 * isolats ne se voient pas entre eux — d'où une marge de sécurité large et
 * surtout un cache qui rend les appels sortants rares.
 */
const limiter = new MemoryRateLimiter();

interface RiotId {
  gameName: string;
  tagLine: string;
}

interface RankInfo {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

function key(id: RiotId): string {
  return `${id.gameName.toLowerCase()}#${id.tagLine.toLowerCase()}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Clé de cache : une URL synthétique, jamais émise sur le réseau. */
function cacheKey(platform: Platform, id: RiotId): Request {
  return new Request(`https://laneform.invalid/rank/${platform}/${encodeURIComponent(key(id))}`);
}

function parseLookup(payload: unknown): { platform: Platform; ids: RiotId[] } | string {
  if (typeof payload !== 'object' || payload === null) return 'Corps JSON attendu.';
  const body = payload as Record<string, unknown>;

  const platform = typeof body['platform'] === 'string' ? body['platform'].toLowerCase() : '';
  if (!isPlatform(platform)) return 'Plateforme inconnue.';

  const raw = body['riotIds'];
  if (!Array.isArray(raw) || raw.length === 0) return 'riotIds doit être une liste non vide.';
  if (raw.length > MAX_LOOKUP) return `Au plus ${MAX_LOOKUP} joueurs par requête.`;

  const ids: RiotId[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return 'Identifiant mal formé.';
    const { gameName, tagLine } = entry as Record<string, unknown>;
    if (typeof gameName !== 'string' || typeof tagLine !== 'string') {
      return 'gameName et tagLine sont requis.';
    }
    if (gameName.length === 0 || gameName.length > 32 || tagLine.length === 0 || tagLine.length > 8) {
      return 'gameName ou tagLine hors limites.';
    }
    ids.push({ gameName, tagLine });
  }
  return { platform, ids };
}

async function rankOf(
  client: RiotClient,
  platform: Platform,
  id: RiotId,
): Promise<RankInfo | null> {
  const account = await client.accountByRiotId(platform, id.gameName, id.tagLine);
  const entries = await client.leagueEntriesByPuuid(platform, account.puuid);
  const chosen = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') ?? entries[0];
  if (!chosen) return null;

  return {
    queueType: chosen.queueType,
    tier: chosen.tier,
    rank: chosen.rank,
    leaguePoints: chosen.leaguePoints,
    wins: chosen.wins,
    losses: chosen.losses,
  };
}

async function handleLookup(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'JSON invalide.' }, 400);
  }

  const parsed = parseLookup(payload);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  const { platform, ids } = parsed;

  const client = new RiotClient({
    apiKey: env.RIOT_API_KEY,
    limiter,
    appLimits: parseRateLimits(env.RIOT_APP_RATE_LIMITS ?? '500:10,30000:600'),
    // Marge large : les isolats ne partagent pas leur compteur, chacun doit
    // donc rester nettement sous le plafond réel.
    headroom: 0.5,
    // Un client attend une réponse : mieux vaut un rang manquant qu'une
    // requête qui traîne.
    maxWaitMs: 5000,
    logger: {
      warn: (o) => console.warn(JSON.stringify({ level: 'warn', ...(o as object) })),
      debug: () => {},
    },
  });

  const cache = caches.default;
  const ranks: Record<string, RankInfo | null> = {};

  for (const id of ids) {
    const cacheRequest = cacheKey(platform, id);
    const hit = await cache.match(cacheRequest);
    if (hit) {
      ranks[key(id)] = (await hit.json()) as RankInfo | null;
      continue;
    }

    let value: RankInfo | null = null;
    try {
      value = await rankOf(client, platform, id);
    } catch (err) {
      if (err instanceof NotFoundError) {
        value = null; // Joueur inconnu : réponse légitime, mise en cache.
      } else {
        const status = err instanceof RiotApiError ? err.status : 0;
        console.error(JSON.stringify({ level: 'error', message: 'lookup échoué', status }));
        // Échec transitoire : on ne met rien en cache, le client réessaiera.
        ranks[key(id)] = null;
        continue;
      }
    }

    ranks[key(id)] = value;
    // Écriture de cache hors du chemin de réponse.
    ctx.waitUntil(
      cache.put(
        cacheRequest,
        json(value, 200, { 'cache-control': `public, max-age=${RANK_TTL_SECONDS}` }),
      ),
    );
  }

  return json({ platform, ranks }, 200, { 'cache-control': 'no-store' });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/v1/health') {
        return json({ ok: true, keyConfigured: Boolean(env.RIOT_API_KEY) });
      }

      if (url.pathname === '/v1/lookup') {
        if (request.method !== 'POST') return json({ error: 'POST attendu.' }, 405);
        if (!env.RIOT_API_KEY) return json({ error: 'Clé API non configurée.' }, 503);
        return await handleLookup(request, env, ctx);
      }

      return json({ error: 'Endpoint inconnu.' }, 404);
    } catch (err) {
      // Try/catch explicite plutôt que passThroughOnException : une erreur
      // doit produire une réponse structurée, pas disparaître.
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'erreur non gérée',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return json({ error: 'Erreur interne.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
