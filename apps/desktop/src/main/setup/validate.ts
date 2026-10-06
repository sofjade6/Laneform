import { request } from 'undici';

/**
 * Vérifie une clé auprès de l'API Riot avant de l'enregistrer.
 *
 * Astuce : on interroge un Riot ID qui n'existe pas. Un **404** prouve que
 * l'authentification a réussi — la requête a été traitée, l'identité n'existe
 * simplement pas. Un 401 ou 403 signale une clé invalide ou expirée. Ça évite
 * d'avoir à connaître un compte réel pour tester.
 */
export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'rate-limited' | 'network' | 'unexpected' };

export async function validateApiKey(apiKey: string, route = 'europe'): Promise<KeyCheck> {
  const url = `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/laneform-check/0000`;

  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'X-Riot-Token': apiKey, accept: 'application/json' },
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    await res.body.dump();

    if (res.statusCode === 404 || res.statusCode === 200) return { ok: true };
    if (res.statusCode === 401 || res.statusCode === 403) return { ok: false, reason: 'invalid' };
    if (res.statusCode === 429) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: 'unexpected' };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export const CHECK_MESSAGE: Record<Exclude<KeyCheck, { ok: true }>['reason'], string> = {
  invalid: 'Clé refusée par Riot : vérifiez qu’elle est complète et toujours valide.',
  'rate-limited': 'Trop de requêtes pour le moment. Réessayez dans une minute.',
  network: 'Impossible de joindre Riot. Vérifiez votre connexion.',
  unexpected: 'Réponse inattendue de Riot. Réessayez.',
};
