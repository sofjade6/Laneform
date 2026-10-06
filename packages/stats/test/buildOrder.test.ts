import { describe, expect, it } from 'vitest';
import type { TimelineDto } from '@laneform/riot-client';
import {
  buildForParticipant,
  extractPurchases,
  startersKey,
  STARTER_WINDOW_MS,
  type ItemMeta,
} from '../src/buildOrder.ts';

const meta = (over: Partial<ItemMeta> = {}): ItemMeta => ({
  price: 3000,
  buildsInto: [],
  consumable: false,
  isBoots: false,
  ...over,
});

const items = new Map<number, ItemMeta>([
  [1055, meta({ price: 450, consumable: false })],          // objet de départ
  [2003, meta({ price: 50, consumable: true })],            // potion
  [1001, meta({ price: 300, isBoots: true, buildsInto: [3006] })], // bottes de base
  [3006, meta({ price: 1100, isBoots: true })],             // bottes terminées
  [1038, meta({ price: 1300, buildsInto: [3031] })],        // composant
  [3031, meta({ price: 3400 })],                            // objet terminé
  [3094, meta({ price: 2600 })],                            // objet terminé
]);

function timeline(events: Record<string, unknown>[]): TimelineDto {
  return {
    metadata: { matchId: 'EUW1_1', participants: [] },
    info: {
      frameInterval: 60_000,
      frames: [{ timestamp: 0, participantFrames: {}, events: events as never }],
    },
  };
}

const buy = (participantId: number, itemId: number, timestamp: number) => ({
  type: 'ITEM_PURCHASED',
  participantId,
  itemId,
  timestamp,
});

describe('extractPurchases', () => {
  it('retient les achats', () => {
    const p = extractPurchases(timeline([buy(1, 1055, 1000), buy(1, 3031, 600_000)]));
    expect(p.map((x) => x.itemId)).toEqual([1055, 3031]);
  });

  it('retire l’achat annulé', () => {
    // Sans traiter ITEM_UNDO, un objet acheté puis annulé serait compté comme
    // réellement construit.
    const p = extractPurchases(
      timeline([
        buy(1, 1055, 1000),
        buy(1, 3031, 2000),
        { type: 'ITEM_UNDO', participantId: 1, beforeId: 3031, timestamp: 2500 },
      ]),
    );
    expect(p.map((x) => x.itemId)).toEqual([1055]);
  });

  it('n’annule que l’achat le plus récent du bon joueur', () => {
    const p = extractPurchases(
      timeline([
        buy(1, 3031, 1000),
        buy(2, 3031, 1100),
        { type: 'ITEM_UNDO', participantId: 2, beforeId: 3031, timestamp: 1200 },
      ]),
    );
    expect(p).toHaveLength(1);
    expect(p[0]!.participantId).toBe(1);
  });

  it('ignore les événements sans participant', () => {
    expect(extractPurchases(timeline([{ type: 'GAME_END', timestamp: 1 }]))).toEqual([]);
  });
});

describe('buildForParticipant', () => {
  it('sépare les objets de départ des objets terminés', () => {
    const purchases = extractPurchases(
      timeline([
        buy(1, 1055, 500),
        buy(1, 2003, 600),
        buy(1, 1038, 400_000),
        buy(1, 3031, 700_000),
      ]),
    );
    const build = buildForParticipant(purchases, 1, items);
    expect(build.starters).toEqual([1055]); // la potion est écartée
    expect(build.completed).toEqual([3031]); // le composant aussi
  });

  it('compte les bottes terminées, pas les bottes de base', () => {
    const purchases = extractPurchases(
      timeline([buy(1, 1001, 300_000), buy(1, 3006, 500_000)]),
    );
    expect(buildForParticipant(purchases, 1, items).completed).toEqual([3006]);
  });

  it('conserve l’ordre d’achat', () => {
    const purchases = extractPurchases(
      timeline([buy(1, 3094, 600_000), buy(1, 3031, 900_000), buy(1, 3006, 1_200_000)]),
    );
    expect(buildForParticipant(purchases, 1, items).completed).toEqual([3094, 3031, 3006]);
  });

  it('ne compte qu’une fois un objet racheté', () => {
    const purchases = extractPurchases(
      timeline([buy(1, 3031, 600_000), buy(1, 3031, 900_000)]),
    );
    expect(buildForParticipant(purchases, 1, items).completed).toEqual([3031]);
  });

  it('classe selon la fenêtre de départ', () => {
    const justInside = extractPurchases(timeline([buy(1, 1055, STARTER_WINDOW_MS)]));
    expect(buildForParticipant(justInside, 1, items).starters).toEqual([1055]);

    const justOutside = extractPurchases(timeline([buy(1, 1055, STARTER_WINDOW_MS + 1)]));
    expect(buildForParticipant(justOutside, 1, items).starters).toEqual([]);
  });

  it('ignore les achats des autres joueurs', () => {
    const purchases = extractPurchases(timeline([buy(2, 3031, 600_000)]));
    expect(buildForParticipant(purchases, 1, items).completed).toEqual([]);
  });

  it('ignore un objet inconnu du catalogue', () => {
    // Catalogue incomplet (cache ancien) : on ne classe rien plutôt que de
    // classer faux.
    const purchases = extractPurchases(timeline([buy(1, 99999, 600_000)]));
    expect(buildForParticipant(purchases, 1, items).completed).toEqual([]);
  });
});

describe('startersKey', () => {
  it('produit une clé stable', () => {
    expect(startersKey([1055, 2003])).toBe('1055+2003');
    expect(startersKey([])).toBe('');
  });
});
