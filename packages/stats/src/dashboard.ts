/**
 * Vue d'ensemble de la collecte, destinée au tableau de bord.
 *
 * Purement dérivée de l'agrégat : aucune donnée supplémentaire n'est stockée
 * pour l'affichage. Le coût est un parcours de quelques centaines de
 * compartiments, négligeable devant un rendu de fenêtre.
 */

import type { AggregateStore } from './aggregate.ts';
import { knownPatches } from './aggregate.ts';

export interface RoleBreakdown {
  role: string;
  games: number;
  winRate: number | null;
}

export interface ChampionRow {
  championId: number;
  games: number;
  wins: number;
  /** `null` sous le seuil : un taux sur 12 parties n'informe sur rien. */
  winRate: number | null;
  lowSample: boolean;
  /** Rôles où le champion a été vu, du plus joué au moins joué. */
  roles: RoleBreakdown[];
}

export interface DashboardSummary {
  patch: string | null;
  availablePatches: string[];
  /** Parties distinctes agrégées sur ce patch. */
  matches: number;
  /** Somme des lignes joueur : 10 par partie complète. */
  observations: number;
  champions: ChampionRow[];
}

const DEFAULT_MIN_GAMES = 50;

export interface DashboardOptions {
  minGames?: number;
  patch?: string;
}

export function dashboardSummary(
  store: AggregateStore,
  options: DashboardOptions = {},
): DashboardSummary {
  const minGames = options.minGames ?? DEFAULT_MIN_GAMES;
  const available = knownPatches(store);
  const patch = options.patch ?? available[0] ?? null;

  if (!patch || !store.patches[patch]) {
    return { patch, availablePatches: available, matches: 0, observations: 0, champions: [] };
  }

  const bucket = store.patches[patch];
  const champions: ChampionRow[] = [];
  let observations = 0;

  for (const [id, champion] of Object.entries(bucket.champions)) {
    let games = 0;
    let wins = 0;
    const roles: RoleBreakdown[] = [];

    for (const [role, stats] of Object.entries(champion.roles)) {
      games += stats.games;
      wins += stats.wins;
      roles.push({
        role,
        games: stats.games,
        winRate: stats.games >= minGames ? stats.wins / stats.games : null,
      });
    }

    if (games === 0) continue;
    observations += games;
    roles.sort((a, b) => b.games - a.games);

    champions.push({
      championId: Number(id),
      games,
      wins,
      winRate: games >= minGames ? wins / games : null,
      lowSample: games < minGames,
      roles,
    });
  }

  // Tri par volume : c'est l'ordre utile pour juger ce que vaut la collecte,
  // et il ne change pas quand les taux de victoire bougent.
  champions.sort((a, b) => b.games - a.games || a.championId - b.championId);

  return {
    patch,
    availablePatches: available,
    matches: bucket.matches,
    observations,
    champions,
  };
}
