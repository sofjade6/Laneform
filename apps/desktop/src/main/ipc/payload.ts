import type { AppState } from '../state/machine.ts';
import type { LivePlayerStats, ObjectiveTimer } from '@laneform/stats';

export interface ChampSelectPayload {
  /** `null` tant que le joueur n'a rien verrouillé. */
  myChampion: string | null;
  /** Toujours fournie : si le fichier manque, l'interface retombe sur le texte. */
  myChampionIcon: string | null;
  allies: { champion: string; icon: string | null; position: string; isMe: boolean }[];
  enemies: { champion: string; icon: string | null }[];
  build: {
    games: number;
    wins: number;
    /** `null` si l'échantillon est trop faible pour être publié. */
    winRate: number | null;
    lowSample: boolean;
    coreItems: { name: string; icon: string; games: number; winRate: number | null }[];
    bestGameItems: string[] | null;
  } | null;
  /**
   * Duels face aux champions adverses présents dans la sélection.
   *
   * Tous les ennemis, pas seulement le vis-à-vis : en file classée les rôles
   * adverses ne sont pas communiqués, deviner le couloir serait hasardeux.
   */
  matchups: {
    champion: string;
    icon: string;
    games: number;
    goldDiff: { mean: number; margin: number; n: number } | null;
    items: { name: string; icon: string; share: number }[];
  }[];
  /** Statistiques issues du collecteur local. `null` si pas encore de données. */
  globalBuild: {
    games: number;
    winRate: number | null;
    lowSample: boolean;
    patch: string;
    items: { name: string; icon: string; pickRate: number; winRate: number | null }[];
  } | null;
}

export interface CollectorPayload {
  matchesCollected: number;
  paused: boolean;
  running: boolean;
  lastError: string | null;
}

/** Statistiques live enrichies du rang, résolu via l'API Riot. */
export type PlayerRow = LivePlayerStats & {
  /** Déjà formaté. `null` tant que la résolution n'a pas abouti. */
  rank: string | null;
};

/** Unique forme de message envoyée au renderer. */
export interface OverlayPayload {
  state: AppState;
  game: {
    gameTime: number;
    gameMode: string;
    players: PlayerRow[];
    objectives: ObjectiveTimer[];
  } | null;
  champSelect: ChampSelectPayload | null;
  collector: CollectorPayload | null;
}
