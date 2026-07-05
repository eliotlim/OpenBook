import {defineConfig, devices} from '@playwright/test';

/**
 * Standalone harness for the self-contained viewer bundle (OpenBookViewer).
 * Deliberately separate from playwright.config.ts: the fixtures are bare HTML
 * files opened from file:// — no Next server, no per-worker data servers, no
 * network at all (the specs assert exactly that). Run with:
 *
 *   pnpm --filter @book.dev/ui run build:viewer   # produce the bundle
 *   pnpm --filter @book.dev/web run test:e2e:viewer
 */
export default defineConfig({
  testDir: './e2e-viewer',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 2,
  reporter: process.env.CI ? [['github'], ['html', {open: 'never'}]] : [['list']],
  timeout: 30_000,
  expect: {timeout: 10_000},
  use: {trace: 'on-first-retry', screenshot: 'only-on-failure'},
  projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}],
});
