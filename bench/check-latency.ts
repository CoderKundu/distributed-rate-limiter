// Times limiter.check() in-process, no HTTP in the way. This is the number
// that matters if you embed the middleware in your own service: one redis
// round trip + script execution.
//
//   REDIS_URL=redis://localhost:6379 npx tsx bench/check-latency.ts

import { parseRules } from '../src/config.js';
import { Limiter } from '../src/limiter.js';
import { connect, waitForReady } from '../src/redis.js';
import { preloadScripts } from '../src/scripts.js';

const N = Number(process.env.N ?? 20000);

const redis = connect();
await waitForReady(redis);
await preloadScripts(redis);

const limiter = new Limiter(
  redis,
  parseRules(`
rules:
  tb: { algorithm: token_bucket,   capacity: 1000000000, refill_per_sec: 1000000 }
  sw: { algorithm: sliding_window, limit: 100,         window_sec: 60 }
`),
);

function pct(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

for (const rule of ['tb', 'sw']) {
  // warm up
  for (let i = 0; i < 1000; i++) await limiter.check(rule, `warm${i % 100}`);

  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await limiter.check(rule, `k${i % 1000}`);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(
    `${rule}: n=${N} p50=${pct(times, 50).toFixed(3)}ms p99=${pct(times, 99).toFixed(3)}ms max=${times.at(-1)!.toFixed(3)}ms`,
  );
}

const leftovers = [...(await redis.keys('rl:tb:*')), ...(await redis.keys('rl:sw:*'))];
if (leftovers.length) await redis.del(...leftovers);
redis.disconnect();
