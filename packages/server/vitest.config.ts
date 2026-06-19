import {defineConfig} from 'vitest/config';

// Unit suites for the server's pure-ish logic: the PGlite serialization mutex,
// the disk-mirror book-file round-trip, the write journal, and conflict import.
// The broader CRUD/persistence/headless flows stay in `scripts/e2e.mts`.
export default defineConfig({
  test: {
    // Node environment: these modules touch `node:fs` and PGlite, not the DOM.
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // PGlite-backed suites each open their own embedded instance; keep them in
    // one process so temp data dirs don't collide.
    fileParallelism: false,
    // The mirror integration suite polls on filesystem-watch + debounce windows.
    testTimeout: 30_000,
  },
});
