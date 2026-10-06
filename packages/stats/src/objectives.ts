/**
 * Timers d'objectifs, calculés depuis les événements de la Live Client Data API.
 *
 * Fonctions PURES : elles reçoivent les événements et l'horloge de jeu, et ne
 * lisent jamais l'heure système.
 */

export type ObjectiveKind = 'DRAGON' | 'BARON' | 'VOID_GRUBS';

export type ObjectiveStatus =
  | 'PENDING'      // pas encore apparu pour la première fois
  | 'AVAILABLE'    // sur la carte, à prendre
  | 'RESPAWNING'   // tué, décompte en cours
  | 'GONE';        // ne réapparaîtra plus (fenêtre fermée)

export interface ObjectiveConfig {
  readonly kind: ObjectiveKind;
  /** Nom de l'événement émis par la Live Client Data API. */
  readonly eventName: string;
  /** Apparition initiale, en secondes de jeu. */
  readonly firstSpawnSeconds: number;
  /** Réapparition après un kill. `null` = ne réapparaît pas. */
  readonly respawnSeconds: number | null;
  /** Instant au-delà duquel l'objectif disparaît définitivement. */
  readonly despawnSeconds?: number;
}

/**
 * ⚠️ VALEURS À VÉRIFIER À CHAQUE PATCH ⚠️
 *
 * Ce sont des constantes d'équilibrage que Riot modifie régulièrement, et les
 * noms d'événements ne sont pas documentés publiquement. Un timer faux est pire
 * que pas de timer, parce que le joueur s'y fie pour décider d'un engage.
 *
 * Pour relever les vrais noms d'événements sur TA version du jeu :
 *   $env:LANEFORM_DEBUG_EVENTS="1"; npm run desktop:dev
 * puis tuer les objectifs en Outil d'entraînement. Chaque nom inconnu est
 * affiché dans la console PowerShell.
 *
 * Tout se corrige ici, en un seul endroit.
 */
export const OBJECTIVES: readonly ObjectiveConfig[] = [
  {
    kind: 'DRAGON',
    eventName: 'DragonKill',
    firstSpawnSeconds: 300,
    respawnSeconds: 300,
  },
  {
    kind: 'BARON',
    eventName: 'BaronKill',
    firstSpawnSeconds: 1200,
    respawnSeconds: 360,
  },
  {
    // Les larves apparaissent une fois, peuvent réapparaître une seconde fois,
    // puis la fenêtre se ferme définitivement — d'où `despawnSeconds`, qui
    // n'existe pour aucun autre objectif.
    kind: 'VOID_GRUBS',
    eventName: 'HordeKill',
    firstSpawnSeconds: 360,
    respawnSeconds: 240,
    despawnSeconds: 840,
  },
];

export interface ObjectiveEvent {
  EventName: string;
  EventTime: number;
}

export interface ObjectiveTimer {
  kind: ObjectiveKind;
  status: ObjectiveStatus;
  /** `null` tant que l'objectif n'a jamais été tué. */
  lastKilledAt: number | null;
  /** Secondes avant le prochain changement d'état. 0 si déjà disponible ou terminé. */
  secondsUntilNext: number;
}

function lastKillTime(events: readonly ObjectiveEvent[], eventName: string): number | null {
  let last: number | null = null;
  for (const e of events) {
    if (e.EventName === eventName && (last === null || e.EventTime > last)) last = e.EventTime;
  }
  return last;
}

/**
 * État d'un objectif à l'instant `gameTime`.
 *
 * Corrige le défaut de la première version, qui déclarait tout disponible dès
 * 0:00 : un objectif jamais tué n'est pas pour autant présent sur la carte, il
 * faut d'abord attendre son apparition initiale.
 */
export function objectiveTimer(
  config: ObjectiveConfig,
  events: readonly ObjectiveEvent[],
  gameTime: number,
): ObjectiveTimer {
  const { kind, firstSpawnSeconds, respawnSeconds, despawnSeconds } = config;
  const lastKilledAt = lastKillTime(events, config.eventName);

  // Jamais tué : soit il n'est pas encore apparu, soit il attend sur la carte.
  if (lastKilledAt === null) {
    if (gameTime < firstSpawnSeconds) {
      return {
        kind,
        status: 'PENDING',
        lastKilledAt: null,
        secondsUntilNext: firstSpawnSeconds - gameTime,
      };
    }
    if (despawnSeconds !== undefined && gameTime >= despawnSeconds) {
      return { kind, status: 'GONE', lastKilledAt: null, secondsUntilNext: 0 };
    }
    return { kind, status: 'AVAILABLE', lastKilledAt: null, secondsUntilNext: 0 };
  }

  if (respawnSeconds === null) {
    return { kind, status: 'GONE', lastKilledAt, secondsUntilNext: 0 };
  }

  // Borné des DEUX côtés. Une horloge qui recule (reconnexion, événement reçu
  // en avance) donne un `elapsed` négatif : sans le borner à 0, le temps
  // restant dépasserait la durée de réapparition, et l'overlay afficherait un
  // Baron à 7:40 alors qu'il n'en fait que 6:00.
  const elapsed = Math.max(0, gameTime - lastKilledAt);
  const remaining = Math.max(0, respawnSeconds - elapsed);
  const respawnAt = lastKilledAt + respawnSeconds;

  // La fenêtre se ferme avant la réapparition : inutile d'afficher un décompte
  // vers un objectif qui n'arrivera jamais.
  if (despawnSeconds !== undefined && respawnAt >= despawnSeconds) {
    return { kind, status: 'GONE', lastKilledAt, secondsUntilNext: 0 };
  }

  if (remaining > 0) {
    return { kind, status: 'RESPAWNING', lastKilledAt, secondsUntilNext: remaining };
  }

  if (despawnSeconds !== undefined && gameTime >= despawnSeconds) {
    return { kind, status: 'GONE', lastKilledAt, secondsUntilNext: 0 };
  }

  return { kind, status: 'AVAILABLE', lastKilledAt, secondsUntilNext: 0 };
}

export function allObjectiveTimers(
  events: readonly ObjectiveEvent[],
  gameTime: number,
): ObjectiveTimer[] {
  return OBJECTIVES.map((config) => objectiveTimer(config, events, gameTime));
}

/** `MM:SS`, pour affichage direct dans l'overlay. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
