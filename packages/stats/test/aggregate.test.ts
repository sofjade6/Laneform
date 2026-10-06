import { describe, expect, it } from 'vitest';
import type { MatchDto, ParticipantDto, TimelineDto } from '@laneform/riot-client';
import {
  aggregateMatch,
  buildOrderSummary,
  championSummary,
  collectionFloor,
  emptyStore,
  hasSeenMatch,
  knownPatches,
  loadoutSummary,
  patchKey,
  pruneStalePatches,
  repairBuildOrder,
  prunePatches,
} from '../src/aggregate.ts';

function participant(over: Partial<ParticipantDto> & { championId: number }): ParticipantDto {
  return {
    puuid: `p${over.championId}`,
    championName: 'X',
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

let counter = 0;
function match(over: {
  participants: ParticipantDto[];
  gameVersion?: string;
  gameDuration?: number;
  matchId?: string;
}): MatchDto {
  const id = over.matchId ?? `EUW1_${++counter}`;
  return {
    metadata: { matchId: id, participants: over.participants.map((p) => p.puuid) },
    info: {
      gameCreation: 1,
      gameDuration: over.gameDuration ?? 1800,
      gameEndTimestamp: 2,
      gameVersion: over.gameVersion ?? '14.1.586.1234',
      queueId: 420,
      platformId: 'EUW1',
      participants: over.participants,
      teams: [{ teamId: 100, win: true }, { teamId: 200, win: false }],
    },
  };
}

describe('patchKey', () => {
  it('ne garde que majeure.mineure', () => {
    expect(patchKey('14.1.586.1234')).toBe('14.1');
    expect(patchKey('15.22.1')).toBe('15.22');
  });

  it('laisse passer une version inattendue sans planter', () => {
    expect(patchKey('bizarre')).toBe('bizarre');
  });
});

describe('aggregateMatch', () => {
  it('compte les parties et les victoires par champion et par rôle', () => {
    const store = emptyStore();
    aggregateMatch(store, match({
      participants: [participant({ championId: 7, win: true, teamPosition: 'MIDDLE' })],
    }));
    const s = championSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!;
    expect(s.games).toBe(1);
    expect(s.winRate).toBe(1);
  });

  it('refuse de compter deux fois la même partie', () => {
    const store = emptyStore();
    const m = match({ participants: [participant({ championId: 7 })] });
    expect(aggregateMatch(store, m)).toBe(true);
    expect(aggregateMatch(store, m)).toBe(false);
    expect(championSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!.games).toBe(1);
  });

  it('ignore les remakes', () => {
    const store = emptyStore();
    const ok = aggregateMatch(store, match({
      gameDuration: 200,
      participants: [participant({ championId: 7 })],
    }));
    expect(ok).toBe(false);
    expect(championSummary(store, '14.1', 7, 'MIDDLE')).toBeNull();
  });

  it('ignore les participants sans rôle renseigné', () => {
    const store = emptyStore();
    const ok = aggregateMatch(store, match({
      participants: [participant({ championId: 7, teamPosition: '' })],
    }));
    expect(ok).toBe(false);
  });

  it('cloisonne les patchs', () => {
    // Mélanger les patchs produirait des chiffres qui ne décrivent aucune
    // version réelle du jeu.
    const store = emptyStore();
    aggregateMatch(store, match({
      gameVersion: '14.1.1', participants: [participant({ championId: 7 })],
    }));
    aggregateMatch(store, match({
      gameVersion: '14.2.1', participants: [participant({ championId: 7 })],
    }));
    expect(championSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!.games).toBe(1);
    expect(championSummary(store, '14.2', 7, 'MIDDLE', { minGames: 1 })!.games).toBe(1);
  });

  it('compte les objets et exclut les consommables', () => {
    const store = emptyStore();
    aggregateMatch(
      store,
      match({
        participants: [
          participant({ championId: 7, item0: 100, item1: 2003, item2: 0 } as never),
        ],
      }),
      { excludedItemIds: new Set([2003]) },
    );
    const s = championSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!;
    expect(s.items.map((i) => i.itemId)).toEqual([100]);
  });

  it('ne compte pas deux fois un objet présent en double', () => {
    const store = emptyStore();
    aggregateMatch(store, match({
      participants: [participant({ championId: 7, item0: 100, item1: 100 } as never)],
    }));
    expect(championSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!.items[0]!.games).toBe(1);
  });
});

describe('championSummary', () => {
  const buildStore = (games: number, wins: number) => {
    const store = emptyStore();
    for (let i = 0; i < games; i++) {
      aggregateMatch(store, match({
        participants: [participant({ championId: 7, win: i < wins, item0: 100 } as never)],
      }));
    }
    return store;
  };

  it('masque le taux de victoire sous le seuil', () => {
    const s = championSummary(buildStore(10, 7), '14.1', 7, 'MIDDLE', { minGames: 50 })!;
    expect(s.winRate).toBeNull();
    expect(s.lowSample).toBe(true);
    expect(s.games).toBe(10);
  });

  it('publie le taux au-dessus du seuil', () => {
    const s = championSummary(buildStore(60, 30), '14.1', 7, 'MIDDLE', { minGames: 50 })!;
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.lowSample).toBe(false);
  });

  it('calcule un taux de présence par objet', () => {
    const s = championSummary(buildStore(60, 30), '14.1', 7, 'MIDDLE', { minGames: 50 })!;
    expect(s.items[0]!.pickRate).toBeCloseTo(1);
  });

  it('renvoie null pour un champion jamais vu', () => {
    expect(championSummary(emptyStore(), '14.1', 99, 'MIDDLE')).toBeNull();
  });
});

describe('prunePatches', () => {
  it('ne garde que les patchs les plus récents', () => {
    const store = emptyStore();
    for (const v of ['14.1.1', '14.2.1', '14.10.1']) {
      aggregateMatch(store, match({ gameVersion: v, participants: [participant({ championId: 7 })] }));
    }
    // Tri numérique, pas lexicographique : 14.10 est postérieur à 14.2.
    expect(knownPatches(store)).toEqual(['14.10', '14.2', '14.1']);
    prunePatches(store, 2);
    expect(knownPatches(store)).toEqual(['14.10', '14.2']);
  });
});

describe('hasSeenMatch', () => {
  it('reconnaît une partie déjà comptée', () => {
    const store = emptyStore();
    const m = match({ participants: [participant({ championId: 7 })] });
    expect(hasSeenMatch(store, m.metadata.matchId)).toBe(false);
    aggregateMatch(store, m);
    expect(hasSeenMatch(store, m.metadata.matchId)).toBe(true);
  });

  it('ignore une partie inconnue', () => {
    expect(hasSeenMatch(emptyStore(), 'EUW1_000')).toBe(false);
  });
});

describe('ordre de construction', () => {
  const items = new Map([
    [1055, { price: 450, buildsInto: [], consumable: false, isBoots: false }],
    [3031, { price: 3400, buildsInto: [], consumable: false, isBoots: false }],
    [3094, { price: 2600, buildsInto: [], consumable: false, isBoots: false }],
    [3006, { price: 1100, buildsInto: [], consumable: false, isBoots: true }],
    [3075, { price: 2700, buildsInto: [], consumable: false, isBoots: false }],
  ]);

  function timelineFor(puuid: string): TimelineDto {
    const buy = (itemId: number, timestamp: number) => ({
      type: 'ITEM_PURCHASED',
      participantId: 1,
      itemId,
      timestamp,
    });
    return {
      metadata: { matchId: 'x', participants: [puuid] },
      info: {
        frameInterval: 60_000,
        participants: [{ puuid, participantId: 1 }],
        frames: [
          {
            timestamp: 0,
            participantFrames: {},
            events: [
              buy(1055, 1000),
              buy(3031, 500_000),
              buy(3094, 800_000),
              buy(3006, 1_100_000),
              buy(3075, 1_400_000),
            ] as never,
          },
        ],
      },
    };
  }

  it('enregistre départ, premier objet et séquence', () => {
    const store = emptyStore();
    const me = participant({ championId: 7, win: true });
    aggregateMatch(store, match({ participants: [me] }), {
      timeline: timelineFor(me.puuid),
      items,
    });

    const order = buildOrderSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!;
    expect(order.samples).toBe(1);
    expect(order.starters[0]!.itemIds).toEqual([1055]);
    expect(order.firstItems[0]!.itemIds).toEqual([3031]);
    // Les trois SUIVANTS : le premier objet (3031) est affiché à part.
    expect(order.sequences[0]!.itemIds).toEqual([3094, 3006, 3075]);
  });

  it('renvoie null sans timeline analysée', () => {
    const store = emptyStore();
    aggregateMatch(store, match({ participants: [participant({ championId: 7 })] }));
    expect(buildOrderSummary(store, '14.1', 7, 'MIDDLE')).toBeNull();
  });

  it('masque le taux de victoire sous le seuil', () => {
    const store = emptyStore();
    const me = participant({ championId: 7, win: true });
    aggregateMatch(store, match({ participants: [me] }), {
      timeline: timelineFor(me.puuid),
      items,
    });
    expect(buildOrderSummary(store, '14.1', 7, 'MIDDLE', { minGames: 20 })!.firstItems[0]!.winRate)
      .toBeNull();
  });

  it('signale la part des échantillons', () => {
    const store = emptyStore();
    for (let i = 0; i < 4; i++) {
      const me = participant({ championId: 7, puuid: `p${i}` });
      aggregateMatch(store, match({ participants: [me] }), {
        timeline: timelineFor(me.puuid),
        items,
      });
    }
    expect(buildOrderSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!.firstItems[0]!.share)
      .toBeCloseTo(1);
  });
});

describe('repairBuildOrder', () => {
  it('écarte un relevé compté sans aucun objet terminé', () => {
    // Signature d'une analyse faite avec un catalogue sans prix : des
    // échantillons comptés, des départs enregistrés, zéro objet terminé.
    const store = emptyStore();
    store.patches['14.1'] = {
      matches: 10,
      champions: {
        '7': {
          roles: {
            MIDDLE: {
              games: 10, wins: 5, items: {},
              order: { samples: 200, starters: { '1055': { games: 200, wins: 100 } }, firstItem: {}, nextThree: {} },
            },
          },
        },
      },
    };

    expect(repairBuildOrder(store)).toBe(1);
    expect(store.patches['14.1']!.champions['7']!.roles['MIDDLE']!.order).toBeUndefined();
  });

  it('conserve un relevé exploitable', () => {
    const store = emptyStore();
    store.patches['14.1'] = {
      matches: 10,
      champions: {
        '7': {
          roles: {
            MIDDLE: {
              games: 10, wins: 5, items: {},
              order: { samples: 5, starters: {}, firstItem: { '3031': { games: 5, wins: 3 } }, nextThree: {} },
            },
          },
        },
      },
    };
    expect(repairBuildOrder(store)).toBe(0);
    expect(store.patches['14.1']!.champions['7']!.roles['MIDDLE']!.order).toBeDefined();
  });
});

describe('pruneStalePatches', () => {
  function withPatches(entries: [string, number][]) {
    const store = emptyStore();
    for (const [patch, matches] of entries) {
      store.patches[patch] = { matches, champions: {} };
    }
    return store;
  }

  it('garde le précédent tant que le courant est maigre', () => {
    // Juste après un patch : sans ce filet, le tableau de bord serait vide.
    const store = withPatches([['16.20', 12], ['16.19', 4000]]);
    expect(pruneStalePatches(store, 500)).toEqual([]);
    expect(knownPatches(store)).toEqual(['16.20', '16.19']);
  });

  it('supprime le précédent dès que le courant se suffit', () => {
    const store = withPatches([['16.20', 900], ['16.19', 4000]]);
    expect(pruneStalePatches(store, 500)).toEqual(['16.19']);
    expect(knownPatches(store)).toEqual(['16.20']);
  });

  it('supprime toujours les patchs plus anciens que les deux derniers', () => {
    const store = withPatches([['16.20', 10], ['16.19', 4000], ['16.18', 4000]]);
    expect(pruneStalePatches(store, 500)).toEqual(['16.18']);
  });

  it('ne fait rien sur un agrégat vide', () => {
    expect(pruneStalePatches(emptyStore(), 500)).toEqual([]);
  });
});

describe('sorts et runes', () => {
  const perks = (primary: number, keystone: number, sub: number) => ({
    styles: [
      { description: 'primaryStyle', style: primary, selections: [{ perk: keystone }] },
      { description: 'subStyle', style: sub, selections: [] },
    ],
  });

  function collect(count: number, wins: number) {
    const store = emptyStore();
    for (let i = 0; i < count; i++) {
      aggregateMatch(store, match({
        participants: [
          participant({
            championId: 7,
            win: i < wins,
            summoner1Id: 14,
            summoner2Id: 4,
            perks: perks(8100, 8112, 8200),
          } as never),
        ],
      }));
    }
    return store;
  }

  it('compte la paire de sorts, ordre indifférent', () => {
    const summary = loadoutSummary(collect(40, 20), '14.1', 7, 'MIDDLE', { minGames: 30 })!;
    expect(summary.spells[0]!.value).toEqual([4, 14]);
    expect(summary.spells[0]!.games).toBe(40);
    expect(summary.spells[0]!.share).toBeCloseTo(1);
  });

  it('compte la rune clé et les branches', () => {
    const summary = loadoutSummary(collect(40, 20), '14.1', 7, 'MIDDLE', { minGames: 30 })!;
    expect(summary.runes[0]!.value).toEqual({
      primaryStyleId: 8100,
      keystoneId: 8112,
      subStyleId: 8200,
    });
  });

  it('masque le taux de victoire sous le seuil', () => {
    const summary = loadoutSummary(collect(10, 7), '14.1', 7, 'MIDDLE', { minGames: 30 })!;
    expect(summary.spells[0]!.winRate).toBeNull();
    expect(summary.spells[0]!.games).toBe(10);
  });

  it('renvoie null pour un champion jamais vu', () => {
    expect(loadoutSummary(emptyStore(), '14.1', 99, 'MIDDLE')).toBeNull();
  });

  it('ignore une page de runes incomplète', () => {
    const store = emptyStore();
    aggregateMatch(store, match({
      participants: [participant({ championId: 7, summoner1Id: 4, summoner2Id: 14 } as never)],
    }));
    const summary = loadoutSummary(store, '14.1', 7, 'MIDDLE', { minGames: 1 })!;
    expect(summary.spells).toHaveLength(1);
    expect(summary.runes).toHaveLength(0);
  });
});

describe('collectionFloor', () => {
  function storeWith(matches: number, firstSeenAt?: number) {
    const store = emptyStore();
    store.patches['16.19'] = {
      matches,
      champions: {},
      ...(firstSeenAt !== undefined ? { firstSeenAt } : {}),
    };
    return store;
  }

  const DAY = 24 * 60 * 60 * 1000;

  it('reste indéfini tant que la collecte est jeune', () => {
    // S'accrocher trop tôt amputerait le début du patch.
    expect(collectionFloor(storeWith(50, 1_000 * DAY), 200)).toBeNull();
  });

  it('retranche la marge au minimum observé', () => {
    const first = 1_000 * DAY;
    expect(collectionFloor(storeWith(500, first), 200, 2 * DAY)).toBe(first - 2 * DAY);
  });

  it('reste indéfini sans date observée', () => {
    expect(collectionFloor(storeWith(500), 200)).toBeNull();
  });

  it('ne descend jamais sous zéro', () => {
    expect(collectionFloor(storeWith(500, 1000), 200, 2 * DAY)).toBe(0);
  });

  it('gère un agrégat vide', () => {
    expect(collectionFloor(emptyStore())).toBeNull();
  });
});

describe('firstSeenAt', () => {
  it('retient la création la plus ancienne du patch', () => {
    const store = emptyStore();
    for (const creation of [5000, 2000, 9000]) {
      const m = match({ participants: [participant({ championId: 7 })] });
      m.info.gameCreation = creation;
      aggregateMatch(store, m);
    }
    expect(store.patches['14.1']!.firstSeenAt).toBe(2000);
  });
});
