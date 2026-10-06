import { describe, expect, it } from 'vitest';
import { dashboardSummary } from '../src/dashboard.ts';
import { emptyStore, type AggregateStore } from '../src/aggregate.ts';

function store(): AggregateStore {
  const s = emptyStore();
  s.patches['14.2'] = {
    matches: 120,
    champions: {
      '7': {
        roles: {
          MIDDLE: { games: 100, wins: 55, items: {} },
          TOP: { games: 20, wins: 8, items: {} },
        },
      },
      '12': { roles: { TOP: { games: 40, wins: 25, items: {} } } },
    },
  };
  s.patches['14.1'] = { matches: 10, champions: {} };
  return s;
}

describe('dashboardSummary', () => {
  it('retient le patch le plus récent par défaut', () => {
    const s = dashboardSummary(store());
    expect(s.patch).toBe('14.2');
    expect(s.availablePatches).toEqual(['14.2', '14.1']);
  });

  it('permet de cibler un patch précis', () => {
    expect(dashboardSummary(store(), { patch: '14.1' }).matches).toBe(10);
  });

  it('cumule les rôles d’un même champion', () => {
    const row = dashboardSummary(store(), { minGames: 50 }).champions[0]!;
    expect(row.championId).toBe(7);
    expect(row.games).toBe(120);
    expect(row.wins).toBe(63);
    expect(row.winRate).toBeCloseTo(63 / 120);
  });

  it('masque le taux sous le seuil, au global comme par rôle', () => {
    const s = dashboardSummary(store(), { minGames: 50 });
    const champion = s.champions.find((c) => c.championId === 12)!;
    expect(champion.winRate).toBeNull();
    expect(champion.lowSample).toBe(true);

    const top = s.champions[0]!.roles.find((r) => r.role === 'TOP')!;
    expect(top.games).toBe(20);
    expect(top.winRate).toBeNull();
  });

  it('classe les champions par volume, pas par taux de victoire', () => {
    // L'ordre doit rester stable quand les taux bougent : il sert à juger la
    // couverture de la collecte.
    expect(dashboardSummary(store()).champions.map((c) => c.championId)).toEqual([7, 12]);
  });

  it('classe les rôles du plus joué au moins joué', () => {
    expect(dashboardSummary(store()).champions[0]!.roles.map((r) => r.role)).toEqual([
      'MIDDLE',
      'TOP',
    ]);
  });

  it('compte les observations joueur, distinctes des parties', () => {
    const s = dashboardSummary(store());
    expect(s.matches).toBe(120);
    expect(s.observations).toBe(160);
  });

  it('gère un agrégat vide', () => {
    const s = dashboardSummary(emptyStore());
    expect(s).toMatchObject({ patch: null, matches: 0, observations: 0 });
    expect(s.champions).toEqual([]);
  });
});
