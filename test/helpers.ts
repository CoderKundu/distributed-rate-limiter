import { Redis } from 'ioredis';
import { parseRules } from '../src/config.js';
import { connect, waitForReady } from '../src/redis.js';

// db 15 so running the tests against a dev redis doesn't clobber anything
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export async function testRedis() {
  const r = connect(TEST_REDIS_URL);
  r.on('error', () => {});
  await waitForReady(r);
  return r;
}

// plain client with no timeout, for poking at redis from the test itself
export async function adminRedis() {
  const r = new Redis(TEST_REDIS_URL);
  await r.ping();
  return r;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const rules = parseRules(`
rules:
  tb:     { algorithm: token_bucket,   capacity: 5,   refill_per_sec: 10 }
  sw:     { algorithm: sliding_window, limit: 3,      window_sec: 0.3 }
  tb100:  { algorithm: token_bucket,   capacity: 100, refill_per_sec: 0.001 }
  sw100:  { algorithm: sliding_window, limit: 100,    window_sec: 60 }
  open:   { algorithm: token_bucket,   capacity: 10,  refill_per_sec: 1, on_redis_error: open }
  closed: { algorithm: sliding_window, limit: 10,     window_sec: 60, on_redis_error: closed }
  api-default: { algorithm: token_bucket, capacity: 2, refill_per_sec: 0.5 }
`);
