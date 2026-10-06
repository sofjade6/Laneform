/** Un plafond Riot : `count` requêtes par fenêtre de `windowSeconds`. */
export interface RateLimit {
  readonly count: number;
  readonly windowSeconds: number;
}

/**
 * Parse le format Riot `"20:1,100:120"`, utilisé aussi bien par les en-têtes
 * `X-App-Rate-Limit` / `X-Method-Rate-Limit` que par notre config.
 * Tolérant : un segment malformé est ignoré plutôt que de faire échouer l'appel.
 */
export function parseRateLimits(header: string | null | undefined): RateLimit[] {
  if (!header) return [];
  const out: RateLimit[] = [];
  for (const part of header.split(',')) {
    const [count, window] = part.trim().split(':');
    const c = Number(count);
    const w = Number(window);
    if (Number.isFinite(c) && Number.isFinite(w) && c > 0 && w > 0) {
      out.push({ count: c, windowSeconds: w });
    }
  }
  return out;
}

export function formatRateLimits(limits: readonly RateLimit[]): string {
  return limits.map((l) => `${l.count}:${l.windowSeconds}`).join(',');
}

/**
 * Applique une marge de sécurité. On ne consomme jamais 100 % du quota annoncé :
 * plusieurs workers partagent la clé et leurs compteurs dérivent entre deux
 * resynchronisations sur les en-têtes. Un plafond reste toujours >= 1.
 */
export function applyHeadroom(limits: readonly RateLimit[], headroom: number): RateLimit[] {
  const factor = Math.min(Math.max(headroom, 0.1), 1);
  return limits.map((l) => ({
    count: Math.max(1, Math.floor(l.count * factor)),
    windowSeconds: l.windowSeconds,
  }));
}

/**
 * `Retry-After` est en SECONDES dans les réponses Riot. L'oublier produit une
 * attente 1000x trop courte, donc une rafale de 429.
 */
export function parseRetryAfterMs(header: string | null | undefined, fallbackMs = 1000): number {
  // Number(null) et Number('') valent 0, pas NaN : sans ce garde, un en-tête
  // absent produirait une attente de 0 ms, donc un retry immédiat après un 429.
  if (header === null || header === undefined || header.trim() === '') return fallbackMs;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}
