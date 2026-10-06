import type { MatchDto } from '@laneform/riot-client';

/**
 * Durée de partie en secondes, normalisée.
 *
 * PIÈGE : avant le patch 11.20, `gameDuration` est exprimé en MILLISECONDES ;
 * après, en secondes. Le discriminant officiel est la présence de
 * `gameEndTimestamp`, introduit par ce même patch. Rater ce cas produit des
 * DPM 1000x trop grands sur l'historique ancien — et ces valeurs aberrantes
 * polluent ensuite toutes les moyennes agrégées.
 */
export function durationSeconds(match: MatchDto): number {
  const { gameDuration, gameEndTimestamp } = match.info;
  return gameEndTimestamp === undefined ? Math.round(gameDuration / 1000) : gameDuration;
}

export function durationMinutes(match: MatchDto): number {
  return durationSeconds(match) / 60;
}
