import type { NextFunction, Request, Response } from 'express';
import type { CheckResult, Limiter } from './limiter.js';

export interface RateLimitOptions {
  rule: string;
  keyFn?: (req: Request) => string;
}

export function setLimitHeaders(res: Response, r: CheckResult) {
  res.setHeader('X-RateLimit-Limit', r.limit);
  // when redis is down we genuinely don't know what's left, so say nothing
  if (!r.degraded) res.setHeader('X-RateLimit-Remaining', r.remaining);
  if (!r.allowed) res.setHeader('Retry-After', Math.max(1, Math.ceil(r.retryAfterMs / 1000)));
}

export function rateLimit(limiter: Limiter, { rule, keyFn = (req) => req.ip ?? 'unknown' }: RateLimitOptions) {
  // fail at startup, not on the first request
  limiter.rule(rule);

  return async (req: Request, res: Response, next: NextFunction) => {
    let result: CheckResult;
    try {
      result = await limiter.check(rule, keyFn(req));
    } catch (err) {
      return next(err);
    }

    setLimitHeaders(res, result);
    if (!result.allowed) {
      res.status(429).json({ error: 'too many requests', retryAfterMs: result.retryAfterMs });
      return;
    }
    next();
  };
}
