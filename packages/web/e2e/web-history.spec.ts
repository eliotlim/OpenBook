import {test, expect} from './fixtures';
import {newPage} from './seed';

// IA-2 (OB-541): on the web build the browser Back/Forward buttons must walk
// OpenBook's own page history. Page navigation pushes a real browser history
// entry; a `popstate` steps the per-tab window model back/forward. The in-app
// Back/Forward cluster drives the same browser stack so the two never drift.

const textSnapshot = (text: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

test('web history: browser and in-app Back/Forward walk the page trail', {tag: ['@shell']}, async ({page, request}) => {
  const a = await newPage(request, `History Alpha ${Date.now()}`, textSnapshot('Alpha document body.'));

  // Land on page A. This is the first browser history entry (obIndex 0).
  await page.goto(`/?page=${a}`);
  await expect(page.locator('main').getByText('Alpha document body.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`page=${a}`));

  // Navigate to Home via the sidebar. A page navigation, so it pushes a NEW
  // browser entry (obIndex 1) rather than replacing in place.
  await page.getByRole('button', {name: 'Home', exact: true}).click();
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await expect(page).toHaveURL(/page=home/);

  // Browser Back returns to page A (the popstate is translated into the window
  // model's goBack) — it does NOT exit the app.
  await page.goBack();
  await expect(page.locator('main').getByText('Alpha document body.')).toBeVisible();
  await expect(page.locator('[data-home-screen]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`page=${a}`));

  // Browser Forward returns to Home.
  await page.goForward();
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await expect(page).toHaveURL(/page=home/);

  // The in-app Back control drives the same browser stack: Back → A.
  await page.getByRole('button', {name: 'Go back'}).click();
  await expect(page.locator('main').getByText('Alpha document body.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`page=${a}`));

  // At the start of the trail there is nowhere further back to go, so the
  // control disables (the browser is left to leave the app on its own).
  await expect(page.getByRole('button', {name: 'Go back'})).toBeDisabled();

  // The in-app Forward control returns to Home.
  await page.getByRole('button', {name: 'Go forward'}).click();
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await expect(page).toHaveURL(/page=home/);
});
