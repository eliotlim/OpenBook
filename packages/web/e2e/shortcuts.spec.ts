import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const hudFullWidth = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('hud') || '{}')?.viewMode?.fullWidth ?? false);

// The command palette: opens with the keyboard, groups app commands, and runs
// one (Toggle full width) — proving the shared command registry is wired to both
// the palette and the global key handler.
test('command palette: opens with ⌘K, groups commands, and runs one', async ({page}, testInfo) => {
  await page.goto('/');
  // Wait for the app to hydrate (the global key handler attaches on mount).
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByPlaceholder(/Search pages or run a command/)).toBeVisible();

  // Grouped action headings, scoped to the palette listbox — a database page
  // behind the dialog also has a toolbar button whose text is exactly "View".
  const palette = page.getByRole('listbox');
  await expect(palette.getByText('Create', {exact: true})).toBeVisible();
  await expect(palette.getByText('View', {exact: true})).toBeVisible();
  await expect(palette.getByText('Navigation', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: command palette with grouped commands

  // Filter to a command and run it with Enter (the top match auto-highlights).
  const before = await hudFullWidth(page);
  await page.getByPlaceholder(/Search pages or run a command/).fill('Toggle full width');
  await page.keyboard.press('Enter');
  await expect.poll(() => hudFullWidth(page)).toBe(!before);
});

// A global shortcut fires while the editor has focus: ⌘. toggles full width.
test('keyboard shortcut: ⌘. toggles the full-width view', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  const before = await hudFullWidth(page);
  await page.keyboard.press('ControlOrMeta+.');
  await expect.poll(() => hudFullWidth(page)).toBe(!before);
});

// The sidebar row reveals quick actions on hover: a "+" to add a subpage and a
// "⋯" that re-opens the same page context menu.
test('sidebar: hover row actions add a subpage and open the page menu', async ({page}, testInfo) => {
  await page.goto('/');
  const row = page.getByRole('treeitem').first();
  await row.hover();

  await row.getByRole('button', {name: 'More actions'}).click();
  await expect(page.getByRole('menuitem', {name: 'Rename'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Add subpage'})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: sidebar row hover ⋯ menu
  await page.keyboard.press('Escape');

  await row.hover();
  await row.getByRole('button', {name: 'Add subpage'}).click();
  // The new child nests under this row, so the row becomes an expandable folder.
  await expect(row.getByRole('button', {name: 'Collapse'})).toBeVisible();
});

// The enriched page context menu carries the new actions, and Rename focuses the
// page title field.
test('page menu: rename, copy link, duplicate, split — and rename focuses the title', async ({page}, testInfo) => {
  await page.goto('/');
  await page.locator('main .px-6').first().click({button: 'right'});

  const menu = page.getByRole('menu');
  await expect(menu.getByText('Rename')).toBeVisible();
  await expect(menu.getByText('Copy link')).toBeVisible();
  await expect(menu.getByText('Duplicate')).toBeVisible();
  await expect(menu.getByText('Open in split view')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: enriched page context menu

  await page.getByRole('menuitem', {name: 'Rename'}).click();
  await expect(page.locator('input[aria-label="Page title"]')).toBeFocused();
});
