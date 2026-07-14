import {test, expect, takeSnapshot} from './fixtures';

test('settings: grouped sections and reset danger zone', {tag: ['@shell', '@visual']}, async ({page}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();

  // The four grouped section headers (exact, so "Library" doesn't also match
  // the "My Workspace" switcher / breadcrumb).
  await expect(page.getByText('Preferences', {exact: true})).toBeVisible();
  await expect(page.getByText('Account', {exact: true})).toBeVisible();
  await expect(page.getByText('Library', {exact: true})).toBeVisible();
  await expect(page.getByText('Advanced', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: grouped settings nav

  // Retired "coming soon" stubs stay out of the rail — no dead-end tabs.
  await expect(page.getByRole('button', {name: 'Sign up'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Integrations'})).toHaveCount(0);

  // Backups & data carries backup + restore.
  await page.getByRole('button', {name: 'Backups & data'}).click();
  await expect(page.getByText('Backup & restore')).toBeVisible();

  // The guarded reset danger zone now lives on the General screen.
  await page.getByRole('button', {name: 'General'}).click();
  await expect(page.getByText('Danger zone')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Reset', exact: true})).toBeVisible();
});

test('settings: profile edits persist across reload', {tag: ['@shell', '@p1']}, async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Profile'}).click();

  await page.locator('#ob-profile-name').fill('Ada Lovelace');
  await expect(page.locator('#ob-profile-name')).toHaveValue('Ada Lovelace');

  // The tab lives in the URL, so a reload reopens Profile; the value is restored.
  await page.reload();
  await expect(page.locator('#ob-profile-name')).toHaveValue('Ada Lovelace');
});
