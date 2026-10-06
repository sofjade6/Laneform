/**
 * Routing Riot à deux niveaux.
 *
 * Depuis la migration vers les Riot ID, deux espaces coexistent :
 *  - PLATEFORME (euw1, na1, kr…)  -> SUMMONER-V4, LEAGUE-V4, SPECTATOR-V5
 *  - RÉGION     (europe, americas…) -> ACCOUNT-V1, MATCH-V5
 *
 * Confondre les deux est la source de bug n°1 de ce type de projet : l'appel
 * part, renvoie 404, et rien n'indique que c'est le host qui était faux.
 * D'où : aucune fonction du repo n'accepte un host sous forme de string brut,
 * uniquement les types `Platform` / `RegionalRoute` définis ici.
 */

export const PLATFORMS = [
  'br1', 'eun1', 'euw1', 'jp1', 'kr', 'la1', 'la2',
  'me1', 'na1', 'oc1', 'ru', 'sg2', 'tr1', 'tw2', 'vn2',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const REGIONAL_ROUTES = ['americas', 'asia', 'europe', 'sea'] as const;
export type RegionalRoute = (typeof REGIONAL_ROUTES)[number];

const PLATFORM_TO_REGION: Record<Platform, RegionalRoute> = {
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  jp1: 'asia',
  kr: 'asia',
  tw2: 'asia',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  ru: 'europe',
  tr1: 'europe',
  oc1: 'sea',
  sg2: 'sea',
  vn2: 'sea',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export function regionOf(platform: Platform): RegionalRoute {
  return PLATFORM_TO_REGION[platform];
}

/** Host d'un endpoint routé par plateforme (SUMMONER, LEAGUE, SPECTATOR). */
export function platformHost(platform: Platform): string {
  return `https://${platform}.api.riotgames.com`;
}

/** Host d'un endpoint routé par région (ACCOUNT, MATCH). */
export function regionalHost(platform: Platform): string {
  return `https://${regionOf(platform)}.api.riotgames.com`;
}
