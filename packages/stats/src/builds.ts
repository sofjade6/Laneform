/**
 * Recommandations de build construites sur l'historique PERSONNEL du joueur.
 *
 * Volontairement pas une tier list : agréger des millions de parties demande un
 * pipeline d'ingestion coûteux. Ici, on répond à une question plus modeste mais
 * honnête — « qu'est-ce qui a marché pour TOI sur ce champion ? » — avec des
 * données que le client League expose déjà en local.
 *
 * Fonctions pures : aucun I/O, testables sans jeu ni réseau.
 */

export interface PastGame {
  championId: number;
  win: boolean;
  /** Items finaux, slots 0 à 6. Les 0 (slot vide) sont ignorés. */
  items: readonly number[];
  kills: number;
  deaths: number;
  assists: number;
  /** Epoch ms. Sert à privilégier les parties récentes. */
  gameCreation: number;
}

export interface ItemFrequency {
  itemId: number;
  games: number;
  wins: number;
  /** `null` si l'échantillon est trop faible pour signifier quoi que ce soit. */
  winRate: number | null;
}

export interface BuildSuggestion {
  championId: number;
  games: number;
  wins: number;
  /** `null` sous le seuil d'échantillon : mieux vaut rien qu'un chiffre trompeur. */
  winRate: number | null;
  /** Items les plus souvent achetés, du plus fréquent au moins fréquent. */
  coreItems: ItemFrequency[];
  /** Build de la victoire au meilleur KDA. `null` si aucune victoire. */
  bestGameItems: readonly number[] | null;
  /** Vrai quand l'échantillon est trop petit pour que les taux soient affichés. */
  lowSample: boolean;
}

export interface BuildOptions {
  /**
   * En dessous de ce nombre de parties, aucun taux de victoire n'est publié.
   *
   * Sur 3 parties, un 67 % est du bruit pur. Afficher le chiffre quand même
   * serait pire que de ne rien afficher : le joueur y lirait un signal.
   */
  minGamesForRate?: number;
  /** Consommables et babioles, exclus du build « cœur ». */
  excludedItemIds?: ReadonlySet<number>;
  maxCoreItems?: number;
}

const DEFAULTS = { minGamesForRate: 5, maxCoreItems: 6 } as const;

function kdaRatio(g: PastGame): number {
  return (g.kills + g.assists) / Math.max(1, g.deaths);
}

export function computeBuildSuggestion(
  history: readonly PastGame[],
  championId: number,
  options: BuildOptions = {},
): BuildSuggestion {
  const minGames = options.minGamesForRate ?? DEFAULTS.minGamesForRate;
  const maxCore = options.maxCoreItems ?? DEFAULTS.maxCoreItems;
  const excluded = options.excludedItemIds ?? new Set<number>();

  const games = history.filter((g) => g.championId === championId);
  const wins = games.filter((g) => g.win).length;
  const lowSample = games.length < minGames;

  const counts = new Map<number, { games: number; wins: number }>();
  for (const g of games) {
    // Dédoublonne : deux exemplaires du même item dans l'inventaire ne
    // comptent pas pour deux parties.
    const unique = new Set(g.items.filter((id) => id > 0 && !excluded.has(id)));
    for (const itemId of unique) {
      const entry = counts.get(itemId) ?? { games: 0, wins: 0 };
      entry.games += 1;
      if (g.win) entry.wins += 1;
      counts.set(itemId, entry);
    }
  }

  const coreItems: ItemFrequency[] = [...counts.entries()]
    .map(([itemId, c]) => ({
      itemId,
      games: c.games,
      wins: c.wins,
      winRate: c.games >= minGames ? c.wins / c.games : null,
    }))
    // Fréquence d'abord : sur un petit échantillon, « souvent acheté » est un
    // signal bien plus solide que « bon taux de victoire ».
    .sort((a, b) => b.games - a.games || b.wins - a.wins || a.itemId - b.itemId)
    .slice(0, maxCore);

  let best: PastGame | null = null;
  for (const g of games) {
    if (!g.win) continue;
    if (!best || kdaRatio(g) > kdaRatio(best)) best = g;
  }

  return {
    championId,
    games: games.length,
    wins,
    winRate: lowSample ? null : wins / games.length,
    coreItems,
    bestGameItems: best ? best.items.filter((id) => id > 0 && !excluded.has(id)) : null,
    lowSample,
  };
}
