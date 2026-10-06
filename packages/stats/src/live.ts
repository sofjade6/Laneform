/**
 * Statistiques dérivées de la partie EN COURS.
 *
 * Distinct de `derived.ts`, qui travaille sur une partie terminée à partir des
 * DTO de l'API publique : ici la source est la Live Client Data API, dont le
 * format et les champs disponibles sont différents.
 */

export interface LiveScores {
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  wardScore: number;
}

export interface LivePlayerLike {
  championName: string;
  team: 'ORDER' | 'CHAOS';
  scores: LiveScores;
  level: number;
  isDead: boolean;
  respawnTimer: number;
}

export interface LivePlayerStats {
  championName: string;
  team: 'ORDER' | 'CHAOS';
  kda: number | null;
  /** CS absolu. Affiché à côté du CS/min, qui est une moyenne et bouge lentement. */
  creepScore: number;
  csPerMin: number;
  killParticipation: number | null;
  level: number;
  isDead: boolean;
  respawnTimer: number;
}

/** KDA. `null` sur 0 mort : un ratio infini n'a pas de sens, l'UI affiche « Perfect ». */
export function kda(s: LiveScores): number | null {
  return s.deaths === 0 ? null : (s.kills + s.assists) / s.deaths;
}

/**
 * `gameTime` est en secondes depuis le lancement de la partie, écran de
 * chargement inclus. En dessous d'une minute le CS/min n'a pas de sens : on
 * renvoie 0 plutôt qu'une valeur explosive qui ferait sursauter l'affichage.
 */
export function csPerMin(creepScore: number, gameTime: number): number {
  const minutes = gameTime / 60;
  return minutes < 1 ? 0 : creepScore / minutes;
}

export function computeLiveStats(
  players: readonly LivePlayerLike[],
  gameTime: number,
): LivePlayerStats[] {
  const teamKills = new Map<string, number>();
  for (const p of players) {
    teamKills.set(p.team, (teamKills.get(p.team) ?? 0) + p.scores.kills);
  }

  return players.map((p) => {
    const total = teamKills.get(p.team) ?? 0;
    return {
      championName: p.championName,
      team: p.team,
      kda: kda(p.scores),
      creepScore: p.scores.creepScore,
      csPerMin: csPerMin(p.scores.creepScore, gameTime),
      // Équipe à 0 kill : indéfini, surtout pas 0 (voir derived.ts, même règle).
      killParticipation: total > 0 ? (p.scores.kills + p.scores.assists) / total : null,
      level: p.level,
      isDead: p.isDead,
      respawnTimer: p.respawnTimer,
    };
  });
}
