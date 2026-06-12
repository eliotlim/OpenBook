import {test, expect, takeSnapshot} from './fixtures';
import {newPage, useClassicEditor} from './seed';

// This spec drives the classic EditorJS editor — still fully supported, but no
// longer the default — so pin it before the app boots (see seed.ts).
test.beforeEach(async ({page}) => {
  await useClassicEditor(page);
});


// Regression for: the full-width toggle (a real menu checkbox item, not a dead
// Switch) widens the EditorJS content column — not just the title/database.
test('full-width toggle widens the editor content', async ({page, request}, testInfo) => {
  // Seed our own classic page: '/' auto-selects the workspace's most recent
  // page, which a previous spec in this worker may have stamped for the
  // block editor — the classic pin only covers un-stamped pages.
  const id = await newPage(request, `Full width ${Date.now()}`, {
    editorjs: {blocks: [{type: 'paragraph', data: {text: 'Width probe.'}}]},
    values: [],
    names: [],
  });
  await page.goto(`/?page=${id}`);

  const content = page.locator('.ce-block__content').first();
  await expect(content).toBeVisible();
  const constrained = await content.evaluate((el) => getComputedStyle(el).maxWidth);
  expect(constrained).not.toBe('none'); // starts constrained

  // Open the nav "⋮" menu and toggle Full Width.
  await page.locator('button.px-3[aria-haspopup=menu]').click();
  await page.getByRole('menuitemcheckbox', {name: 'Full Width'}).click();

  await expect
    .poll(() => content.evaluate((el) => getComputedStyle(el).maxWidth))
    .toBe('none');

  await takeSnapshot(page, testInfo); // visual: full-width editor
});

// Regression for: right-clicking in the page opens a custom context menu (the
// desktop has no native one). Tested on the page body, which is always visible
// (the sidebar version uses the same menu but the sidebar can be collapsed).
test('right-click in the page opens the context menu', async ({page}, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.locator('main .px-6').first().click({button: 'right'});

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Open in new tab')).toBeVisible();
  await expect(menu.getByText('Move to trash')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: page body context menu
});
