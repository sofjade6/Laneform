import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Identité d'un compte.
 *
 * Le PUUID est la seule clé stable : un Riot ID peut être changé par le joueur
 * et réattribué à quelqu'un d'autre. Toute clé étrangère pointe donc sur le
 * PUUID, jamais sur le couple (gameName, tagLine).
 */
export const account = pgTable(
  'account',
  {
    puuid: text('puuid').primaryKey(),
    gameName: text('game_name').notNull(),
    tagLine: text('tag_line').notNull(),
    platform: text('platform').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Recherche insensible à la casse : c'est la requête d'entrée du site.
    uniqueIndex('account_riot_id_idx').on(
      sql`lower(${t.gameName})`,
      sql`lower(${t.tagLine})`,
      t.platform,
    ),
  ],
);

export const summoner = pgTable('summoner', {
  puuid: text('puuid').primaryKey().references(() => account.puuid, { onDelete: 'cascade' }),
  summonerLevel: integer('summoner_level').notNull(),
  profileIconId: integer('profile_icon_id').notNull(),
  /**
   * Epoch ms fourni par Riot. Si cette valeur n'a pas bougé depuis le dernier
   * refresh, aucune partie n'a été jouée : on économise l'appel MATCH-V5.
   * C'est la principale optimisation de quota du bouton "Mettre à jour".
   */
  revisionDate: bigint('revision_date', { mode: 'number' }).notNull(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const leagueEntry = pgTable(
  'league_entry',
  {
    puuid: text('puuid').notNull().references(() => account.puuid, { onDelete: 'cascade' }),
    queueType: text('queue_type').notNull(),
    tier: text('tier').notNull(),
    rank: text('rank').notNull(),
    leaguePoints: integer('league_points').notNull(),
    wins: integer('wins').notNull(),
    losses: integer('losses').notNull(),
    hotStreak: boolean('hot_streak').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.puuid, t.queueType] })],
);

/**
 * Un enregistrement par changement de rank détecté. Alimente la courbe de LP.
 *
 * Cette table ne peut PAS être reconstituée a posteriori : Riot n'expose aucun
 * historique de rank. Chaque jour sans écriture ici est un jour définitivement
 * perdu. À alimenter dès que le crawler tourne, même sans UI pour l'afficher.
 */
export const leagueHistory = pgTable(
  'league_history',
  {
    puuid: text('puuid').notNull(),
    queueType: text('queue_type').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    tier: text('tier').notNull(),
    rank: text('rank').notNull(),
    leaguePoints: integer('league_points').notNull(),
  },
  (t) => [index('league_history_puuid_idx').on(t.puuid, t.queueType, t.capturedAt)],
);

/** Partitionnée par mois sur `game_creation` — voir migrations/0001_partitions.sql. */
export const match = pgTable(
  'match',
  {
    matchId: text('match_id').notNull(),
    platform: text('platform').notNull(),
    queueId: integer('queue_id').notNull(),
    gameVersion: text('game_version').notNull(),
    gameCreation: timestamp('game_creation', { withTimezone: true }).notNull(),
    /** Toujours en SECONDES ici : la normalisation pré-11.20 est faite à l'ingestion. */
    gameDurationSeconds: integer('game_duration_seconds').notNull(),
    winningTeam: smallint('winning_team').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.gameCreation] }),
    index('match_queue_idx').on(t.queueId, t.gameCreation),
  ],
);

export const matchParticipant = pgTable(
  'match_participant',
  {
    matchId: text('match_id').notNull(),
    gameCreation: timestamp('game_creation', { withTimezone: true }).notNull(),
    puuid: text('puuid').notNull(),
    championId: integer('champion_id').notNull(),
    teamId: smallint('team_id').notNull(),
    teamPosition: text('team_position'),
    win: boolean('win').notNull(),

    kills: smallint('kills').notNull(),
    deaths: smallint('deaths').notNull(),
    assists: smallint('assists').notNull(),
    goldEarned: integer('gold_earned').notNull(),
    cs: integer('cs').notNull(),
    damageToChampions: integer('damage_to_champions').notNull(),
    damageTaken: integer('damage_taken').notNull(),
    visionScore: integer('vision_score').notNull(),
    items: integer('items').array(7).notNull(),
    summonerSpells: integer('summoner_spells').array(2).notNull(),
    runes: jsonb('runes').notNull(),

    // Dérivées, calculées une fois à l'ingestion par @laneform/stats.
    // Nullable à dessein : NULL = non mesurable, et ne doit pas peser 0 dans
    // une moyenne (voir packages/stats/src/derived.ts).
    dpm: real('dpm'),
    dtpm: real('dtpm'),
    killParticipation: real('kill_participation'),
    csPerMin: real('cs_per_min'),
    visionPerMin: real('vision_per_min'),
    goldDiffAt14: integer('gold_diff_at_14'),
    csDiffAt14: smallint('cs_diff_at_14'),
    isRemake: boolean('is_remake').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.gameCreation, t.puuid] }),
    // L'index qui porte l'historique de profil : la requête la plus fréquente
    // du site. Keyset pagination sur (game_creation DESC, match_id).
    index('participant_puuid_recent_idx').on(t.puuid, t.gameCreation.desc(), t.matchId),
    index('participant_champion_idx').on(t.championId, t.gameCreation),
  ],
);

/**
 * Timeline brute, compressée (zstd). ~150 Ko au lieu de ~2 Mo de JSON.
 *
 * On la conserve pour pouvoir RECALCULER de nouvelles métriques sur l'existant
 * sans redemander les timelines à Riot — ce que le quota ne permettrait pas.
 * Si le volume devient gênant, cette table part sur S3/R2 sans rien changer
 * d'autre : rien ne la joint, elle est lue par clé.
 */
export const matchTimeline = pgTable('match_timeline', {
  matchId: text('match_id').primaryKey(),
  payload: bytea('payload').notNull(),
  byteSize: integer('byte_size').notNull(),
});

/** Avancement du crawler : évite de re-balayer une ladder déjà traitée. */
export const crawlCursor = pgTable('crawl_cursor', {
  id: text('id').primaryKey(),
  position: jsonb('position').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  itemsSeen: doublePrecision('items_seen').notNull().default(0),
});
