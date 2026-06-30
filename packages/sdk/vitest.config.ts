import {defineConfig} from 'vitest/config';

// Unit suites for the SDK's pure client logic (e.g. the live-stream poll
// fallback). Node environment + globals, matching the server/ui suites.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
