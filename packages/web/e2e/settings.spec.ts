import {test, expect, takeSnapshot} from './fixtures';

test('settings: grouped sections, stubs, and admin danger zone', async ({page}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();

  // The three grouped section headers (exact, so "Workspace" doesn't also match
  // the "My Workspace" switcher / breadcrumb).
  await expect(page.getByText('Preferences', {exact: true})).toBeVisible();
  await expect(page.getByText('Account', {exact: true})).toBeVisible();
  await expect(page.getByText('Workspace', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: grouped settings nav

  // A backend-less screen shows its placeholder, not a broken form.
  await page.getByRole('button', {name: 'Sign up'}).click();
  await expect(page.getByText('Create an account')).toBeVisible();

  // Admin carries backup + a guarded danger zone.
  await page.getByRole('button', {name: 'Admin'}).click();
  await expect(page.getByText('Backup & restore')).toBeVisible();
  await expect(page.getByText('Danger zone')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeVisible();
});

test('settings: profile edits persist across reload', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Profile'}).click();

  await page.locator('#ob-profile-name').fill('Ada Lovelace');
  await expect(page.locator('#ob-profile-name')).toHaveValue('Ada Lovelace');

  // The tab lives in the URL, so a reload reopens Profile; the value is restored.
  await page.reload();
  await expect(page.locator('#ob-profile-name')).toHaveValue('Ada Lovelace');
});
