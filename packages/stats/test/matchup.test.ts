import { describe, expect, it } from 'vitest';
import type { ParticipantDto, TimelineDto } from '@laneform/riot-client';
import {
  goldDiffAtMinute,
  laneOpponent,
  pushSeries,
  seriesStats,
  MATCHUP_MINUTE,
} from '../src/matchup.ts';

function participant(over: Partial<ParticipantDto> & { puuid: string }): ParticipantDto {
  return {
    championId: 1,
    championName: 'X',
    teamId: 100,
    teamPosition: 'MIDDLE',
    win: true,
    kills: 0, deaths: 0, assists: 0,
    goldEarned: 0, totalMinionsKilled: 0, neutralMinionsKilled: 0,
    totalDamageDealtToChampions: 0, totalDamageTaken: 0, visionScore: 0,
    ...over,
  };
}

describe('laneOpponent', () => {
  const me = participant({ puuid: 'me', teamId: 100, teamPosition: 'MIDDLE' });
  const opp = participant({ puuid: 'opp', teamId: 200, teamPosition: 'MIDDLE' });
  const other = participant({ puuid: 'other', teamId: 200, teamPosition: 'TOP' });

  it('trouve l’adversaire du même rôle', () => {
    expect(laneOpponent([me, opp, other], me)?.puuid).toBe('opp');
  });

  it('ignore un allié du même rôle', () => {
    const ally = participant({ puuid: 'ally', teamId: 100, teamPosition: 'MIDDLE' });
    expect(laneOpponent([me, ally], me)).toBeNull();
  });

  it('renvoie null sans position renseignée', () => {
    // Parties anciennes et remakes : mieux vaut aucun duel qu'un duel inventé.
    const noRole = participant({ puuid: 'me', teamPosition: '' });
    expect(laneOpponent([noRole, opp], noRole)).toBeNull();
  });
});

function timeline(minutes: number, goldA: number, goldB: number): TimelineDto {
  const frames = [];
  for (let m = 0; m <= minutes; m++) {
    frames.push({
      timestamp: m * 60_000,
      participantFrames: {
        '1': { participantId: 1, totalGold: goldA * m, xp: 0, level: 1, minionsKilled: 0, jungleMinionsKilled: 0 },
        '2': { participantId: 2, totalGold: goldB * m, xp: 0, level: 1, minionsKilled: 0, jungleMinionsKilled: 0 },
      },
      events: [],
    });
  }
  return {
    metadata: { matchId: 'x', participants: ['me', 'opp'] },
    info: {
      frameInterval: 60_000,
      frames,
      participants: [
        { puuid: 'me', participantId: 1 },
        { puuid: 'opp', participantId: 2 },
      ],
    },
  };
}

describe('goldDiffAtMinute', () => {
  it('calcule l’écart à la minute de référence', () => {
    expect(goldDiffAtMinute(timeline(20, 400, 350), 'me', 'opp')).toBe(50 * MATCHUP_MINUTE);
  });

  it('renvoie null si la partie finit avant', () => {
    // Un remake ou une reddition précoce ne décrit pas une phase de lane.
    expect(goldDiffAtMinute(timeline(8, 400, 350), 'me', 'opp')).toBeNull();
  });

  it('renvoie null si un joueur est absent de la timeline', () => {
    expect(goldDiffAtMinute(timeline(20, 400, 350), 'me', 'inconnu')).toBeNull();
  });
});

describe('seriesStats', () => {
  const series = (values: number[]) => {
    const s = { n: 0, sum: 0, squares: 0 };
    for (const v of values) pushSeries(s, v);
    return s;
  };

  it('calcule la moyenne', () => {
    expect(seriesStats(series([100, 200, 300]), 3)!.mean).toBeCloseTo(200);
  });

  it('resserre la marge quand l’effectif grandit', () => {
    const few = seriesStats(series(Array.from({ length: 10 }, (_, i) => i * 100)), 5)!;
    const many = seriesStats(series(Array.from({ length: 200 }, (_, i) => (i % 10) * 100)), 5)!;
    expect(many.margin).toBeLessThan(few.margin);
  });

  it('renvoie null sous le seuil', () => {
    // Publier une moyenne sur cinq duels inviterait à la lire comme un fait.
    expect(seriesStats(series([100, 200, 300]), 50)).toBeNull();
  });

  it('donne une marge nulle sur une série constante', () => {
    expect(seriesStats(series([200, 200, 200, 200]), 2)!.margin).toBeCloseTo(0);
  });
});
