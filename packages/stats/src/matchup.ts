/**
 * Duels de couloir : écart d'or à 14 minutes et objets construits face à un
 * adversaire donné.
 *
 * Ces deux mesures ont été préférées au taux de victoire de matchup parce
 * qu'elles convergent bien plus vite. Un taux de victoire demande ~1 000
 * duels pour descendre sous ±3 points ; une moyenne d'écart d'or est
 * exploitable vers 50, et un build majoritaire émerge vers 30.
 */

import type { MatchDto, ParticipantDto, TimelineDto } from '@laneform/riot-client';

/** Minute de référence, alignée sur `derived.ts`. */
export const MATCHUP_MINUTE = 14;

/**
 * Adversaire direct : même `teamPosition`, équipe opposée.
 *
 * `null` si la position n'est pas renseignée — parties anciennes, remakes,
 * certains modes. Mieux vaut aucune donnée qu'un duel inventé.
 */
export function laneOpponent(
  participants: readonly ParticipantDto[],
  me: ParticipantDto,
): ParticipantDto | null {
  if (!me.teamPosition) return null;
  return (
    participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition) ?? null
  );
}

/** participantId de la timeline, indexé par puuid. */
function participantIds(timeline: TimelineDto): Map<string, number> {
  const map = new Map<string, number>();
  const declared = timeline.info.participants;
  if (declared) {
    for (const p of declared) map.set(p.puuid, p.participantId);
    return map;
  }
  timeline.metadata.participants.forEach((puuid, i) => map.set(puuid, i + 1));
  return map;
}

function frameAtMinute(timeline: TimelineDto, minute: number) {
  const target = minute * 60_000;
  let best: TimelineDto['info']['frames'][number] | undefined;
  for (const frame of timeline.info.frames ?? []) {
    if (frame.timestamp <= target) best = frame;
    else break;
  }
  return best;
}

/**
 * Écart d'or à la minute de référence, du point de vue de `me`.
 *
 * `null` si la partie s'est terminée avant, ou si l'un des deux joueurs est
 * introuvable dans la timeline : un 0 se confondrait avec un duel équilibré.
 */
export function goldDiffAtMinute(
  timeline: TimelineDto,
  mePuuid: string,
  opponentPuuid: string,
  minute = MATCHUP_MINUTE,
): number | null {
  const frame = frameAtMinute(timeline, minute);
  if (!frame) return null;

  // Partie terminée avant la minute visée : la dernière frame disponible ne
  // représente pas la phase de lane, on préfère ne rien mesurer.
  if (frame.timestamp < minute * 60_000) return null;

  const ids = participantIds(timeline);
  const mine = ids.get(mePuuid);
  const theirs = ids.get(opponentPuuid);
  if (mine === undefined || theirs === undefined) return null;

  const a = frame.participantFrames[String(mine)];
  const b = frame.participantFrames[String(theirs)];
  if (!a || !b) return null;

  return a.totalGold - b.totalGold;
}

/**
 * Accumulateur d'une série, sans conserver les valeurs.
 *
 * La somme et la somme des carrés suffisent à la moyenne et à l'écart-type :
 * stocker chaque mesure ferait grossir le fichier sans rien apporter.
 */
export interface Series {
  n: number;
  sum: number;
  squares: number;
}

export function pushSeries(series: Series, value: number): void {
  series.n += 1;
  series.sum += value;
  series.squares += value * value;
}

export interface SeriesStats {
  mean: number;
  /** Demi-largeur de l'intervalle de confiance à 95 %. */
  margin: number;
  n: number;
}

/**
 * Moyenne et marge d'erreur. `null` sous le seuil : publier une moyenne sur
 * cinq duels inviterait à la lire comme un fait.
 */
export function seriesStats(series: Series, minSamples: number): SeriesStats | null {
  if (series.n < minSamples || series.n < 2) return null;

  const mean = series.sum / series.n;
  // Variance d'échantillon ; bornée à 0, les erreurs d'arrondi pouvant la
  // rendre très légèrement négative sur des séries quasi constantes.
  const variance = Math.max(0, series.squares / series.n - mean * mean);
  const standardError = Math.sqrt(variance / series.n);

  return { mean, margin: 1.96 * standardError, n: series.n };
}

/** Objets finaux retenus pour un duel, exclusions appliquées. */
export function finalItems(
  participant: ParticipantDto,
  excluded: ReadonlySet<number>,
): number[] {
  const ids = [0, 1, 2, 3, 4, 5, 6]
    .map((slot) => participant[`item${slot}`])
    .filter((id): id is number => typeof id === 'number' && id > 0 && !excluded.has(id));
  return [...new Set(ids)];
}

/** Durée en secondes, tolérante au format pré-11.20 (voir `duration.ts`). */
export function matchSeconds(match: MatchDto): number {
  const { gameDuration, gameEndTimestamp } = match.info;
  return gameEndTimestamp === undefined ? Math.round(gameDuration / 1000) : gameDuration;
}
