/** Files d'attente classées (queueId Riot). Seules celles-ci sont ingérées. */
export const QUEUE_RANKED_SOLO = 420;
export const QUEUE_RANKED_FLEX = 440;
export const QUEUE_NORMAL_DRAFT = 400;
export const QUEUE_ARAM = 450;

export const INGESTED_QUEUES = [
  QUEUE_RANKED_SOLO,
  QUEUE_RANKED_FLEX,
  QUEUE_NORMAL_DRAFT,
  QUEUE_ARAM,
] as const;

export type RankedQueueType = 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR';

export const TEAM_POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
export type TeamPosition = (typeof TEAM_POSITIONS)[number];

/**
 * En dessous de 5 minutes, la partie est un remake : les stats sont vides ou
 * aberrantes. Exclues de toutes les moyennes, mais conservées en base pour que
 * l'historique affiché corresponde à ce que le joueur a réellement joué.
 */
export const REMAKE_DURATION_SECONDS = 300;
