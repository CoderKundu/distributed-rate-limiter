import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Limiter } from '../src/limiter.js';
import { adminRedis, rules, sleep, testRedis } from './helpers.js';

let redis: Redis;
let admin: Redis;
let limiter: Limiter;

beforeAll(async () => {
  redis = await testRedis();
  admin = await adminRedis();
  limiter = new Limiter(redis, rules);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => admin.flushdb());
afterAll(() => {
  redis.disconnect();
  admin.disconnect();
});

describe('redis stalls mid-test (CLIENT PAUSE)', () => {
  it('fail-open allows, fail-closed denies, both within the timeout', async () => {
    // sanity check it works before we break it
    expect((await limiter.check('open', 'k')).degraded).toBeUndefined();

    await admin.client('PAUSE', 500, 'ALL');

    const t0 = performance.now();
    const [open, closed] = await Promise.all([limiter.check('open', 'k'), limiter.check('closed', 'k')]);
    const elapsed = performance.now() - t0;

    expect(open).toMatchObject({ allowed: true, degraded: true });
    expect(closed).toMatchObject({ allowed: false, degraded: true, retryAfterMs: 1000 });
    // commandTimeout is 50ms, give it some slack for CI
    expect(elapsed).toBeLessThan(250);

    await sleep(550);
    expect((await limiter.check('closed', 'k')).degraded).toBeUndefined();
  });
});

describe('redis connection drops', () => {
  it('uses the failure mode while disconnected, recovers after reconnect', async () => {
    // kill our limiter's connection from the server side
    const id = await redis.client('ID');
    await admin.client('KILL', 'ID', String(id));
    await sleep(10);

    const open = await limiter.check('open', 'k');
    const closed = await limiter.check('closed', 'k');
    expect(open.degraded && open.allowed).toBe(true);
    expect(closed.degraded && !closed.allowed).toBe(true);

    // ioredis reconnects on its own
    await new Promise((r) => redis.once('ready', r));
    expect((await limiter.check('closed', 'k')).degraded).toBeUndefined();
  });
});

describe('redis is not there at all', () => {
  it('fails fast instead of hanging', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      commandTimeout: 50,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    dead.on('error', () => {});
    const l = new Limiter(dead, rules);

    const t0 = performance.now();
    expect((await l.check('open', 'k')).allowed).toBe(true);
    expect((await l.check('closed', 'k')).allowed).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
    dead.disconnect();
  });
});
