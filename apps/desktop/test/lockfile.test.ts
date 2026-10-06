import { describe, expect, it } from 'vitest';
import { basicAuthHeader, parseLockfile } from '../src/main/lcu/lockfile.ts';

describe('parseLockfile', () => {
  it('parse le format nom:pid:port:password:protocole', () => {
    expect(parseLockfile('LeagueClient:12345:54321:abcDEF123:https')).toEqual({
      processName: 'LeagueClient',
      pid: 12345,
      port: 54321,
      password: 'abcDEF123',
      protocol: 'https',
    });
  });

  it('tolère un retour à la ligne final', () => {
    expect(parseLockfile('LeagueClient:1:2:pw:https\n')?.port).toBe(2);
  });

  it('refuse un fichier tronqué plutôt que de produire des identifiants partiels', () => {
    // Le lockfile peut être lu pendant son écriture par le client.
    expect(parseLockfile('LeagueClient:12345:54321')).toBeNull();
    expect(parseLockfile('')).toBeNull();
  });

  it('refuse un port ou un pid non numérique', () => {
    expect(parseLockfile('LeagueClient:abc:54321:pw:https')).toBeNull();
    expect(parseLockfile('LeagueClient:1:xyz:pw:https')).toBeNull();
  });

  it('refuse un mot de passe vide', () => {
    expect(parseLockfile('LeagueClient:1:2::https')).toBeNull();
  });
});

describe('basicAuthHeader', () => {
  it('encode l’utilisateur fixe riot avec le mot de passe', () => {
    // Le LCU n'accepte que l'utilisateur « riot ».
    expect(basicAuthHeader('secret')).toBe(`Basic ${Buffer.from('riot:secret').toString('base64')}`);
  });
});
