import {test, expect, chooseValue} from './fixtures';

// The updates section is desktop-only: it renders only when the host platform
// supplies an `updates` capability. Plain web has none, so the section is hidden.
// `?updates=<outcome>` injects a mock capability (see web/src/pages/index.tsx)
// so the section — and the check-now outcomes — can be exercised in the browser.

const openGeneralSettings = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'General', exact: true}).click();
};

test('updates section is hidden in plain web mode', async ({page}) => {
  await page.goto('/');
  await openGeneralSettings(page);
  // The General screen is up (Behavior section present) but no Updates section.
  await expect(page.getByRole('heading', {name: 'Behavior'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Updates'})).toHaveCount(0);
});

test('updates section renders and persists cadence + security-only when supported', async ({page}) => {
  await page.goto('/?updates=uptodate');
  await openGeneralSettings(page);

  await expect(page.getByRole('heading', {name: 'Updates'})).toBeVisible();
  // Default cadence is Daily.
  await expect(page.locator('#ob-update-cadence')).toHaveText(/Daily/);

  // Change cadence to Weekly and turn on security-only.
  await chooseValue(page, '#ob-update-cadence', 'weekly');
  await expect(page.locator('#ob-update-cadence')).toHaveText(/Weekly/);

  const securityToggle = page.locator('label', {hasText: 'Security updates only'}).getByRole('switch');
  await expect(securityToggle).toHaveAttribute('aria-checked', 'false');
  await securityToggle.click();
  await expect(securityToggle).toHaveAttribute('aria-checked', 'true');

  // On Never the toggle is inert (no automatic checks to filter) but keeps its
  // stored value: disabled while Never, re-enabled — still on — back on Weekly.
  await chooseValue(page, '#ob-update-cadence', 'never');
  await expect(securityToggle).toBeDisabled();
  await expect(securityToggle).toHaveAttribute('aria-checked', 'true');
  await chooseValue(page, '#ob-update-cadence', 'weekly');
  await expect(securityToggle).toBeEnabled();
  await expect(securityToggle).toHaveAttribute('aria-checked', 'true');

  // Reload (the ?updates flag persists in the URL) — both choices survive.
  await page.reload();
  await openGeneralSettings(page);
  await expect(page.locator('#ob-update-cadence')).toHaveText(/Weekly/);
  await expect(page.locator('label', {hasText: 'Security updates only'}).getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

test('check for updates surfaces up-to-date and update-available outcomes', async ({page}) => {
  const result = page.getByTestId('update-check-result');
  const button = page.getByTestId('check-for-updates');

  // Up-to-date outcome.
  await page.goto('/?updates=uptodate');
  await openGeneralSettings(page);
  await button.click();
  await expect(result).toContainText('Up to date');
  await expect(result).toContainText('checked just now');

  // Update-available outcome (separate load selects the mock outcome).
  await page.goto('/?updates=available');
  await openGeneralSettings(page);
  await page.getByTestId('check-for-updates').click();
  await expect(page.getByTestId('update-check-result')).toContainText('Update available: v1.72.0');
});

test('a failed check shows the error but does not refresh "Last checked"', async ({page}) => {
  // Fresh profile: no check has ever succeeded here.
  await page.goto('/?updates=error');
  await openGeneralSettings(page);
  await expect(page.getByText('Not checked yet')).toBeVisible();

  await page.getByTestId('check-for-updates').click();
  const result = page.getByTestId('update-check-result');
  await expect(result).toContainText('Couldn’t check for updates');
  // The failed attempt is stamped for the (future) scheduler, but the displayed
  // success timestamp is untouched — still never checked.
  await expect(page.getByText('Not checked yet')).toBeVisible();
});
