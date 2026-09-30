import type { Redis } from 'ioredis';

// The "obvious" implementation, kept around only so the benchmark has
// something to compare against. It's broken on purpose: between the GET and
// the INCR any number of other requests can read the same count, so under
// concurrency it lets through way more than `limit`. Don't use it.
export async function naiveCheck(redis: Redis, key: string, limit: number, windowSec: number) {
  const k = `naive:${key}`;
  const count = Number((await redis.get(k)) ?? 0);
  if (count >= limit) return false;

  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return true;
}
