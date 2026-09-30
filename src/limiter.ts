import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Rule, Rules } from './config.js';
import { runScript } from './scripts.js';

export interface CheckResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  // true when redis couldn't be reached and the rule's failure mode decided
  degraded?: boolean;
}

export class UnknownRuleError extends Error {
  constructor(public rule: string) {
    super(`unknown rule "${rule}"`);
  }
}

export class Limiter {
  private lastWarn = 0;

  constructor(
    private redis: Redis,
    private rules: Rules,
  ) {}

  rule(name: string): Rule {
    const rule = this.rules.get(name);
    if (!rule) throw new UnknownRuleError(name);
    return rule;
  }

  async check(ruleName: string, key: string): Promise<CheckResult> {
    const rule = this.rule(ruleName);
    const redisKey = `rl:${rule.name}:${key}`;
    const limit = rule.algorithm === 'token_bucket' ? rule.capacity : rule.limit;

    let res: [number, number, number];
    try {
      if (rule.algorithm === 'token_bucket') {
        res = await runScript(this.redis, 'token_bucket', redisKey, [rule.capacity, rule.refillPerSec / 1000]);
      } else {
        res = await runScript(this.redis, 'sliding_window', redisKey, [
          rule.windowSec * 1000,
          rule.limit,
          randomUUID(),
        ]);
      }
    } catch (err) {
      this.warn(err);
      const allowed = rule.onRedisError === 'open';
      return {
        allowed,
        limit,
        remaining: 0,
        // closed: tell the client to back off for a second rather than hammer us
        retryAfterMs: allowed ? 0 : 1000,
        degraded: true,
      };
    }

    const [allowed, remaining, retryAfterMs] = res;
    return { allowed: allowed === 1, limit, remaining, retryAfterMs };
  }

  // if redis is down every request fails, don't write a log line for each one
  private warn(err: unknown) {
    const now = Date.now();
    if (now - this.lastWarn < 5000) return;
    this.lastWarn = now;
    console.warn(`[limiter] redis call failed, using rule failure mode: ${(err as Error)?.message ?? err}`);
  }
}
