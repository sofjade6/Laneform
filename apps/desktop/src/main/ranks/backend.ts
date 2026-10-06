import type { Platform } from '@laneform/shared';
import type { RankInfo, RiotId } from './service.ts';

/**
 * Client du backend Laneform.
 *
 * Utilisé à la place des appels directs quand `LANEFORM_API_URL` est
 * renseigné : c'est le serveur qui détient alors la clé Riot, ce qui est
 * indispensable dès que l'application est distribuée.
 */

export interface LookupOutcome {
  ranks: Map<string, RankInfo | null>;
  error: string | null;
}

interface LookupResponse {
  ranks?: Record<string, RankInfo | null>;
  error?: string;
}

export async function lookupRanks(
  apiUrl: string,
  platform: Platform,
  ids: readonly RiotId[],
): Promise<LookupOutcome> {
  if (ids.length === 0) return { ranks: new Map(), error: null };

  try {
    const response = await fetch(`${apiUrl}/v1/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, riotIds: ids }),
      // L'overlay attend ces rangs en début de partie : mieux vaut renoncer
      // que retarder l'affichage.
      signal: AbortSignal.timeout(8000),
    });

    const payload = (await response.json().catch(() => null)) as LookupResponse | null;

    if (!response.ok) {
      return {
        ranks: new Map(),
        error: payload?.error ?? `Backend indisponible (${response.status}).`,
      };
    }

    const ranks = new Map<string, RankInfo | null>();
    for (const [key, value] of Object.entries(payload?.ranks ?? {})) ranks.set(key, value);
    return { ranks, error: null };
  } catch {
    return { ranks: new Map(), error: 'Backend injoignable.' };
  }
}
