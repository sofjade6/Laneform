import {
  buildOrderSummary,
  loadoutSummary,
  championSummary,
  dashboardSummary,
  matchupSummary,
  type AggregateStore,
  type MatchupOption,
  type OrderOption,
} from '@laneform/stats';
import {
  championName,
  itemName,
  perkName,
  perkStyleName,
  spellName,
  type GameCatalog,
} from '../lcu/gamedata.ts';
import { iconUrl } from '../icons/protocol.ts';

/**
 * Met en forme l'agrégat pour le tableau de bord.
 *
 * Les noms sont résolus ici : le renderer n'a accès ni au catalogue du client
 * League ni au système de fichiers, et doit recevoir de quoi afficher
 * directement.
 */

export interface DashboardChampion {
  championId: number;
  name: string;
  /** Toujours fourni : si le fichier manque, l'interface retombe sur le texte. */
  icon: string;
  games: number;
  winRate: number | null;
  lowSample: boolean;
  roles: { role: string; games: number; winRate: number | null }[];
}

export interface DashboardPayload {
  patch: string | null;
  availablePatches: string[];
  matches: number;
  observations: number;
  collector: {
    matchesCollected: number;
    running: boolean;
    paused: boolean;
    lastError: string | null;
  } | null;
  catalogReady: boolean;
  champions: DashboardChampion[];
}

export interface OrderEntry {
  items: { name: string; icon: string }[];
  games: number;
  share: number;
  winRate: number | null;
}

export interface OrderSection {
  samples: number;
  starters: OrderEntry[];
  firstItems: OrderEntry[];
  sequences: OrderEntry[];
}

export interface LoadoutEntry {
  items: { name: string; icon: string }[];
  games: number;
  share: number;
  winRate: number | null;
}

export interface LoadoutSection {
  spells: LoadoutEntry[];
  runes: LoadoutEntry[];
  /** Chaque rune choisie, individuellement. */
  perks: LoadoutEntry[];
}

export interface MatchupEntry {
  opponentId: number;
  name: string;
  icon: string;
  games: number;
  winRate: number | null;
  /** Écart d'or à 14 min : moyenne, marge à 95 %, effectif. */
  goldDiff: { mean: number; margin: number; n: number } | null;
  items: { name: string; icon: string; share: number }[];
}

export interface BuildDetail {
  championId: number;
  name: string;
  role: string;
  games: number;
  winRate: number | null;
  lowSample: boolean;
  items: { name: string; icon: string; pickRate: number; winRate: number | null; games: number }[];
  /** `null` tant qu'aucune timeline n'a été analysée pour ce couple. */
  order: OrderSection | null;
  /** Duels de couloir, du plus fréquent au moins fréquent. */
  matchups: MatchupEntry[];
  /** Sorts d'invocateur et runes. `null` si le champion n'a jamais été vu. */
  loadout: LoadoutSection | null;
}

export function buildDashboardPayload(
  store: AggregateStore,
  catalog: GameCatalog | null,
  collector: DashboardPayload['collector'],
  patch?: string,
): DashboardPayload {
  const summary = dashboardSummary(store, patch ? { patch } : {});

  return {
    patch: summary.patch,
    availablePatches: summary.availablePatches,
    matches: summary.matches,
    observations: summary.observations,
    collector,
    // Sans client League ouvert, les noms restent numériques : il faut le dire
    // plutôt que laisser croire à des données corrompues.
    catalogReady: (catalog?.champions.size ?? 0) > 0,
    champions: summary.champions.map((c) => ({
      championId: c.championId,
      name: championName(catalog, c.championId),
      icon: iconUrl('champion', c.championId),
      games: c.games,
      winRate: c.winRate,
      lowSample: c.lowSample,
      roles: c.roles,
    })),
  };
}

function toEntry(catalog: GameCatalog | null, option: OrderOption): OrderEntry {
  return {
    items: option.itemIds.map((id) => ({ name: itemName(catalog, id), icon: iconUrl('item', id) })),
    games: option.games,
    share: option.share,
    winRate: option.winRate,
  };
}

function toMatchup(catalog: GameCatalog | null, option: MatchupOption): MatchupEntry {
  return {
    opponentId: option.opponentId,
    name: championName(catalog, option.opponentId),
    icon: iconUrl('champion', option.opponentId),
    games: option.games,
    winRate: option.winRate,
    goldDiff: option.goldDiff,
    items: option.items.map((i) => ({
      name: itemName(catalog, i.itemId),
      icon: iconUrl('item', i.itemId),
      share: i.share,
    })),
  };
}

function toLoadout(
  catalog: GameCatalog | null,
  summary: ReturnType<typeof loadoutSummary>,
): LoadoutSection | null {
  if (!summary) return null;

  return {
    spells: summary.spells.map((o) => ({
      items: o.value.map((id) => ({ name: spellName(catalog, id), icon: iconUrl('spell', id) })),
      games: o.games,
      share: o.share,
      winRate: o.winRate,
    })),
    // Rune clé puis les deux branches : c'est l'ordre dans lequel on lit une
    // page de runes en jeu.
    runes: summary.runes.map((o) => ({
      items: [
        { name: perkName(catalog, o.value.keystoneId), icon: iconUrl('perk', o.value.keystoneId) },
        {
          name: perkStyleName(catalog, o.value.primaryStyleId),
          icon: iconUrl('perkstyle', o.value.primaryStyleId),
        },
        {
          name: perkStyleName(catalog, o.value.subStyleId),
          icon: iconUrl('perkstyle', o.value.subStyleId),
        },
      ],
      games: o.games,
      share: o.share,
      winRate: o.winRate,
    })),
    perks: summary.perks.map((o) => ({
      items: [{ name: perkName(catalog, o.value), icon: iconUrl('perk', o.value) }],
      games: o.games,
      share: o.share,
      winRate: o.winRate,
    })),
  };
}

export function buildDetail(
  store: AggregateStore,
  catalog: GameCatalog | null,
  patch: string,
  championId: number,
  role: string,
): BuildDetail | null {
  const summary = championSummary(store, patch, championId, role, { maxItems: 8 });
  if (!summary) return null;

  const rawOrder = buildOrderSummary(store, patch, championId, role);
  const order: OrderSection | null = rawOrder
    ? {
        samples: rawOrder.samples,
        starters: rawOrder.starters.map((o) => toEntry(catalog, o)),
        firstItems: rawOrder.firstItems.map((o) => toEntry(catalog, o)),
        sequences: rawOrder.sequences.map((o) => toEntry(catalog, o)),
      }
    : null;

  const matchups = (matchupSummary(store, patch, championId, role) ?? []).map((m) =>
    toMatchup(catalog, m),
  );

  return {
    championId,
    name: championName(catalog, championId),
    role,
    order,
    matchups,
    loadout: toLoadout(catalog, loadoutSummary(store, patch, championId, role)),
    games: summary.games,
    winRate: summary.winRate,
    lowSample: summary.lowSample,
    items: summary.items.map((i) => ({
      name: itemName(catalog, i.itemId),
      icon: iconUrl('item', i.itemId),
      pickRate: i.pickRate,
      winRate: i.winRate,
      games: i.games,
    })),
  };
}
