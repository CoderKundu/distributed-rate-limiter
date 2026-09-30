import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // every file flushes the same redis db, so don't run them in parallel
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
