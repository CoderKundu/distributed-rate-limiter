import { createApp } from './app.js';
import { loadRules } from './config.js';
import { Limiter } from './limiter.js';
import { connect, waitForReady } from './redis.js';
import { preloadScripts } from './scripts.js';

const port = Number(process.env.PORT ?? 3000);
const rules = loadRules(process.env.RULES_FILE ?? 'rules.yml');

const redis = connect();
redis.on('error', () => {
  // ioredis logs unhandled error events loudly. the limiter already
  // reports failures, and reconnects happen on their own.
});

await waitForReady(redis);
await preloadScripts(redis);

const limiter = new Limiter(redis, rules);
const app = createApp(redis, limiter, { naive: process.env.ENABLE_NAIVE === '1' });

const server = app.listen(port, () => {
  console.log(`listening on :${port} with ${rules.size} rules (${[...rules.keys()].join(', ')})`);
});

function shutdown() {
  server.close(() => {
    redis.quit().finally(() => process.exit(0));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
