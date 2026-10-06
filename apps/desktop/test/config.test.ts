import { describe, expect, it } from 'vitest';
import { looksLikeApiKey, mergeEnv, parseEnvFile } from '../src/main/config.ts';

describe('parseEnvFile', () => {
  it('lit les paires clé=valeur', () => {
    expect(parseEnvFile('A=1\nB=deux')).toEqual({ A: '1', B: 'deux' });
  });

  it('ignore commentaires et lignes vides', () => {
    expect(parseEnvFile('# commentaire\n\nA=1\n')).toEqual({ A: '1' });
  });

  it('retire les guillemets autour de la valeur', () => {
    expect(parseEnvFile('A="secret"')["A"]).toBe('secret');
    expect(parseEnvFile("A='secret'")["A"]).toBe('secret');
  });

  it('conserve les signes égal dans la valeur', () => {
    // Une clé d'API peut contenir des `=` : couper au premier seulement.
    expect(parseEnvFile('A=a=b=c')["A"]).toBe('a=b=c');
  });

  it('gère les fins de ligne Windows', () => {
    expect(parseEnvFile('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('ignore une ligne sans signe égal', () => {
    expect(parseEnvFile('nimportequoi\nA=1')).toEqual({ A: '1' });
  });
});

describe('mergeEnv', () => {
  it('met à jour une clé existante sans toucher au reste', () => {
    const out = mergeEnv('# note\nA=1\nRIOT_API_KEY=ancienne\nB=2\n', {
      RIOT_API_KEY: 'nouvelle',
    });
    expect(out).toBe('# note\nA=1\nRIOT_API_KEY=nouvelle\nB=2\n');
  });

  it('ajoute la clé quand elle est absente', () => {
    expect(mergeEnv('A=1\n', { RIOT_API_KEY: 'k' })).toBe('A=1\nRIOT_API_KEY=k\n');
  });

  it('part d’un fichier vide', () => {
    expect(mergeEnv('', { RIOT_API_KEY: 'k' })).toBe('RIOT_API_KEY=k\n');
  });

  it('préserve commentaires et lignes inconnues', () => {
    // Le fichier peut contenir des réglages que l'app ne connaît pas encore.
    const out = mergeEnv('# garder\nINCONNU=x\n', { RIOT_API_KEY: 'k' });
    expect(out).toContain('# garder');
    expect(out).toContain('INCONNU=x');
  });

  it('ne laisse qu’une seule fin de ligne', () => {
    expect(mergeEnv('A=1\n\n\n', { B: '2' })).toBe('A=1\nB=2\n');
  });
});

describe('looksLikeApiKey', () => {
  it('accepte une clé plausible', () => {
    expect(looksLikeApiKey('RGAPI-00000000-1111-2222-3333-444444444444')).toBe(true);
  });

  it('refuse les saisies manifestement ratées', () => {
    expect(looksLikeApiKey('')).toBe(false);
    expect(looksLikeApiKey('trop-court')).toBe(false);
    expect(looksLikeApiKey('RGAPI-0000 0000-1111-2222-3333-4444444444')).toBe(false);
  });
});
