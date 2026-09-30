import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type FailureMode = 'open' | 'closed';

export type Rule =
  | {
      name: string;
      algorithm: 'token_bucket';
      capacity: number;
      refillPerSec: number;
      onRedisError: FailureMode;
    }
  | {
      name: string;
      algorithm: 'sliding_window';
      limit: number;
      windowSec: number;
      onRedisError: FailureMode;
    };

export type Rules = Map<string, Rule>;

class ConfigError extends Error {}

function positive(ruleName: string, field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ConfigError(`rule "${ruleName}": ${field} must be a positive number, got ${JSON.stringify(v)}`);
  }
  return v;
}

export function parseRules(text: string): Rules {
  const doc = parse(text);
  if (!doc || typeof doc.rules !== 'object') {
    throw new ConfigError('expected a top level "rules" map');
  }

  const rules: Rules = new Map();
  for (const [name, raw] of Object.entries<any>(doc.rules)) {
    const mode = raw.on_redis_error ?? 'open';
    if (mode !== 'open' && mode !== 'closed') {
      throw new ConfigError(`rule "${name}": on_redis_error must be "open" or "closed"`);
    }

    if (raw.algorithm === 'token_bucket') {
      const capacity = positive(name, 'capacity', raw.capacity);
      if (capacity < 1) throw new ConfigError(`rule "${name}": capacity must be >= 1`);
      rules.set(name, {
        name,
        algorithm: 'token_bucket',
        capacity,
        refillPerSec: positive(name, 'refill_per_sec', raw.refill_per_sec),
        onRedisError: mode,
      });
    } else if (raw.algorithm === 'sliding_window') {
      const limit = positive(name, 'limit', raw.limit);
      if (!Number.isInteger(limit)) throw new ConfigError(`rule "${name}": limit must be an integer`);
      rules.set(name, {
        name,
        algorithm: 'sliding_window',
        limit,
        windowSec: positive(name, 'window_sec', raw.window_sec),
        onRedisError: mode,
      });
    } else {
      throw new ConfigError(`rule "${name}": unknown algorithm ${JSON.stringify(raw.algorithm)}`);
    }
  }
  return rules;
}

export function loadRules(path: string): Rules {
  return parseRules(readFileSync(path, 'utf8'));
}
