import {defineConfig} from 'vitest/config';

// LGR-15 — the ledger benchmark suite, DELIBERATELY separate from
// `vitest.config.ts`: benchmarks assert wall-clock thresholds, and wall-clock
// belongs in its own CI job (`pnpm --filter @book.dev/server run bench:ledger`),
// never inside `pnpm verify` where a loaded machine would flake the whole gate.
// Everything else mirrors the main config (same alias, same serialization).
export default defineConfig({
  resolve: {
    // The benchmarks import the ledger plugin's report fold from its shipped
    // sources; the plugin's `@book.dev/plugin-sdk` imports resolve to the sdk —
    // the same mapping the plugin host performs at runtime.
    alias: {'@book.dev/plugin-sdk': '@book.dev/sdk'},
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.bench.ts'],
    // One process: PGlite instances must not collide, and parallel suites would
    // contend for CPU under the very measurements being asserted.
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
