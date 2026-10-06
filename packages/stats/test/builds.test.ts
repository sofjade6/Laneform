import { describe, expect, it } from 'vitest';
import { computeBuildSuggestion, type PastGame } from '../src/builds.ts';

const game = (over: Partial<PastGame> & { championId: number }): PastGame => ({
  win: true,
  items: [],
  kills: 0,
  deaths: 0,
  assists: 0,
  gameCreation: 0,
  ...over,
});

describe('computeBuildSuggestion', () => {
  it('ne retient que les parties du champion demandé', () => {
    const history = [game({ championId: 1 }), game({ championId: 2 }), game({ championId: 1 })];
    expect(computeBuildSuggestion(history, 1).games).toBe(2);
  });

  it('masque le taux de victoire sous le seuil d’échantillon', () => {
    // Sur 3 parties, un 67 % est du bruit. L'afficher serait pire que rien :
    // le joueur y lirait un signal qui n'existe pas.
    const history = [
      game({ championId: 1, win: true }),
      game({ championId: 1, win: true }),
      game({ championId: 1, win: false }),
    ];
    const s = computeBuildSuggestion(history, 1, { minGamesForRate: 5 });
    expect(s.winRate).toBeNull();
    expect(s.lowSample).toBe(true);
    expect(s.games).toBe(3);
    expect(s.wins).toBe(2);
  });

  it('publie le taux une fois le seuil atteint', () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      game({ championId: 1, win: i < 3 }),
    );
    const s = computeBuildSuggestion(history, 1, { minGamesForRate: 5 });
    expect(s.winRate).toBeCloseTo(0.6);
    expect(s.lowSample).toBe(false);
  });

  it('classe les items par fréquence d’achat', () => {
    const history = [
      game({ championId: 1, items: [100, 200] }),
      game({ championId: 1, items: [100, 300] }),
      game({ championId: 1, items: [100, 200] }),
    ];
    const core = computeBuildSuggestion(history, 1).coreItems;
    expect(core[0]).toMatchObject({ itemId: 100, games: 3 });
    expect(core[1]).toMatchObject({ itemId: 200, games: 2 });
  });

  it('ignore les slots vides et les items exclus', () => {
    const history = [game({ championId: 1, items: [0, 100, 2003, 0] })];
    const core = computeBuildSuggestion(history, 1, {
      excludedItemIds: new Set([2003]),
    }).coreItems;
    expect(core.map((c) => c.itemId)).toEqual([100]);
  });

  it('ne compte pas deux fois un item présent en double', () => {
    const history = [game({ championId: 1, items: [100, 100] })];
    expect(computeBuildSuggestion(history, 1).coreItems[0]!.games).toBe(1);
  });

  it('retient le build de la victoire au meilleur KDA', () => {
    const history = [
      game({ championId: 1, win: true, kills: 1, deaths: 5, assists: 0, items: [10] }),
      game({ championId: 1, win: true, kills: 10, deaths: 1, assists: 5, items: [20] }),
      // Meilleur KDA, mais défaite : ne doit pas être proposé en modèle.
      game({ championId: 1, win: false, kills: 20, deaths: 0, assists: 0, items: [30] }),
    ];
    expect(computeBuildSuggestion(history, 1).bestGameItems).toEqual([20]);
  });

  it('renvoie null quand aucune victoire n’existe', () => {
    const history = [game({ championId: 1, win: false, items: [10] })];
    expect(computeBuildSuggestion(history, 1).bestGameItems).toBeNull();
  });

  it('gère un historique vide sans planter', () => {
    const s = computeBuildSuggestion([], 42);
    expect(s).toMatchObject({ games: 0, wins: 0, winRate: null, bestGameItems: null });
    expect(s.coreItems).toEqual([]);
  });

  it('limite le nombre d’items proposés', () => {
    const history = [game({ championId: 1, items: [1, 2, 3, 4, 5, 6, 7, 8] })];
    expect(computeBuildSuggestion(history, 1, { maxCoreItems: 3 }).coreItems).toHaveLength(3);
  });
});
