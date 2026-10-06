import { describe, expect, it } from 'vitest';
import type { PastGame } from '@laneform/stats';
import { buildChampSelectPayload, localChampionId } from '../src/main/champselect/tracker.ts';
import type { ChampSelectSession } from '../src/main/lcu/client.ts';
import type { GameCatalog } from '../src/main/lcu/gamedata.ts';

const catalog: GameCatalog = {
  champions: new Map([
    [1, { id: 1, name: 'Alpha' }],
    [2, { id: 2, name: 'Beta' }],
  ]),
  items: new Map([
    [100, { id: 100, name: 'Lame', consumable: false, price: 2900, buildsInto: [], isBoots: false }],
    [2003, { id: 2003, name: 'Potion', consumable: true, price: 50, buildsInto: [], isBoots: false }],
  ]),
  excludedItemIds: new Set([2003]),
  spells: new Map([[4, { id: 4, name: 'Saut' }]]),
  perks: new Map([[8112, { id: 8112, name: 'Comète' }]]),
  perkStyles: new Map([[8100, { id: 8100, name: 'Domination' }]]),
};

const session = (over: Partial<ChampSelectSession> = {}): ChampSelectSession => ({
  localPlayerCellId: 0,
  myTeam: [
    { cellId: 0, championId: 1, assignedPosition: 'middle' },
    { cellId: 1, championId: 0, assignedPosition: 'jungle' },
  ],
  theirTeam: [{ cellId: 5, championId: 2, assignedPosition: '' }],
  ...over,
});

const history: PastGame[] = Array.from({ length: 6 }, (_, i) => ({
  championId: 1,
  win: i < 4,
  items: [100, 2003, 0],
  kills: i,
  deaths: 1,
  assists: 0,
  gameCreation: i,
}));

describe('localChampionId', () => {
  it('trouve le champion du joueur local via son cellId', () => {
    expect(localChampionId(session())).toBe(1);
  });

  it('renvoie 0 tant que rien n’est verrouillé', () => {
    expect(localChampionId(session({ localPlayerCellId: 1 }))).toBe(0);
  });
});

describe('buildChampSelectPayload', () => {
  it('résout les noms de champions des deux équipes', () => {
    const p = buildChampSelectPayload(session(), catalog, history);
    expect(p.myChampion).toBe('Alpha');
    expect(p.allies[0]).toMatchObject({ champion: 'Alpha', position: 'Milieu', isMe: true });
    expect(p.enemies[0]!.champion).toBe('Beta');
  });

  it('affiche « Aucun » pour un allié qui n’a pas encore choisi', () => {
    expect(buildChampSelectPayload(session(), catalog, history).allies[1]!.champion).toBe('Aucun');
  });

  it('ne propose pas de build avant le verrouillage', () => {
    const p = buildChampSelectPayload(session({ localPlayerCellId: 1 }), catalog, history);
    expect(p.myChampion).toBeNull();
    expect(p.build).toBeNull();
  });

  it('exclut les consommables du build proposé', () => {
    const build = buildChampSelectPayload(session(), catalog, history).build!;
    expect(build.coreItems.map((i) => i.name)).toEqual(['Lame']);
  });

  it('publie le taux de victoire une fois l’échantillon suffisant', () => {
    const build = buildChampSelectPayload(session(), catalog, history).build!;
    expect(build.games).toBe(6);
    expect(build.winRate).toBeCloseTo(4 / 6);
    expect(build.lowSample).toBe(false);
  });

  it('dégrade proprement sans catalogue', () => {
    // Le catalogue est chargé en asynchrone : la sélection peut démarrer avant.
    const p = buildChampSelectPayload(session(), null, history);
    expect(p.myChampion).toBe('#1');
  });
});

describe('icônes du draft', () => {
  it('fournit une icône par champion verrouillé', () => {
    const p = buildChampSelectPayload(session(), catalog, history);
    expect(p.myChampionIcon).toBe('laneform-icon://champion/1');
    expect(p.allies[0]!.icon).toBe('laneform-icon://champion/1');
    expect(p.enemies[0]!.icon).toBe('laneform-icon://champion/2');
  });

  it('n’en fournit pas tant que rien n’est verrouillé', () => {
    // Une vignette pour « Aucun » afficherait un cadre vide sur chaque ligne.
    expect(buildChampSelectPayload(session(), catalog, history).allies[1]!.icon).toBeNull();
    expect(buildChampSelectPayload(session({ localPlayerCellId: 1 }), catalog, history).myChampionIcon)
      .toBeNull();
  });

  it('fournit une icône par objet proposé', () => {
    const build = buildChampSelectPayload(session(), catalog, history).build!;
    expect(build.coreItems[0]!.icon).toBe('laneform-icon://item/100');
  });
});
