import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisRateLimiter } from '../src/limiter.ts';

// Teste le script Lua contre un vrai Redis : l'atomicité multi-buckets est
// précisément ce qu'un mock ne peut pas valider. Sans REDIS_URL, on saute.
const url = process.env.REDIS_URL;
const d = url ? describe : describe.skip;

d('RedisRateLimiter', () => {
  const redis = new Redis(url ?? 'redis://localhost:6379', { lazyConnect: true });
  const limiter = new RedisRateLimiter(redis, 'test-rl');

  beforeEach(async () => {
    const keys = await redis.keys('test-rl:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('autorise jusqu’au plafond puis refuse avec une attente', async () => {
    const buckets = [{ scope: 'app', limit: { count: 3, windowSeconds: 10 } }];
    for (let i = 0; i < 3; i++) {
      expect(await limiter.acquire(buckets)).toEqual({ ok: true });
    }
    const denied = await limiter.acquire(buckets);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('n’incrémente aucun bucket quand un seul refuse', async () => {
    const tight = { scope: 'a', limit: { count: 1, windowSeconds: 10 } };
    const loose = { scope: 'b', limit: { count: 100, windowSeconds: 10 } };

    expect(await limiter.acquire([tight, loose])).toEqual({ ok: true });
    expect((await limiter.acquire([tight, loose])).ok).toBe(false);

    // `b` ne doit valoir que 1 : le refus sur `a` ne doit pas avoir consommé
    // de quota sur `b`, sinon la fuite ne se résorbe qu'à l'expiration.
    expect(await redis.get('test-rl:b:10')).toBe('1');
  });

  it('remonte le compteur sur l’observation Riot, jamais le contraire', async () => {
    const buckets = [{ scope: 'app', limit: { count: 10, windowSeconds: 60 } }];
    await limiter.acquire(buckets);

    await limiter.sync([{ scope: 'app', count: 8, windowSeconds: 60 }]);
    expect(await redis.get('test-rl:app:60')).toBe('8');

    // Une observation plus basse est ignorée : nos requêtes en vol ne sont pas
    // encore comptées par Riot, rabaisser rouvrirait du quota inexistant.
    await limiter.sync([{ scope: 'app', count: 2, windowSeconds: 60 }]);
    expect(await redis.get('test-rl:app:60')).toBe('8');
  });

  it('expire la fenêtre et laisse repasser les appels', async () => {
    const buckets = [{ scope: 'app', limit: { count: 1, windowSeconds: 1 } }];
    expect(await limiter.acquire(buckets)).toEqual({ ok: true });
    expect((await limiter.acquire(buckets)).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await limiter.acquire(buckets)).toEqual({ ok: true });
  });

  it('ouvre et purge le coupe-circuit', async () => {
    expect(await limiter.breakerRemainingMs()).toBe(0);
    await limiter.openBreaker(500);
    expect(await limiter.breakerRemainingMs()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 600));
    expect(await limiter.breakerRemainingMs()).toBe(0);
  });
});
