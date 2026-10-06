import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../src/limiter.ts';

/** Horloge contrôlée : les fenêtres se testent sans attendre réellement. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('MemoryRateLimiter', () => {
  it('autorise jusqu’au plafond puis refuse avec une attente', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    const buckets = [{ scope: 'app', limit: { count: 3, windowSeconds: 10 } }];

    for (let i = 0; i < 3; i++) {
      expect(await limiter.acquire(buckets)).toEqual({ ok: true });
    }
    const denied = await limiter.acquire(buckets);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterMs).toBe(10_000);
  });

  it('n’incrémente aucun bucket quand un seul refuse', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    const tight = { scope: 'a', limit: { count: 1, windowSeconds: 10 } };
    const loose = { scope: 'b', limit: { count: 100, windowSeconds: 10 } };

    expect(await limiter.acquire([tight, loose])).toEqual({ ok: true });
    expect((await limiter.acquire([tight, loose])).ok).toBe(false);

    // `b` ne doit avoir consommé qu'un jeton : le refus sur `a` ne doit rien
    // lui prélever, sinon la fuite dure jusqu'à l'expiration de la fenêtre.
    const onlyLoose = [{ scope: 'b', limit: { count: 2, windowSeconds: 10 } }];
    expect(await limiter.acquire(onlyLoose)).toEqual({ ok: true });
    expect((await limiter.acquire(onlyLoose)).ok).toBe(false);
  });

  it('laisse repasser les appels à l’expiration de la fenêtre', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    const buckets = [{ scope: 'app', limit: { count: 1, windowSeconds: 1 } }];

    expect(await limiter.acquire(buckets)).toEqual({ ok: true });
    expect((await limiter.acquire(buckets)).ok).toBe(false);
    c.advance(1001);
    expect(await limiter.acquire(buckets)).toEqual({ ok: true });
  });

  it('remonte le compteur sur l’observation Riot, jamais le contraire', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    const buckets = [{ scope: 'app', limit: { count: 10, windowSeconds: 60 } }];
    await limiter.acquire(buckets);

    await limiter.sync([{ scope: 'app', count: 9, windowSeconds: 60 }]);
    // Compteur à 9 sur un plafond de 10 : un seul appel doit encore passer.
    expect(await limiter.acquire(buckets)).toEqual({ ok: true });
    expect((await limiter.acquire(buckets)).ok).toBe(false);
  });

  it('ignore une observation inférieure au compteur local', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    const buckets = [{ scope: 'app', limit: { count: 2, windowSeconds: 60 } }];
    await limiter.acquire(buckets);
    await limiter.acquire(buckets);

    await limiter.sync([{ scope: 'app', count: 0, windowSeconds: 60 }]);
    expect((await limiter.acquire(buckets)).ok).toBe(false);
  });

  it('ouvre puis purge le coupe-circuit', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);

    expect(await limiter.breakerRemainingMs()).toBe(0);
    await limiter.openBreaker(500);
    expect(await limiter.breakerRemainingMs()).toBe(500);
    c.advance(600);
    expect(await limiter.breakerRemainingMs()).toBe(0);
  });

  it('ne raccourcit jamais un coupe-circuit déjà ouvert', async () => {
    const c = clock();
    const limiter = new MemoryRateLimiter(c.now);
    await limiter.openBreaker(5000);
    await limiter.openBreaker(100);
    expect(await limiter.breakerRemainingMs()).toBe(5000);
  });
});
