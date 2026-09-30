import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Limiter } from '../src/limiter.js';
import { adminRedis, rules, testRedis } from './helpers.js';

let redis: Redis;
let admin: Redis;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  redis = await testRedis();
  admin = await adminRedis();
  app = createApp(redis, new Limiter(redis, rules));
});
beforeEach(() => admin.flushdb());
afterAll(() => {
  redis.disconnect();
  admin.disconnect();
});

describe('POST /check', () => {
  it('returns allowed + remaining', async () => {
    const res = await request(app).post('/check').send({ key: 'user:42', rule: 'sw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('429s with Retry-After once the limit is hit', async () => {
    for (let i = 0; i < 3; i++) await request(app).post('/check').send({ key: 'u', rule: 'sw' });
    const res = await request(app).post('/check').send({ key: 'u', rule: 'sw' });
    expect(res.status).toBe(429);
    expect(res.body.allowed).toBe(false);
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    // 300ms window, rounded up to whole seconds
    expect(res.headers['retry-after']).toBe('1');
  });

  it('404s on unknown rule', async () => {
    const res = await request(app).post('/check').send({ key: 'u', rule: 'nope' });
    expect(res.status).toBe(404);
  });

  it('400s on a bad body', async () => {
    expect((await request(app).post('/check').send({ rule: 'sw' })).status).toBe(400);
    expect((await request(app).post('/check').send('garbage')).status).toBe(400);
  });

  it('does not expose the naive endpoint unless asked', async () => {
    expect((await request(app).post('/check-naive').send({ key: 'x' })).status).toBe(404);
  });
});

describe('middleware', () => {
  it('limits per x-user-id and sets headers', async () => {
    // api-default in the test rules is capacity 2
    const get = (user: string) => request(app).get('/demo').set('x-user-id', user);

    const a1 = await get('alice');
    expect(a1.status).toBe(200);
    expect(a1.headers['x-ratelimit-limit']).toBe('2');
    expect(a1.headers['x-ratelimit-remaining']).toBe('1');

    await get('alice');
    const a3 = await get('alice');
    expect(a3.status).toBe(429);
    // refill 0.5/s => 2s for the next token
    expect(a3.headers['retry-after']).toBe('2');

    expect((await get('bob')).status).toBe(200);
  });
});
