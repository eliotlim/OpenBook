import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

// Pin a page from its menu → it appears in the sidebar Favourites section and
// the command palette → unpin removes it. Favourites are device-local
// (localStorage), so each test's fresh context starts with none.
test('favorites: pin from the page menu, see it in the sidebar + palette, then unpin', async ({page}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await expect(page.getByText('Favorites', {exact: true})).toHaveCount(0); // none yet

  await page.locator('main .px-6').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Add to favorites'}).click();

  // Sidebar Favourites section now exists.
  await expect(page.getByText('Favorites', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: sidebar favourites section

  // Command palette surfaces a Favourites group.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog').getByText('Favorites', {exact: true})).toBeVisible();
  await page.keyboard.press('Escape');

  // Unpin via the menu (now labelled "Remove from favorites").
  await page.locator('main .px-6').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Remove from favorites'}).click();
  await expect(page.getByText('Favorites', {exact: true})).toHaveCount(0);
});

// Visiting a page records it; the palette's Recent group shows the one you're
// no longer on.
test('recents: a previously visited page appears in the palette Recent group', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Create a second page (so there's a non-current recent), via the palette.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Create new page');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog').getByText('Recent', {exact: true})).toBeVisible();
});
