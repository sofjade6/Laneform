export class RiotApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `Riot API ${status} on ${method} (${url})`);
    this.name = 'RiotApiError';
  }
}

/**
 * 429 encaissé. Ne jamais retenter sans respecter `retryAfterMs` : des 429 en
 * rafale sont le premier motif de révocation d'une clé de production.
 */
export class RateLimitedError extends RiotApiError {
  constructor(method: string, url: string, readonly retryAfterMs: number) {
    super(429, method, url, `Rate limited on ${method}, retry in ${retryAfterMs}ms`);
    this.name = 'RateLimitedError';
  }
}

/** 404 : réponse légitime (joueur inconnu, pas de partie en cours). Jamais retentée. */
export class NotFoundError extends RiotApiError {
  constructor(method: string, url: string) {
    super(404, method, url);
    this.name = 'NotFoundError';
  }
}

/** Le budget de quota n'a pas pu être obtenu avant l'échéance du job. */
export class RateLimitTimeoutError extends Error {
  constructor(readonly method: string, readonly waitedMs: number) {
    super(`Could not acquire rate-limit slot for ${method} within ${waitedMs}ms`);
    this.name = 'RateLimitTimeoutError';
  }
}
