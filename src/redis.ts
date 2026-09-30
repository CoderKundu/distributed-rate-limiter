import { Redis } from 'ioredis';

export function connect(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  return new Redis(url, {
    // A rate limiter that waits on a slow redis is worse than no rate
    // limiter. Give up quickly and let the rule's failure mode decide.
    commandTimeout: Number(process.env.REDIS_TIMEOUT_MS ?? 50),
    // don't queue commands while disconnected, fail them straight away
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    // keep trying to reconnect in the background, capped at 2s between attempts
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
}

export function waitForReady(redis: Redis) {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise<void>((resolve) => redis.once('ready', () => resolve()));
}
