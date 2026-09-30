// How much redis memory does one active key cost for each algorithm?
// Token bucket is a fixed-size hash. The sliding window log stores one
// sorted set entry per request in the window, so it depends on how full
// the window is.
//
//   REDIS_URL=redis://localhost:6379/14 npx tsx bench/memory.ts

import { parseRules } from '../src/config.js';
import { Limiter } from '../src/limiter.js';
import { connect, waitForReady } from '../src/redis.js';
import { preloadScripts } from '../src/scripts.js';

// we're filling redis as fast as we can here, the 100ms production timeout
// would just make checks fail open and skew the numbers
process.env.REDIS_TIMEOUT_MS ??= '30000';
const redis = connect();
await waitForReady(redis);
await preloadScripts(redis);
const SAMPLES = 200;

const rules = parseRules(`
rules:
  tb:     { algorithm: token_bucket,   capacity: 100,  refill_per_sec: 1.67, on_redis_error: closed }
  sw:     { algorithm: sliding_window, limit: 1000,    window_sec: 60,       on_redis_error: closed }
`);
const limiter = new Limiter(redis, rules);

async function avgMemory(pattern: string) {
  const keys = await redis.keys(pattern);
  let total = 0;
  for (const k of keys) total += (await redis.call('MEMORY', 'USAGE', k, 'SAMPLES', '0')) as number;
  return total / keys.length;
}

async function fill(rule: string, prefix: string, hitsPerKey: number) {
  // one key at a time, all its hits in parallel. 200k promises at once was
  // enough to make things fall over
  for (let i = 0; i < SAMPLES; i++) {
    const key = `${prefix}:${i}`;
    const results = await Promise.all(Array.from({ length: hitsPerKey }, () => limiter.check(rule, key)));
    if (results.some((r) => !r.allowed)) throw new Error(`${key}: a hit was rejected, numbers would be off`);
  }
}

const rows: [string, number][] = [];
const run = Date.now();

await fill('tb', `m${run}`, 1);
rows.push(['token bucket (any fill)', await avgMemory(`rl:tb:m${run}:*`)]);

for (const hits of [1, 10, 100, 1000]) {
  await fill('sw', `m${run}-${hits}`, hits);
  rows.push([`sliding window, ${hits} in window`, await avgMemory(`rl:sw:m${run}-${hits}:*`)]);
}

const info = await redis.info('server');
console.log(`redis ${info.match(/redis_version:(\S+)/)?.[1]}, ${SAMPLES} keys per row\n`);
console.log('| algorithm | bytes/key | 1M keys |');
console.log('|---|---:|---:|');
for (const [name, bytes] of rows) {
  console.log(`| ${name} | ${Math.round(bytes)} | ${((bytes * 1e6) / 1024 / 1024).toFixed(0)} MB |`);
}

// clean up after ourselves
const leftovers = await redis.keys(`rl:*:m${run}*`);
for (let i = 0; i < leftovers.length; i += 500) await redis.del(...leftovers.slice(i, i + 500));
redis.disconnect();
