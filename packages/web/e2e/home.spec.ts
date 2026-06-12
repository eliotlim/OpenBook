import {test, expect} from './fixtures';
import {SERVER} from './seed';

// The Home view — the new-tab page: a time-of-day greeting plus configurable
// widgets (quick actions, recents, favorites, recently edited). It lives at
// ?page=home like a real page, so deep links and reloads restore it.

test('home: greeting, jump-back-in tile, and a persistent customization', async ({page, request}) => {
  // Visit a known page first so it lands in the recents trail.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Home Trail ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id, name} = (await res.json()) as {id: string; name: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // The sidebar Home row opens the home screen.
  await page.getByRole('button', {name: 'Home', exact: true}).click();
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await expect(page.locator('[data-home-greeting]')).toHaveText(/Good (morning|afternoon|evening)/);

  // The just-visited page shows under "Jump back in"; its tile navigates back.
  const tile = page.locator('[data-home-widget="recents"]').getByRole('button', {name});
  await expect(tile).toBeVisible();

  // Customize: hide quick actions; the choice survives a reload (and the URL
  // itself restores Home).
  await expect(page.locator('[data-home-widget="actions"]')).toBeVisible();
  await page.getByRole('button', {name: 'Customize Home'}).click();
  await page.getByRole('menuitemcheckbox', {name: 'Quick actions'}).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-home-widget="actions"]')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await expect(page.locator('[data-home-widget="actions"]')).toHaveCount(0);
  await expect(page.locator('[data-home-widget="recents"]')).toBeVisible();

  // Back into the trail page via the tile.
  await page.locator('[data-home-widget="recents"]').getByRole('button', {name}).click();
  await expect(page).toHaveURL(new RegExp(`page=${id}`));
});

test('home: a quick action creates a page and the breadcrumb names Home', async ({page}) => {
  await page.goto('/?page=home');
  await expect(page.locator('[data-home-screen]')).toBeVisible();

  // Breadcrumb labels the pseudo-page.
  await expect(page.getByText('Home').first()).toBeVisible();

  // "New page" quick action creates and opens a fresh document.
  await page.locator('[data-home-widget="actions"]').getByRole('button', {name: 'New page'}).click();
  await expect(page.locator('[data-home-screen]')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
});
