import type { MatchDto, ParticipantDto, TimelineDto } from '@laneform/riot-client';

/** Fixtures synthétiques : chiffres ronds choisis pour que les attendus soient évidents. */

export function participant(over: Partial<ParticipantDto> & { puuid: string }): ParticipantDto {
  return {
    championId: 1,
    championName: 'Test',
    teamId: 100,
    teamPosition: 'MIDDLE',
    win: true,
    kills: 0,
    deaths: 0,
    assists: 0,
    goldEarned: 0,
    totalMinionsKilled: 0,
    neutralMinionsKilled: 0,
    totalDamageDealtToChampions: 0,
    totalDamageTaken: 0,
    visionScore: 0,
    ...over,
  };
}

export function match(over: {
  gameDuration: number;
  gameEndTimestamp?: number;
  participants: ParticipantDto[];
}): MatchDto {
  return {
    metadata: { matchId: 'EUW1_1', participants: over.participants.map((p) => p.puuid) },
    info: {
      gameCreation: 1_700_000_000_000,
      gameDuration: over.gameDuration,
      ...(over.gameEndTimestamp !== undefined ? { gameEndTimestamp: over.gameEndTimestamp } : {}),
      gameVersion: '14.1.1',
      queueId: 420,
      platformId: 'EUW1',
      participants: over.participants,
      teams: [
        { teamId: 100, win: true },
        { teamId: 200, win: false },
      ],
    },
  };
}

/** Timeline à frames d'une minute. `gold[i]` = or du participant i+1 à chaque minute. */
export function timeline(opts: {
  puuids: string[];
  minutes: number;
  goldPerMinute: number[];
  csPerMinute: number[];
}): TimelineDto {
  const frames = [];
  for (let m = 0; m <= opts.minutes; m++) {
    const participantFrames: TimelineDto['info']['frames'][number]['participantFrames'] = {};
    opts.puuids.forEach((_, i) => {
      participantFrames[String(i + 1)] = {
        participantId: i + 1,
        totalGold: (opts.goldPerMinute[i] ?? 0) * m,
        xp: 100 * m,
        level: 1,
        minionsKilled: (opts.csPerMinute[i] ?? 0) * m,
        jungleMinionsKilled: 0,
      };
    });
    frames.push({ timestamp: m * 60_000, participantFrames, events: [] });
  }
  return {
    metadata: { matchId: 'EUW1_1', participants: opts.puuids },
    info: {
      frameInterval: 60_000,
      frames,
      participants: opts.puuids.map((puuid, i) => ({ puuid, participantId: i + 1 })),
    },
  };
}
