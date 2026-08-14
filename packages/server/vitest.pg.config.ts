import {defineConfig} from 'vitest/config';

/** Dedicated real-Postgres suite; never included by the default PGlite runner. */
export default defineConfig({
  resolve: {
    alias: {'@book.dev/plugin-sdk': '@book.dev/sdk'},
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.pg.ts'],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
