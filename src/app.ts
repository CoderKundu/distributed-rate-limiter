import express, { type NextFunction, type Request, type Response } from 'express';
import type { Redis } from 'ioredis';
import { Limiter, UnknownRuleError } from './limiter.js';
import { rateLimit, setLimitHeaders } from './middleware.js';
import { naiveCheck } from './naive.js';

interface AppOptions {
  // exposes POST /check-naive. benchmark only
  naive?: boolean;
}

export function createApp(redis: Redis, limiter: Limiter, opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  // behind nginx in docker, so req.ip should come from X-Forwarded-For
  app.set('trust proxy', 'loopback, uniquelocal');
  app.use(express.json({ limit: '4kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, redis: redis.status });
  });

  app.post('/check', async (req, res, next) => {
    const { key, rule } = req.body ?? {};
    if (typeof key !== 'string' || !key || typeof rule !== 'string') {
      res.status(400).json({ error: 'body must be { key: string, rule: string }' });
      return;
    }
    try {
      const r = await limiter.check(rule, key);
      setLimitHeaders(res, r);
      res.status(r.allowed ? 200 : 429).json({
        allowed: r.allowed,
        remaining: r.remaining,
        retryAfterMs: r.retryAfterMs,
        ...(r.degraded && { degraded: true }),
      });
    } catch (err) {
      next(err);
    }
  });

  if (opts.naive) {
    app.post('/check-naive', async (req, res, next) => {
      const { key, limit = 100, windowSec = 60 } = req.body ?? {};
      try {
        const ok = await naiveCheck(redis, String(key), limit, windowSec);
        res.status(ok ? 200 : 429).json({ allowed: ok });
      } catch (err) {
        next(err);
      }
    });
  }

  // Demo routes. /demo sits behind the middleware and /noop is the same
  // handler without it, so the difference between them is what the limiter
  // costs you.
  const userKey = (req: Request) => req.get('x-user-id') ?? req.ip ?? 'anon';
  app.get('/demo', rateLimit(limiter, { rule: 'api-default', keyFn: userKey }), (_req, res) => {
    res.json({ hello: 'world' });
  });
  app.get('/noop', (_req, res) => {
    res.json({ hello: 'world' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UnknownRuleError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
