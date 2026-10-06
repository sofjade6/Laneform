import { describe, expect, it } from 'vitest';
import type { ParticipantDto } from '@laneform/riot-client';
import { parseRuneKey, runeKey, runeSetup, spellPair, spellPairKey } from '../src/loadout.ts';

function participant(extra: Record<string, unknown>): ParticipantDto {
  return {
    puuid: 'p', championId: 1, championName: 'X', teamId: 100, teamPosition: 'MIDDLE',
    win: true, kills: 0, deaths: 0, assists: 0, goldEarned: 0,
    totalMinionsKilled: 0, neutralMinionsKilled: 0,
    totalDamageDealtToChampions: 0, totalDamageTaken: 0, visionScore: 0,
    ...extra,
  };
}

const perks = (primary: number, keystone: number, sub: number) => ({
  styles: [
    { description: 'primaryStyle', style: primary, selections: [{ perk: keystone }, { perk: 999 }] },
    { description: 'subStyle', style: sub, selections: [{ perk: 888 }] },
  ],
});

describe('spellPair', () => {
  it('trie la paire pour une clé stable', () => {
    // Deux joueurs avec les mêmes sorts dans un ordre différent font le même
    // choix : sans tri, ils compteraient dans deux entrées distinctes.
    expect(spellPair(participant({ summoner1Id: 14, summoner2Id: 4 }))).toEqual([4, 14]);
    expect(spellPair(participant({ summoner1Id: 4, summoner2Id: 14 }))).toEqual([4, 14]);
  });

  it('renvoie null si un sort manque', () => {
    expect(spellPair(participant({ summoner1Id: 4 }))).toBeNull();
    expect(spellPair(participant({ summoner1Id: 0, summoner2Id: 14 }))).toBeNull();
  });

  it('produit une clé lisible', () => {
    expect(spellPairKey([4, 14])).toBe('4+14');
  });
});

describe('runeSetup', () => {
  it('extrait rune clé et branches', () => {
    const setup = runeSetup(participant({ perks: perks(8100, 8112, 8200) }))!;
    expect(setup).toEqual({ primaryStyleId: 8100, keystoneId: 8112, subStyleId: 8200 });
  });

  it('renvoie null sur une page incomplète', () => {
    // Une entrée à zéro remonterait en tête des classements.
    expect(runeSetup(participant({ perks: { styles: [] } }))).toBeNull();
    expect(runeSetup(participant({}))).toBeNull();
    expect(
      runeSetup(participant({ perks: { styles: [{ description: 'primaryStyle', style: 8100, selections: [] }] } })),
    ).toBeNull();
  });

  it('résiste à des données inattendues', () => {
    expect(runeSetup(participant({ perks: 'nope' }))).toBeNull();
    expect(runeSetup(participant({ perks: { styles: 'nope' } }))).toBeNull();
  });
});

describe('runeKey', () => {
  it('fait un aller-retour', () => {
    const setup = { primaryStyleId: 8100, keystoneId: 8112, subStyleId: 8200 };
    expect(parseRuneKey(runeKey(setup))).toEqual(setup);
  });

  it('refuse une clé malformée', () => {
    expect(parseRuneKey('8100:8112')).toBeNull();
    expect(parseRuneKey('a:b:c')).toBeNull();
  });
});
