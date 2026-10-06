/** Sous-ensemble des DTO Riot réellement consommés. Volontairement partiel. */

export interface AccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface SummonerDto {
  puuid: string;
  profileIconId: number;
  summonerLevel: number;
  /** Epoch ms de la dernière modification du compte. Clé de l'optimisation de refresh. */
  revisionDate: number;
}

export interface LeagueEntryDto {
  puuid: string;
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
  veteran: boolean;
  freshBlood: boolean;
  inactive: boolean;
}

export interface MatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameDuration: number;
    gameEndTimestamp?: number;
    gameVersion: string;
    queueId: number;
    platformId: string;
    participants: ParticipantDto[];
    teams: { teamId: number; win: boolean }[];
  };
}

export interface ParticipantDto {
  puuid: string;
  championId: number;
  championName: string;
  teamId: number;
  teamPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  totalDamageDealtToChampions: number;
  totalDamageTaken: number;
  visionScore: number;
  [key: string]: unknown;
}

export interface TimelineDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    /** Intervalle entre deux frames, en ms. Vaut 60000 en pratique. */
    frameInterval: number;
    frames: TimelineFrameDto[];
    participants?: { participantId: number; puuid: string }[];
  };
}

export interface TimelineFrameDto {
  timestamp: number;
  participantFrames: Record<string, ParticipantFrameDto>;
  events: { type: string; timestamp: number; [key: string]: unknown }[];
}

export interface ParticipantFrameDto {
  participantId: number;
  totalGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position?: { x: number; y: number };
}

export interface CurrentGameDto {
  gameId: number;
  gameType: string;
  gameQueueConfigId: number;
  gameStartTime: number;
  participants: {
    puuid: string;
    championId: number;
    teamId: number;
    spell1Id: number;
    spell2Id: number;
  }[];
}

export interface MatchIdsQuery {
  start?: number;
  count?: number;
  queue?: number;
  startTime?: number;
  endTime?: number;
}
