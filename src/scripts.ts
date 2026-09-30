import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';

export type ScriptName = 'token_bucket' | 'sliding_window';

interface Script {
  src: string;
  sha: string;
}

function read(name: ScriptName): Script {
  // ../lua works from both src/ (tsx) and dist/ (compiled)
  const src = readFileSync(new URL(`../lua/${name}.lua`, import.meta.url), 'utf8');
  return { src, sha: createHash('sha1').update(src).digest('hex') };
}

const scripts: Record<ScriptName, Script> = {
  token_bucket: read('token_bucket'),
  sliding_window: read('sliding_window'),
};

/**
 * EVALSHA with a fallback. The sha is computed locally so we never have to
 * ask redis for it; if redis doesn't have the script (restart, failover,
 * SCRIPT FLUSH) we load it and try once more.
 */
export async function runScript(
  redis: Redis,
  name: ScriptName,
  key: string,
  args: (string | number)[],
): Promise<[number, number, number]> {
  const { src, sha } = scripts[name];
  try {
    return (await redis.evalsha(sha, 1, key, ...args)) as [number, number, number];
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) throw err;
    await redis.script('LOAD', src);
    return (await redis.evalsha(sha, 1, key, ...args)) as [number, number, number];
  }
}

export async function preloadScripts(redis: Redis) {
  for (const { src } of Object.values(scripts)) {
    await redis.script('LOAD', src);
  }
}
