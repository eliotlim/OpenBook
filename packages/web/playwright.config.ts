import {defineConfig, devices} from '@playwright/test';

/**
 * Playwright e2e for the web shell. Boots two servers Playwright manages for the
 * run: the OpenBook data server (embedded PGlite on :4319, a throwaway data dir)
 * and Next.js (:3000). The web app talks to :4319 by default, so no env wiring.
 *
 * Prerequisite: the workspace libs must be built (`pnpm build:libs`) — Next dev
 * and the tsx server both resolve `@open-book/{ui,sdk}` from their dist. CI runs
 * `verify` (which builds libs) before this.
 *
 * Visual diffs: tests import from `@chromatic-com/playwright`, which archives the
 * DOM each run. `pnpm chromatic` uploads those archives (needs CHROMATIC_PROJECT_TOKEN).
 */
const WEB_PORT = 3000;
const SERVER_PORT = 4319;
const E2E_DATA_DIR = '/tmp/openbook-web-e2e-data';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // shared backend + single workspace page
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', {open: 'never'}]] : [['list']],
  timeout: 30_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
  webServer: [
    {
      // Fresh embedded data each run so tests start from a known empty workspace.
      command: `rm -rf ${E2E_DATA_DIR} && pnpm --filter @open-book/server exec tsx src/bin.ts --data-dir ${E2E_DATA_DIR} --port ${SERVER_PORT}`,
      url: `http://127.0.0.1:${SERVER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @open-book/web exec next dev -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
