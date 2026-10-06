import type { PastGame } from '@laneform/stats';
import type { LcuClient } from './client.ts';

/**
 * Historique personnel du joueur connecté, lu via le LCU.
 *
 * Point clé : aucune clé API Riot n'est nécessaire. Le client League expose
 * déjà l'historique de son propre utilisateur en local, ce qui rend les
 * recommandations de build personnelles entièrement hors ligne.
 */

const PAGE_SIZE = 20;

/**
 * Forme réelle de la réponse, non documentée et susceptible de bouger entre
 * patchs. Tous les accès passent par des gardes plutôt que par un cast :
 * un champ renommé doit dégrader l'affichage, pas faire planter l'overlay.
 */
interface RawHistory {
  games?: { games?: RawGame[] };
}

interface RawGame {
  gameCreation?: number;
  gameDuration?: number;
  participants?: RawParticipant[];
}

interface RawParticipant {
  championId?: number;
  stats?: Record<string, unknown>;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractItems(stats: Record<string, unknown>): number[] {
  const items: number[] = [];
  for (let slot = 0; slot <= 6; slot++) {
    items.push(num(stats[`item${slot}`]));
  }
  return items;
}

/**
 * L'endpoint renvoie les parties du joueur courant, la plus récente d'abord.
 * Chaque partie ne contient QUE son participant — pas les 9 autres — ce qui
 * rend l'extraction directe.
 */
export async function fetchPersonalHistory(
  client: LcuClient,
  pages = 2,
): Promise<PastGame[]> {
  const out: PastGame[] = [];

  for (let page = 0; page < pages; page++) {
    const begIndex = page * PAGE_SIZE;
    const endIndex = begIndex + PAGE_SIZE - 1;
    const raw = await client
      .get<RawHistory>(
        `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${begIndex}&endIndex=${endIndex}`,
      )
      .catch(() => null);

    const games = raw?.games?.games;
    if (!Array.isArray(games) || games.length === 0) break;

    for (const game of games) {
      const participant = game.participants?.[0];
      const stats = participant?.stats;
      const championId = num(participant?.championId);
      if (!stats || championId <= 0) continue;

      out.push({
        championId,
        win: stats['win'] === true,
        items: extractItems(stats),
        kills: num(stats['kills']),
        deaths: num(stats['deaths']),
        assists: num(stats['assists']),
        gameCreation: num(game.gameCreation),
      });
    }

    if (games.length < PAGE_SIZE) break;
  }

  return out;
}
