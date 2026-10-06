import { describe, expect, it } from 'vitest';
import { computeLiveStats, csPerMin, kda, type LivePlayerLike } from '../src/live.ts';

const scores = (k: number, d: number, a: number, cs = 0) => ({
  kills: k, deaths: d, assists: a, creepScore: cs, wardScore: 0,
});

const player = (over: Partial<LivePlayerLike> & { championName: string }): LivePlayerLike => ({
  team: 'ORDER',
  scores: scores(0, 0, 0),
  level: 1,
  isDead: false,
  respawnTimer: 0,
  ...over,
});

describe('kda', () => {
  it('calcule le ratio', () => {
    expect(kda(scores(4, 2, 6))).toBe(5);
  });

  it('renvoie null sur 0 mort plutôt qu’un ratio infini', () => {
    expect(kda(scores(4, 0, 6))).toBeNull();
  });
});

describe('csPerMin', () => {
  it('calcule par minute', () => {
    expect(csPerMin(200, 1200)).toBeCloseTo(10);
  });

  it('renvoie 0 avant la première minute au lieu d’une valeur explosive', () => {
    // À 10 s de jeu, 5 CS donneraient 30 CS/min : un chiffre qui sursaute à
    // l'écran et n'informe pas.
    expect(csPerMin(5, 10)).toBe(0);
  });
});

describe('computeLiveStats', () => {
  it('calcule la participation sur les kills de la bonne équipe', () => {
    const players = [
      player({ championName: 'A', team: 'ORDER', scores: scores(3, 1, 2) }),
      player({ championName: 'B', team: 'ORDER', scores: scores(2, 0, 1) }),
      player({ championName: 'C', team: 'CHAOS', scores: scores(9, 4, 0) }),
    ];
    const out = computeLiveStats(players, 1200);
    expect(out[0]!.killParticipation).toBeCloseTo(5 / 5); // (3+2) / (3+2)
    expect(out[2]!.killParticipation).toBeCloseTo(9 / 9);
  });

  it('renvoie une participation nulle si l’équipe n’a aucun kill', () => {
    const players = [player({ championName: 'A', scores: scores(0, 3, 0) })];
    expect(computeLiveStats(players, 600)[0]!.killParticipation).toBeNull();
  });

  it('conserve l’état de mort et le timer de réapparition', () => {
    const players = [player({ championName: 'A', isDead: true, respawnTimer: 23.4 })];
    const out = computeLiveStats(players, 600)[0]!;
    expect(out.isDead).toBe(true);
    expect(out.respawnTimer).toBeCloseTo(23.4);
  });
});
