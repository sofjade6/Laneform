import { REMAKE_DURATION_SECONDS, TEAM_POSITIONS, type TeamPosition } from '@laneform/shared';
import type { MatchDto, ParticipantDto, TimelineDto } from '@laneform/riot-client';
import { durationMinutes, durationSeconds } from './duration.ts';

/**
 * Minute de référence pour les écarts de lane.
 *
 * CONVENTION : 14 min, et non 15 comme la plupart des sites concurrents. Les
 * frames de timeline sont espacées de 60 s, et la minute 14 reste avant le
 * premier regroupement massif, donc avant que l'écart cesse de mesurer la
 * phase de lane. Conséquence assumée : nos `goldDiff` ne sont PAS comparables
 * à ceux affichés ailleurs. À indiquer dans l'UI.
 */
export const LANE_DIFF_MINUTE = 14;

export interface DerivedStats {
  dpm: number;
  dtpm: number;
  killParticipation: number | null;
  csPerMin: number;
  visionPerMin: number;
  goldDiffAt14: number | null;
  csDiffAt14: number | null;
  /** Remake : conservé pour l'historique, exclu de toute moyenne. */
  isRemake: boolean;
}

function totalCs(p: ParticipantDto): number {
  return p.totalMinionsKilled + p.neutralMinionsKilled;
}

function isTeamPosition(v: string): v is TeamPosition {
  return (TEAM_POSITIONS as readonly string[]).includes(v);
}

/**
 * Adversaire direct = même `teamPosition`, équipe opposée.
 * Renvoie `null` si la position est vide — Riot ne la renseigne pas sur les
 * parties anciennes ni sur les remakes. Dans ce cas les écarts valent `null`,
 * JAMAIS 0 : un 0 se confondrait avec un duel parfaitement équilibré et
 * tirerait les moyennes vers le centre.
 */
function findOpponent(participants: ParticipantDto[], me: ParticipantDto): ParticipantDto | null {
  if (!isTeamPosition(me.teamPosition)) return null;
  return (
    participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition) ?? null
  );
}

/** Index `participantId` -> `puuid`, à partir de la timeline. */
function participantIdByPuuid(timeline: TimelineDto): Map<string, number> {
  const map = new Map<string, number>();
  const declared = timeline.info.participants;
  if (declared) {
    for (const p of declared) map.set(p.puuid, p.participantId);
    return map;
  }
  // Repli : l'ordre de `metadata.participants` correspond aux participantId 1..10.
  timeline.metadata.participants.forEach((puuid, i) => map.set(puuid, i + 1));
  return map;
}

function frameAtMinute(timeline: TimelineDto, minute: number) {
  const target = minute * 60_000;
  let best: (typeof timeline.info.frames)[number] | undefined;
  for (const frame of timeline.info.frames) {
    if (frame.timestamp <= target) best = frame;
    else break;
  }
  return best;
}

/**
 * Calcule les métriques dérivées d'un joueur sur une partie.
 *
 * Fonction PURE : aucun I/O, aucune dépendance au temps. C'est ce qui permet de
 * la rejouer sur les timelines archivées quand on ajoute une métrique, au lieu
 * de redemander des millions de timelines à Riot.
 */
export function computeDerivedStats(
  match: MatchDto,
  timeline: TimelineDto | null,
  puuid: string,
): DerivedStats | null {
  const me = match.info.participants.find((p) => p.puuid === puuid);
  if (!me) return null;

  const seconds = durationSeconds(match);
  const minutes = durationMinutes(match);
  const isRemake = seconds < REMAKE_DURATION_SECONDS;

  // Garde-fou : une durée nulle ou négative rendrait toutes les divisions
  // infinies. Mieux vaut des zéros explicites qu'un Infinity en base.
  if (minutes <= 0) {
    return {
      dpm: 0, dtpm: 0, killParticipation: null, csPerMin: 0,
      visionPerMin: 0, goldDiffAt14: null, csDiffAt14: null, isRemake: true,
    };
  }

  const teamKills = match.info.participants
    .filter((p) => p.teamId === me.teamId)
    .reduce((sum, p) => sum + p.kills, 0);

  let goldDiffAt14: number | null = null;
  let csDiffAt14: number | null = null;

  const opponent = findOpponent(match.info.participants, me);
  if (timeline && opponent) {
    const frame = frameAtMinute(timeline, LANE_DIFF_MINUTE);
    // Partie terminée avant la minute de référence : pas de donnée, pas de 0.
    if (frame) {
      const ids = participantIdByPuuid(timeline);
      const myId = ids.get(me.puuid);
      const oppId = ids.get(opponent.puuid);
      const mine = myId !== undefined ? frame.participantFrames[String(myId)] : undefined;
      const theirs = oppId !== undefined ? frame.participantFrames[String(oppId)] : undefined;
      if (mine && theirs) {
        goldDiffAt14 = mine.totalGold - theirs.totalGold;
        csDiffAt14 =
          mine.minionsKilled + mine.jungleMinionsKilled -
          (theirs.minionsKilled + theirs.jungleMinionsKilled);
      }
    }
  }

  return {
    dpm: me.totalDamageDealtToChampions / minutes,
    dtpm: me.totalDamageTaken / minutes,
    // Une équipe à 0 kill donne une division par zéro : KP indéfini, pas 0.
    killParticipation: teamKills > 0 ? (me.kills + me.assists) / teamKills : null,
    csPerMin: totalCs(me) / minutes,
    visionPerMin: me.visionScore / minutes,
    goldDiffAt14,
    csDiffAt14,
    isRemake,
  };
}
