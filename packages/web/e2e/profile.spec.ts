import {test, expect} from './fixtures';

// The sidebar footer is the user's profile: a lettered (initials) avatar by
// default, swappable for an emoji or an uploaded image, with a menu that
// jumps to profile settings and the about dialog.

// A 1×1 red PNG — enough for createImageBitmap to produce an avatar.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('profile menu: initials by default, named monogram, edit via settings', async ({page}) => {
  await page.goto('/');
  const profileButton = page.locator('[data-profile-menu]');
  await expect(profileButton).toContainText('Anonymous');
  await expect(profileButton.locator('[data-avatar-kind="initials"]')).toHaveText('A');

  // Edit profile from the menu → settings open on the Profile tab.
  await profileButton.click();
  await page.getByRole('menuitem', {name: 'Edit profile'}).click();
  const nameInput = page.locator('#ob-profile-name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('Ada Lovelace');
  await page.keyboard.press('Escape');

  // The footer is now the user: monogram from the name.
  await expect(profileButton).toContainText('Ada Lovelace');
  await expect(profileButton.locator('[data-avatar-kind="initials"]')).toHaveText('AL');
});

test('profile avatar: an uploaded image replaces the initials, reset restores them', async ({page}) => {
  await page.goto('/');
  const profileButton = page.locator('[data-profile-menu]');
  await profileButton.click();
  await page.getByRole('menuitem', {name: 'Edit profile'}).click();

  await page.locator('[data-avatar-file]').setInputFiles({name: 'me.png', mimeType: 'image/png', buffer: TINY_PNG});
  await expect(profileButton.locator('[data-avatar-kind="image"]')).toBeVisible();

  await page.getByRole('button', {name: 'Use initials'}).click();
  await expect(profileButton.locator('[data-avatar-kind="initials"]')).toBeVisible();
});

test('profile menu: About OpenBook opens the about dialog', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-profile-menu]').click();
  await page.getByRole('menuitem', {name: 'About OpenBook'}).click();
  await expect(page.getByRole('heading', {name: 'About OpenBook'})).toBeVisible();
});
