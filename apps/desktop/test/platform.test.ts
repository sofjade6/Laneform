import { describe, expect, it } from 'vitest';
import { normalizePlatform } from '../src/main/lcu/platform.ts';

describe('normalizePlatform', () => {
  it('accepte une plateforme déjà au bon format', () => {
    expect(normalizePlatform('euw1')).toBe('euw1');
    expect(normalizePlatform('EUW1')).toBe('euw1');
  });

  it('traduit la région affichée par le client', () => {
    // Le client dit « EUW », l'API attend « euw1 » : confondre les deux
    // empêche le collecteur de démarrer, sans message explicite.
    expect(normalizePlatform('EUW')).toBe('euw1');
    expect(normalizePlatform('EUNE')).toBe('eun1');
    expect(normalizePlatform('NA')).toBe('na1');
    expect(normalizePlatform('KR')).toBe('kr');
  });

  it('tolère espaces et casse', () => {
    expect(normalizePlatform('  euw  ')).toBe('euw1');
  });

  it('refuse une valeur vide ou inconnue', () => {
    expect(normalizePlatform('')).toBeNull();
    expect(normalizePlatform('   ')).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
    expect(normalizePlatform(undefined)).toBeNull();
    expect(normalizePlatform('MARS')).toBeNull();
  });
});
