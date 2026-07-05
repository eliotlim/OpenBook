import {test, expect} from './fixtures';
import type {Page} from '@playwright/test';

// The background update scheduler (ui/components/UpdateScheduler) mounts in
// DefaultLayout and is inert without the `updates` capability; `?updates=<mode>`
// injects the mock capability (web/src/pages/index.tsx), which counts its calls
// on `window` (__updateCheckCalls / __updateInstallCalls / __updateRelaunchCalls)
// precisely so these specs can observe background activity that has no DOM.
//
// Timers need no mocking: the scheduler runs a launch tick, and a fresh
// browser context has no `updates.lastCheckAt`, so the default daily cadence
// is immediately due (never-checked → stale). The `never` spec seeds the
// cadence *before* load and asserts the launch tick does nothing.

const counter = (page: Page, key: string): Promise<number> =>
  page.evaluate((k) => (window as unknown as Record<string, number | undefined>)[k] ?? 0, key);

/** The app is hydrated once the nav chrome is interactive — from then on the
 *  scheduler's mount effect (and its launch tick) has certainly run or not. */
const appReady = async (page: Page): Promise<void> => {
  await expect(page.getByRole('button', {name: 'Settings'}).first()).toBeVisible();
};

const toasts = (page: Page) => page.locator('[data-toast-host] > div');

test('security-only ON: a non-security update produces no toast and no install', async ({page}) => {
  await page.addInitScript(() => {
    localStorage.setItem('updates.securityOnly', 'true');
  });
  await page.goto('/?updates=available');
  await appReady(page);
  // The background check itself runs (security-only filters what is *acted*
  // on, not whether we look)…
  await expect.poll(() => counter(page, '__updateCheckCalls')).toBeGreaterThan(0);
  // …but nothing is downloaded and no toast ever appears.
  await page.waitForTimeout(500);
  await expect(toasts(page)).toHaveCount(0);
  expect(await counter(page, '__updateInstallCalls')).toBe(0);
});

test('security update: persistent toast that outlives auto-dismiss; action relaunches', async ({page}) => {
  await page.goto('/?updates=security');
  const toast = toasts(page).filter({hasText: 'Security update ready'});
  await expect(toast).toHaveCount(1);
  // The update was downloaded+staged before the toast.
  expect(await counter(page, '__updateInstallCalls')).toBe(1);
  // Persistent: still there past the 7s default auto-dismiss window.
  await page.waitForTimeout(8000);
  await expect(toast).toHaveCount(1);
  // The action applies the update by relaunching.
  await toast.getByRole('button', {name: 'Restart to update'}).click();
  await expect.poll(() => counter(page, '__updateRelaunchCalls')).toBe(1);
  // Acting on the toast dismisses it.
  await expect(toasts(page)).toHaveCount(0);
});

test('new major: announced once by toast, surfaced durably in Settings, never installed', async ({page}) => {
  await page.goto('/?updates=major');
  // The once-per-major toast fires on the launch check…
  const majorToast = toasts(page).filter({hasText: 'OpenBook 2.x is available'});
  await expect(majorToast).toHaveCount(1);
  // …but a major is never auto-installed.
  expect(await counter(page, '__updateInstallCalls')).toBe(0);

  // The durable surface: the Updates section shows the major line (persisted
  // updates.latestMajorSeen, recorded by the shared runner) — the toast being
  // missable is exactly why this exists.
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'General', exact: true}).click();
  await expect(page.getByTestId('major-available')).toHaveText('OpenBook 2.x is available');

  // Reload: the scheduler is throttled (fresh lastCheckAt) so no new check —
  // no second toast (once per major) — yet the Settings line survives.
  await page.reload();
  await appReady(page);
  await page.waitForTimeout(500);
  await expect(toasts(page)).toHaveCount(0);
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'General', exact: true}).click();
  await expect(page.getByTestId('major-available')).toHaveText('OpenBook 2.x is available');
});

test('Settings install button: appears after a check finds an update, drives install+relaunch', async ({page}) => {
  // Cadence `never` keeps the background scheduler silent (no auto-download), so
  // the install-call counter starts clean and only the button moves it. The
  // manual "Check for updates" runs regardless of cadence.
  await page.addInitScript(() => {
    localStorage.setItem('updates.cadence', 'never');
  });
  await page.goto('/?updates=available');
  await appReady(page);

  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'General', exact: true}).click();

  // No check yet → no update surfaced → no install affordance.
  await expect(page.getByTestId('install-update')).toHaveCount(0);

  // Run a manual check; it reports the available update.
  await page.getByTestId('check-for-updates').click();
  await expect(page.getByTestId('update-check-result')).toHaveText('Update available: v1.72.0');

  // Now the one-click action appears, and nothing has been installed yet.
  const installBtn = page.getByTestId('install-update');
  await expect(installBtn).toBeVisible();
  await expect(installBtn).toHaveText('Install & restart');
  expect(await counter(page, '__updateInstallCalls')).toBe(0);
  expect(await counter(page, '__updateRelaunchCalls')).toBe(0);

  // One click downloads+installs+relaunches through the shared runner.
  await installBtn.click();
  await expect.poll(() => counter(page, '__updateInstallCalls')).toBe(1);
  await expect.poll(() => counter(page, '__updateRelaunchCalls')).toBe(1);
});

test('cadence never: zero checkForUpdate calls even with an update on offer', async ({page}) => {
  await page.addInitScript(() => {
    localStorage.setItem('updates.cadence', 'never');
  });
  await page.goto('/?updates=security');
  await appReady(page);
  // Give the launch tick every chance to have (wrongly) fired.
  await page.waitForTimeout(1000);
  expect(await counter(page, '__updateCheckCalls')).toBe(0);
  expect(await counter(page, '__updateInstallCalls')).toBe(0);
  await expect(toasts(page)).toHaveCount(0);
});
