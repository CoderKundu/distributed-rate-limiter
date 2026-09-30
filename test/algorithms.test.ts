import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Limiter } from '../src/limiter.js';
import { adminRedis, rules, sleep, testRedis } from './helpers.js';

let redis: Redis;
let admin: Redis;
let limiter: Limiter;

beforeAll(async () => {
  redis = await testRedis();
  admin = await adminRedis();
  limiter = new Limiter(redis, rules);
});
beforeEach(() => admin.flushdb());
afterAll(async () => {
  redis.disconnect();
  admin.disconnect();
});

async function drain(rule: string, key: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await limiter.check(rule, key));
  return out;
}

describe('token bucket', () => {
  // capacity 5, 10 tokens/sec => one token every 100ms

  it('allows a burst up to capacity then denies', async () => {
    const results = await drain('tb', 'k', 6);
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results.map((r) => r.remaining).slice(0, 5)).toEqual([4, 3, 2, 1, 0]);
    expect(results[5].allowed).toBe(false);
  });

  it('retryAfter is the time until the next whole token', async () => {
    await drain('tb', 'k', 5);
    const denied = await limiter.check('tb', 'k');
    expect(denied.allowed).toBe(false);
    // a sliver of a token may have refilled between calls, so <= not ==
    expect(denied.retryAfterMs).toBeGreaterThan(80);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(100);
  });

  it('refills at the configured rate', async () => {
    await drain('tb', 'k', 5);
    await sleep(250); // ~2.5 tokens
    const after = await drain('tb', 'k', 3);
    expect(after.map((r) => r.allowed)).toEqual([true, true, false]);
  });

  it('never refills past capacity', async () => {
    await limiter.check('tb', 'k');
    await sleep(1000); // would be 10 tokens if uncapped
    const results = await drain('tb', 'k', 6);
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('sets a ttl so idle buckets go away', async () => {
    await limiter.check('tb', 'k');
    const ttl = await admin.pttl('rl:tb:k');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(500); // capacity / rate
  });

  it('keys are independent', async () => {
    await drain('tb', 'a', 5);
    expect((await limiter.check('tb', 'a')).allowed).toBe(false);
    expect((await limiter.check('tb', 'b')).allowed).toBe(true);
  });
});

describe('sliding window', () => {
  // 3 per 300ms

  it('allows exactly `limit` inside the window', async () => {
    const results = await drain('sw', 'k', 4);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('retryAfter points at when the oldest hit expires', async () => {
    await drain('sw', 'k', 3);
    await sleep(100);
    const denied = await limiter.check('sw', 'k');
    expect(denied.retryAfterMs).toBeGreaterThan(150);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(200);
  });

  it('old hits fall out of the window', async () => {
    await drain('sw', 'k', 3);
    await sleep(320);
    expect((await limiter.check('sw', 'k')).allowed).toBe(true);
  });

  it('is actually sliding, not fixed', async () => {
    await limiter.check('sw', 'k'); // t=0
    await sleep(150);
    await drain('sw', 'k', 2); // t=150, window full
    await sleep(170);
    // t=320: the first hit is gone but the other two aren't
    const r = await drain('sw', 'k', 2);
    expect(r.map((x) => x.allowed)).toEqual([true, false]);
  });

  it('denied requests are not recorded', async () => {
    await drain('sw', 'k', 10);
    expect(await admin.zcard('rl:sw:k')).toBe(3);
  });
});

describe('script cache', () => {
  it('recovers after SCRIPT FLUSH', async () => {
    await admin.script('FLUSH');
    const r = await limiter.check('tb', 'k');
    expect(r.allowed).toBe(true);
  });
});
