import { describe, expect, it } from 'vitest';
import { computeDerivedStats, LANE_DIFF_MINUTE } from '../src/derived.ts';
import { durationSeconds } from '../src/duration.ts';
import { match, participant, timeline } from './fixtures.ts';

const ME = 'puuid-me';
const OPP = 'puuid-opp';

function duel(over: { duration?: number } = {}) {
  const me = participant({
    puuid: ME,
    teamId: 100,
    teamPosition: 'MIDDLE',
    kills: 5,
    assists: 3,
    totalDamageDealtToChampions: 20_000,
    totalDamageTaken: 10_000,
    totalMinionsKilled: 180,
    neutralMinionsKilled: 20,
    visionScore: 40,
  });
  const ally = participant({ puuid: 'puuid-ally', teamId: 100, teamPosition: 'TOP', kills: 5 });
  const opp = participant({ puuid: OPP, teamId: 200, teamPosition: 'MIDDLE' });
  return match({
    gameDuration: over.duration ?? 1200, // 20 min
    gameEndTimestamp: 1_700_000_000_000,
    participants: [me, ally, opp],
  });
}

const tl = timeline({
  puuids: [ME, 'puuid-ally', OPP],
  minutes: 20,
  goldPerMinute: [400, 300, 350],
  csPerMinute: [8, 5, 6],
});

describe('computeDerivedStats', () => {
  it('calcule les métriques par minute', () => {
    const s = computeDerivedStats(duel(), tl, ME)!;
    expect(s.dpm).toBe(1000); // 20 000 / 20 min
    expect(s.dtpm).toBe(500);
    expect(s.csPerMin).toBe(10); // (180 + 20) / 20
    expect(s.visionPerMin).toBe(2);
  });

  it('calcule la participation aux kills sur le total de l’équipe', () => {
    const s = computeDerivedStats(duel(), tl, ME)!;
    expect(s.killParticipation).toBeCloseTo(8 / 10); // (5+3) / (5+5)
  });

  it('renvoie une KP nulle plutôt que 0 si l’équipe n’a aucun kill', () => {
    const me = participant({ puuid: ME, teamId: 100, kills: 0, assists: 0 });
    const opp = participant({ puuid: OPP, teamId: 200 });
    const m = match({ gameDuration: 600, gameEndTimestamp: 1, participants: [me, opp] });
    expect(computeDerivedStats(m, null, ME)!.killParticipation).toBeNull();
  });

  it('calcule les écarts de lane contre l’adversaire du même rôle', () => {
    const s = computeDerivedStats(duel(), tl, ME)!;
    expect(s.goldDiffAt14).toBe((400 - 350) * LANE_DIFF_MINUTE); // 700
    expect(s.csDiffAt14).toBe((8 - 6) * LANE_DIFF_MINUTE); // 28
  });

  it('renvoie des écarts nuls, pas 0, sans timeline', () => {
    const s = computeDerivedStats(duel(), null, ME)!;
    expect(s.goldDiffAt14).toBeNull();
    expect(s.csDiffAt14).toBeNull();
  });

  it('renvoie des écarts nuls quand teamPosition est absent', () => {
    const me = participant({ puuid: ME, teamId: 100, teamPosition: '' });
    const opp = participant({ puuid: OPP, teamId: 200, teamPosition: '' });
    const m = match({ gameDuration: 1200, gameEndTimestamp: 1, participants: [me, opp] });
    expect(computeDerivedStats(m, tl, ME)!.goldDiffAt14).toBeNull();
  });

  it('renvoie des écarts nuls si la partie finit avant la minute de référence', () => {
    const short = timeline({
      puuids: [ME, 'puuid-ally', OPP],
      minutes: 8,
      goldPerMinute: [400, 300, 350],
      csPerMinute: [8, 5, 6],
    });
    // frameAtMinute retient la dernière frame <= 14 min, ici 8 min : on veut
    // bien une valeur, mais mesurée à 8 min — d'où l'écart réduit.
    const s = computeDerivedStats(duel({ duration: 480 }), short, ME)!;
    expect(s.goldDiffAt14).toBe((400 - 350) * 8);
  });

  it('marque les remakes', () => {
    expect(computeDerivedStats(duel({ duration: 240 }), tl, ME)!.isRemake).toBe(true);
    expect(computeDerivedStats(duel({ duration: 1200 }), tl, ME)!.isRemake).toBe(false);
  });

  it('renvoie null si le joueur n’est pas dans la partie', () => {
    expect(computeDerivedStats(duel(), tl, 'inconnu')).toBeNull();
  });

  it('ne produit pas d’Infinity sur une durée nulle', () => {
    const me = participant({ puuid: ME, totalDamageDealtToChampions: 500 });
    const m = match({ gameDuration: 0, gameEndTimestamp: 1, participants: [me] });
    const s = computeDerivedStats(m, null, ME)!;
    expect(Number.isFinite(s.dpm)).toBe(true);
    expect(s.dpm).toBe(0);
  });
});

describe('durationSeconds', () => {
  // Discriminant : gameEndTimestamp n'existe qu'à partir du patch 11.20, patch
  // qui a aussi fait passer gameDuration des ms aux secondes.
  it('traite gameDuration comme des secondes quand gameEndTimestamp est présent', () => {
    const m = match({ gameDuration: 1800, gameEndTimestamp: 1, participants: [] });
    expect(durationSeconds(m)).toBe(1800);
  });

  it('traite gameDuration comme des millisecondes sur les parties pré-11.20', () => {
    const m = match({ gameDuration: 1_800_000, participants: [] });
    expect(durationSeconds(m)).toBe(1800);
  });
});
