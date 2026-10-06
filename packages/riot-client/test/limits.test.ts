import { describe, expect, it } from 'vitest';
import {
  applyHeadroom,
  formatRateLimits,
  parseRateLimits,
  parseRetryAfterMs,
} from '../src/limits.ts';

describe('parseRateLimits', () => {
  it('parse le format Riot multi-fenêtres', () => {
    expect(parseRateLimits('20:1,100:120')).toEqual([
      { count: 20, windowSeconds: 1 },
      { count: 100, windowSeconds: 120 },
    ]);
  });

  it('tolère espaces et en-tête absent', () => {
    expect(parseRateLimits(' 500:10 , 30000:600 ')).toHaveLength(2);
    expect(parseRateLimits(null)).toEqual([]);
    expect(parseRateLimits('')).toEqual([]);
  });

  it('ignore les segments malformés au lieu de faire échouer l’appel', () => {
    expect(parseRateLimits('20:1,garbage,0:5,100:120')).toEqual([
      { count: 20, windowSeconds: 1 },
      { count: 100, windowSeconds: 120 },
    ]);
  });

  it('fait un aller-retour avec formatRateLimits', () => {
    expect(formatRateLimits(parseRateLimits('20:1,100:120'))).toBe('20:1,100:120');
  });
});

describe('applyHeadroom', () => {
  it('réduit les plafonds et arrondit vers le bas', () => {
    expect(applyHeadroom([{ count: 20, windowSeconds: 1 }], 0.9)).toEqual([
      { count: 18, windowSeconds: 1 },
    ]);
  });

  it('ne descend jamais sous 1, sinon aucun appel ne passerait', () => {
    expect(applyHeadroom([{ count: 2, windowSeconds: 1 }], 0.1)[0]!.count).toBe(1);
  });

  it('borne le facteur à 1 : on ne dépasse pas le quota annoncé', () => {
    expect(applyHeadroom([{ count: 20, windowSeconds: 1 }], 5)[0]!.count).toBe(20);
  });
});

describe('parseRetryAfterMs', () => {
  // Retry-After est en SECONDES chez Riot. Le lire comme des ms produit une
  // attente 1000x trop courte, donc une rafale de 429 et une clé en danger.
  it('convertit les secondes en millisecondes', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('retombe sur la valeur par défaut si l’en-tête est absent ou invalide', () => {
    expect(parseRetryAfterMs(null)).toBe(1000);
    expect(parseRetryAfterMs('soon')).toBe(1000);
  });
});
