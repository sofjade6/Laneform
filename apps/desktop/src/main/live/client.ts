import { request } from 'undici';
import { localAgent } from '../lcu/client.ts';

/** Port fixe de la Live Client Data API, disponible UNIQUEMENT pendant une partie. */
const LIVE_ORIGIN = 'https://127.0.0.1:2999';

export interface LiveGameData {
  activePlayer?: { summonerName?: string; riotIdGameName?: string; level: number };
  allPlayers: LivePlayer[];
  events: { Events: LiveEvent[] };
  gameData: { gameMode: string; gameTime: number; mapName: string };
}

export interface LivePlayer {
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  level: number;
  isDead: boolean;
  respawnTimer: number;
  scores: { kills: number; deaths: number; assists: number; creepScore: number; wardScore: number };
  items: { itemID: number; slot: number; count: number }[];
}

export interface LiveEvent {
  EventID: number;
  EventName: string;
  EventTime: number;
  DragonType?: string;
  KillerName?: string;
  [key: string]: unknown;
}

/**
 * Lit l'état de la partie en cours.
 *
 * Renvoie `null` quand aucune partie ne tourne : l'API n'écoute tout
 * simplement pas, la connexion est refusée. C'est le cas nominal entre deux
 * parties, pas une panne — d'où l'absence de log d'erreur ici.
 */
export async function fetchLiveGameData(): Promise<LiveGameData | null> {
  try {
    const res = await request(`${LIVE_ORIGIN}/liveclientdata/allgamedata`, {
      method: 'GET',
      dispatcher: localAgent,
      headers: { accept: 'application/json' },
      headersTimeout: 2000,
      bodyTimeout: 2000,
    });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }
    const data = (await res.body.json()) as LiveGameData;
    // En écran de chargement, l'API répond déjà mais sans joueurs.
    return Array.isArray(data.allPlayers) ? data : null;
  } catch {
    return null;
  }
}
