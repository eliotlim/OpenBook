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
 * and the tsx servers both resolve `@book.dev/{ui,sdk}` from their dist. CI
 * runs `verify` (which builds libs) before this.
 *
 * Visual diffs: archiving is decoupled from functional runs (OB-222). Tests
 * import from `e2e/fixtures`, which only extends `@chromatic-com/playwright`
 * (and archives the DOM) when `CHROMATIC_ARCHIVE=1`; otherwise it's plain
 * `@playwright/test`. `pnpm chromatic` sets that flag, archives just the
 * `@visual` specs, then uploads (needs CHROMATIC_PROJECT_TOKEN).
 */
const WEB_PORT = 3000;

export default defineConfig({
  testDir: './e2e',
  // After the run, reap any per-worker data servers / throwaway data dirs that
  // a hard-killed worker leaked (see e2e/global-teardown.ts) — otherwise the
  // next run's pre-flight squatter check aborts on the stranded :44xx server.
  globalTeardown: './e2e/global-teardown.ts',
  // Spec files run in parallel across workers (each with its own isolated
  // data server); tests *within* a file stay ordered — many build on the
  // page state their file accumulated.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  // One local retry: a flaky test still SHOWS as flaky (never silently
  // green), but full runs stay actionable and the retry leaves a trace +
  // pageerror attachment to diagnose — see e2e/fixtures.ts.
  retries: process.env.CI ? 2 : 1,
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
    command: `pnpm --filter @book.dev/web exec next dev -p ${WEB_PORT}`,
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
