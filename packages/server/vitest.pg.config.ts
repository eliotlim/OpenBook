import {defineConfig, mergeConfig} from 'vitest/config';
import baseConfig from './vitest.config';

/** Dedicated real-Postgres suite; never included by the default PGlite runner. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['src/**/*.pg.ts'],
      fileParallelism: false,
      hookTimeout: 30_000,
      testTimeout: 30_000,
    },
  }),
);
