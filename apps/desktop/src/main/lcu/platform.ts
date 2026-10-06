import { isPlatform, type Platform } from '@laneform/shared';
import type { LcuClient } from './client.ts';

/**
 * Détection de la plateforme du compte connecté.
 *
 * Plusieurs sources sont tentées : l'endpoint de configuration n'est pas
 * documenté, sa réponse a changé de forme entre versions du client, et il
 * renvoie parfois une chaîne vide. Sans plateforme, le collecteur ne démarre
 * pas du tout — c'est donc un point à rendre robuste plutôt qu'à supposer.
 */

/**
 * Région affichée par le client -> plateforme d'API.
 *
 * Les deux vocabulaires diffèrent : le client dit « EUW », l'API attend
 * « euw1 ».
 */
const REGION_TO_PLATFORM: Record<string, Platform> = {
  BR: 'br1',
  EUN: 'eun1',
  EUNE: 'eun1',
  EUW: 'euw1',
  JP: 'jp1',
  KR: 'kr',
  LAN: 'la1',
  LAS: 'la2',
  ME: 'me1',
  MENA: 'me1',
  NA: 'na1',
  OC: 'oc1',
  OCE: 'oc1',
  RU: 'ru',
  SG: 'sg2',
  TR: 'tr1',
  TW: 'tw2',
  VN: 'vn2',
};

/** Normalise « EUW1 », « euw1 » ou « EUW » vers une plateforme connue. */
export function normalizePlatform(raw: string | null | undefined): Platform | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value === '') return null;

  const lower = value.toLowerCase();
  if (isPlatform(lower)) return lower;

  return REGION_TO_PLATFORM[value.toUpperCase()] ?? null;
}

interface RegionLocale {
  region?: string;
  webRegion?: string;
}

export async function detectPlatform(
  client: LcuClient,
  log: (message: string) => void,
): Promise<Platform | null> {
  // 1. Endpoint de configuration : renvoie normalement « EUW1 ».
  const configured = await client
    .get<unknown>('/lol-platform-config/v1/namespaces/LoginDataPacket/platformId')
    .catch(() => null);
  log(`plateforme — platformId: ${JSON.stringify(configured)?.slice(0, 80) ?? 'null'}`);
  const fromConfig = normalizePlatform(typeof configured === 'string' ? configured : null);
  if (fromConfig) return fromConfig;

  // 2. Région du client : renvoie « EUW », qu'il faut traduire.
  const locale = await client.get<RegionLocale>('/riotclient/region-locale').catch(() => null);
  log(`plateforme — region-locale: ${JSON.stringify(locale)?.slice(0, 120) ?? 'null'}`);
  const fromLocale = normalizePlatform(locale?.region) ?? normalizePlatform(locale?.webRegion);
  if (fromLocale) return fromLocale;

  // 3. Session de connexion, en dernier recours.
  const session = await client
    .get<Record<string, unknown>>('/lol-login/v1/session')
    .catch(() => null);
  if (session) {
    const candidate =
      typeof session['platformId'] === 'string' ? (session['platformId'] as string) : null;
    log(`plateforme — login session platformId: ${candidate ?? 'absent'}`);
    const fromSession = normalizePlatform(candidate);
    if (fromSession) return fromSession;
  }

  return null;
}
