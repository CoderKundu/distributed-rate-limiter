import { describe, expect, it } from 'vitest';
import { parseRules } from '../src/config.js';

describe('parseRules', () => {
  it('reads both algorithms and defaults to fail-open', () => {
    const rules = parseRules(`
rules:
  a: { algorithm: token_bucket, capacity: 10, refill_per_sec: 2 }
  b: { algorithm: sliding_window, limit: 5, window_sec: 60, on_redis_error: closed }
`);
    expect(rules.get('a')).toEqual({
      name: 'a',
      algorithm: 'token_bucket',
      capacity: 10,
      refillPerSec: 2,
      onRedisError: 'open',
    });
    expect(rules.get('b')?.onRedisError).toBe('closed');
  });

  it('loads the real rules.yml', async () => {
    const { loadRules } = await import('../src/config.js');
    expect(loadRules('rules.yml').get('login')?.onRedisError).toBe('closed');
  });

  it.each([
    ['rules:\n  x: { algorithm: leaky, limit: 1 }', /unknown algorithm/],
    ['rules:\n  x: { algorithm: sliding_window, limit: 0, window_sec: 1 }', /limit must be/],
    ['rules:\n  x: { algorithm: sliding_window, limit: 2.5, window_sec: 1 }', /integer/],
    ['rules:\n  x: { algorithm: token_bucket, capacity: 10 }', /refill_per_sec/],
    ['rules:\n  x: { algorithm: token_bucket, capacity: 5, refill_per_sec: 1, on_redis_error: maybe }', /on_redis_error/],
    ['nope: true', /rules/],
  ])('rejects bad config: %s', (yml, err) => {
    expect(() => parseRules(yml)).toThrow(err);
  });
});
