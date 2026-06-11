import {defineConfig, devices} from '@playwright/test';

/**
 * Playwright e2e for the web shell. Playwright manages one Next.js dev server
 * (:3000); each WORKER spawns its own OpenBook data server (ports 4400+, a
 * throwaway data dir each — see e2e/fixtures.ts) and points its browser
 * contexts at it via the `openbook.serverUrl` override the web shell honours.
 * Disjoint workspaces per worker are what make parallel spec files safe: page
 * names are unique per workspace, so the old shared-server setup forced
 * `workers: 1` and a fully serial suite.
 *
 * Prerequisite: the workspace libs must be built (`pnpm build:libs`) — Next dev
 * and the tsx servers both resolve `@open-book/{ui,sdk}` from their dist. CI
 * runs `verify` (which builds libs) before this.
 *
 * Visual diffs: tests import from `e2e/fixtures` (which extends
 * `@chromatic-com/playwright`), archiving the DOM each run. `pnpm chromatic`
 * uploads those archives (needs CHROMATIC_PROJECT_TOKEN).
 */
const WEB_PORT = 3000;

export default defineConfig({
  testDir: './e2e',
  // Spec files run in parallel across workers (each with its own isolated
  // data server); tests *within* a file stay ordered — many build on the
  // page state their file accumulated.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 4,
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
  webServer: {
    command: `pnpm --filter @open-book/web exec next dev -p ${WEB_PORT}`,
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
