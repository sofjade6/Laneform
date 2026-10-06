import { describe, expect, it } from 'vitest';
import {
  allObjectiveTimers,
  formatClock,
  objectiveTimer,
  OBJECTIVES,
  type ObjectiveConfig,
} from '../src/objectives.ts';

const DRAGON = OBJECTIVES.find((o) => o.kind === 'DRAGON')!;
const BARON = OBJECTIVES.find((o) => o.kind === 'BARON')!;
const GRUBS = OBJECTIVES.find((o) => o.kind === 'VOID_GRUBS')!;

const kill = (name: string, at: number) => ({ EventName: name, EventTime: at });

describe('avant la première apparition', () => {
  // Le bug de la v1 : tout était déclaré disponible dès 0:00. Un objectif
  // jamais tué n'est pas pour autant présent sur la carte.
  it('décompte vers l’apparition initiale au lieu d’annoncer « disponible »', () => {
    const t = objectiveTimer(DRAGON, [], 0);
    expect(t.status).toBe('PENDING');
    expect(t.secondsUntilNext).toBe(DRAGON.firstSpawnSeconds);
  });

  it('décompte correctement en cours de route', () => {
    const t = objectiveTimer(BARON, [], 900);
    expect(t.status).toBe('PENDING');
    expect(t.secondsUntilNext).toBe(BARON.firstSpawnSeconds - 900);
  });

  it('devient disponible pile à l’apparition', () => {
    expect(objectiveTimer(DRAGON, [], DRAGON.firstSpawnSeconds).status).toBe('AVAILABLE');
  });
});

describe('après un kill', () => {
  it('décompte la réapparition', () => {
    const t = objectiveTimer(DRAGON, [kill('DragonKill', 600)], 700);
    expect(t.status).toBe('RESPAWNING');
    expect(t.secondsUntilNext).toBe(DRAGON.respawnSeconds! - 100);
  });

  it('repart du kill le plus RÉCENT, pas du premier', () => {
    const events = [kill('DragonKill', 600), kill('DragonKill', 1200)];
    expect(objectiveTimer(DRAGON, events, 1300).lastKilledAt).toBe(1200);
  });

  it('redevient disponible une fois la durée écoulée', () => {
    const t = objectiveTimer(BARON, [kill('BaronKill', 1300)], 1300 + BARON.respawnSeconds!);
    expect(t.status).toBe('AVAILABLE');
    expect(t.secondsUntilNext).toBe(0);
  });

  it('ne dépasse jamais la durée de réapparition si l’horloge recule', () => {
    const t = objectiveTimer(BARON, [kill('BaronKill', 1800)], 1700);
    expect(t.secondsUntilNext).toBeLessThanOrEqual(BARON.respawnSeconds!);
    expect(t.secondsUntilNext).toBeGreaterThanOrEqual(0);
  });

  it('ignore les événements d’un autre objectif', () => {
    expect(objectiveTimer(BARON, [kill('DragonKill', 600)], 1300).lastKilledAt).toBeNull();
  });
});

describe('fenêtre de disparition (larves du Néant)', () => {
  it('se ferme définitivement passé l’échéance', () => {
    const t = objectiveTimer(GRUBS, [], GRUBS.despawnSeconds!);
    expect(t.status).toBe('GONE');
  });

  it('n’annonce pas une réapparition qui tomberait après la fermeture', () => {
    // Tuées juste avant la fin de fenêtre : la réapparition n'aura pas lieu,
    // afficher un décompte induirait le joueur en erreur.
    const killedAt = GRUBS.despawnSeconds! - 10;
    const t = objectiveTimer(GRUBS, [kill(GRUBS.eventName, killedAt)], killedAt + 5);
    expect(t.status).toBe('GONE');
  });

  it('annonce bien la réapparition quand elle tient dans la fenêtre', () => {
    const t = objectiveTimer(GRUBS, [kill(GRUBS.eventName, GRUBS.firstSpawnSeconds)], 400);
    expect(t.status).toBe('RESPAWNING');
  });
});

describe('objectif sans réapparition', () => {
  it('passe à GONE une fois tué', () => {
    const unique: ObjectiveConfig = {
      kind: 'BARON',
      eventName: 'TestKill',
      firstSpawnSeconds: 100,
      respawnSeconds: null,
    };
    expect(objectiveTimer(unique, [kill('TestKill', 200)], 300).status).toBe('GONE');
  });
});

describe('allObjectiveTimers', () => {
  it('couvre les trois objectifs configurés', () => {
    expect(allObjectiveTimers([], 0).map((t) => t.kind)).toEqual([
      'DRAGON',
      'BARON',
      'VOID_GRUBS',
    ]);
  });
});

describe('formatClock', () => {
  it('formate en MM:SS', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(600)).toBe('10:00');
  });

  it('borne les négatifs à zéro', () => {
    expect(formatClock(-30)).toBe('0:00');
  });
});
