import { describe, expect, it, vi } from 'vitest';
import { mapLcuPhase, StateMachine } from '../src/main/state/machine.ts';

describe('mapLcuPhase', () => {
  it('traduit les phases du LCU', () => {
    expect(mapLcuPhase('ChampSelect')).toBe('CHAMP_SELECT');
    expect(mapLcuPhase('InProgress')).toBe('IN_GAME');
    expect(mapLcuPhase('EndOfGame')).toBe('POST_GAME');
  });

  it('traite la reconnexion comme une partie en cours', () => {
    expect(mapLcuPhase('Reconnect')).toBe('IN_GAME');
  });

  it('retombe sur IDLE pour une phase inconnue', () => {
    // Riot peut ajouter une phase à tout moment : le comportement doit rester
    // défini plutôt que de laisser l'overlay dans un état incohérent.
    expect(mapLcuPhase('UneNouvellePhase')).toBe('IDLE');
    expect(mapLcuPhase(null)).toBe('IDLE');
  });
});

describe('StateMachine', () => {
  it('émet au changement', () => {
    const m = new StateMachine();
    const spy = vi.fn();
    m.on('change', spy);
    m.update({ phase: 'IN_GAME' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('n’émet pas si rien ne change', () => {
    // Le poller tourne à 1 Hz : sans ce filtre, l'overlay se redessinerait
    // chaque seconde sans raison pendant la partie.
    const m = new StateMachine();
    m.update({ phase: 'IN_GAME' });
    const spy = vi.fn();
    m.on('change', spy);
    m.update({ phase: 'IN_GAME' });
    m.update({ phase: 'IN_GAME' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('émet quand le notice change seul', () => {
    const m = new StateMachine();
    m.update({ phase: 'IN_GAME' });
    const spy = vi.fn();
    m.on('change', spy);
    m.update({ notice: 'Passez en mode fenêtré' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
