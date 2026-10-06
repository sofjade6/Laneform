import {
  championSummary,
  computeBuildSuggestion,
  matchupSummary,
  type AggregateStore,
  type PastGame,
} from '@laneform/stats';
import { championName, itemName, type GameCatalog } from '../lcu/gamedata.ts';
import type { ChampSelectSession } from '../lcu/client.ts';
import type { ChampSelectPayload } from '../ipc/payload.ts';
import { iconUrl } from '../icons/protocol.ts';

const POSITION_LABEL: Record<string, string> = {
  top: 'Haut',
  jungle: 'Jungle',
  middle: 'Milieu',
  bottom: 'Bas',
  utility: 'Support',
};

function position(raw: string | undefined): string {
  if (!raw) return '';
  return POSITION_LABEL[raw.toLowerCase()] ?? '';
}

/**
 * Champion sélectionné par le joueur local.
 *
 * `myTeam` porte le championId dès qu'un pick est verrouillé, mais reste à 0
 * pendant la phase de déclaration d'intention. On renvoie donc 0 tant que rien
 * n'est choisi, et l'appelant n'affiche simplement pas encore de build.
 */
export function localChampionId(session: ChampSelectSession): number {
  const me = session.myTeam?.find((p) => p.cellId === session.localPlayerCellId);
  return me?.championId ?? 0;
}

/**
 * Construit tout ce que l'overlay affiche pendant la sélection.
 *
 * Les noms sont résolus ici, dans le process principal : le renderer n'a accès
 * ni au catalogue ni au LCU, et doit recevoir des chaînes prêtes à afficher.
 */
export interface GlobalStatsSource {
  store: AggregateStore;
  /** Patch courant. Les agrégats sont cloisonnés, lire le mauvais ne donne rien. */
  patch: string;
}

export function buildChampSelectPayload(
  session: ChampSelectSession,
  catalog: GameCatalog | null,
  history: readonly PastGame[],
  global: GlobalStatsSource | null = null,
): ChampSelectPayload {
  const myChampionId = localChampionId(session);

  // Pas d'icône tant qu'aucun champion n'est verrouillé : une vignette pour
  // « Aucun » afficherait un cadre vide sur chaque ligne du draft.
  const champIcon = (championId: number): string | null =>
    championId > 0 ? iconUrl('champion', championId) : null;

  const allies = (session.myTeam ?? []).map((p) => ({
    champion: championName(catalog, p.championId),
    icon: champIcon(p.championId),
    position: position(p.assignedPosition),
    isMe: p.cellId === session.localPlayerCellId,
  }));

  const enemies = (session.theirTeam ?? []).map((p) => ({
    champion: championName(catalog, p.championId),
    icon: champIcon(p.championId),
  }));

  if (myChampionId <= 0) {
    return {
      myChampion: null,
      myChampionIcon: null,
      allies,
      enemies,
      build: null,
      globalBuild: null,
      matchups: [],
    };
  }

  // Le rôle est en minuscules côté sélection, en majuscules dans les agrégats
  // (qui viennent de `teamPosition` de l'API publique).
  const myRole = (
    session.myTeam?.find((p) => p.cellId === session.localPlayerCellId)?.assignedPosition ?? ''
  ).toUpperCase();

  let matchups: ChampSelectPayload['matchups'] = [];
  if (global && myRole) {
    const all = matchupSummary(global.store, global.patch, myChampionId, myRole) ?? [];
    const enemyIds = new Set(
      (session.theirTeam ?? []).map((p) => p.championId).filter((id) => id > 0),
    );

    matchups = all
      .filter((m) => enemyIds.has(m.opponentId))
      .map((m) => ({
        champion: championName(catalog, m.opponentId),
        icon: iconUrl('champion', m.opponentId),
        games: m.games,
        goldDiff: m.goldDiff,
        items: m.items.map((i) => ({
          name: itemName(catalog, i.itemId),
          icon: iconUrl('item', i.itemId),
          share: i.share,
        })),
      }));
  }

  let globalBuild: ChampSelectPayload['globalBuild'] = null;
  if (global && myRole) {
    const summary = championSummary(global.store, global.patch, myChampionId, myRole);
    if (summary) {
      globalBuild = {
        games: summary.games,
        winRate: summary.winRate,
        lowSample: summary.lowSample,
        patch: global.patch,
        items: summary.items.map((i) => ({
          name: itemName(catalog, i.itemId),
          icon: iconUrl('item', i.itemId),
          pickRate: i.pickRate,
          winRate: i.winRate,
        })),
      };
    }
  }

  const suggestion = computeBuildSuggestion(history, myChampionId, {
    excludedItemIds: catalog?.excludedItemIds ?? new Set<number>(),
  });

  return {
    myChampion: championName(catalog, myChampionId),
    myChampionIcon: champIcon(myChampionId),
    allies,
    enemies,
    build: {
      games: suggestion.games,
      wins: suggestion.wins,
      winRate: suggestion.winRate,
      lowSample: suggestion.lowSample,
      coreItems: suggestion.coreItems.map((i) => ({
        name: itemName(catalog, i.itemId),
        icon: iconUrl('item', i.itemId),
        games: i.games,
        winRate: i.winRate,
      })),
      bestGameItems: suggestion.bestGameItems?.map((id) => itemName(catalog, id)) ?? null,
    },
    globalBuild,
    matchups,
  };
}
