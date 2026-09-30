import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Limiter } from '../src/limiter.js';
import { naiveCheck } from '../src/naive.js';
import { adminRedis, rules, testRedis } from './helpers.js';

// 1000 requests at a limit of 100, spread over 5 separate connections to
// stand in for 5 app instances.
const INSTANCES = 5;
const REQUESTS = 1000;

let conns: Redis[];
let admin: Redis;

beforeAll(async () => {
  conns = await Promise.all(Array.from({ length: INSTANCES }, testRedis));
  admin = await adminRedis();
});
beforeEach(() => admin.flushdb());
afterAll(() => {
  conns.forEach((c) => c.disconnect());
  admin.disconnect();
});

async function fire(fn: (i: number) => Promise<boolean>) {
  const results = await Promise.all(Array.from({ length: REQUESTS }, (_, i) => fn(i)));
  return results.filter(Boolean).length;
}

describe('1000 concurrent requests, limit 100', () => {
  it('sliding window admits exactly 100', async () => {
    const limiters = conns.map((c) => new Limiter(c, rules));
    const admitted = await fire(async (i) => (await limiters[i % INSTANCES].check('sw100', 'hot')).allowed);
    expect(admitted).toBe(100);
  });

  it('token bucket admits exactly 100', async () => {
    const limiters = conns.map((c) => new Limiter(c, rules));
    const admitted = await fire(async (i) => (await limiters[i % INSTANCES].check('tb100', 'hot')).allowed);
    expect(admitted).toBe(100);
  });

  it('naive GET-then-INCR over-admits', async () => {
    const admitted = await fire((i) => naiveCheck(conns[i % INSTANCES], 'hot', 100, 60));
    console.log(`naive admitted ${admitted}/${REQUESTS} with a limit of 100`);
    expect(admitted).toBeGreaterThan(100);
  });
});
