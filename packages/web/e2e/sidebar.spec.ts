import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// Regression for two sidebar fixes:
//  - rows mirror the page icon (default 📄), matching the page header;
//  - right-clicking a row opens the page context menu (not the browser default),
//    which requires the tree row to forward the ContextMenuTrigger's handlers.
// Both persisted menu densities get their own Chromatic baseline: the density
// lives in openbook.preferences, exactly as it does after changing Appearance.
for (const menuDensity of ['comfortable', 'compact'] as const) {
  test(`sidebar context menu: ${menuDensity} density`, {tag: ['@shell', '@visual']}, async ({page}, testInfo) => {
    await page.addInitScript((density) => {
      localStorage.setItem('openbook.preferences', JSON.stringify({general: {menuDensity: density}}));
    }, menuDensity);
    await page.goto('/');

    const row = page.getByRole('treeitem').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('📄'); // default page icon, mirrored from the page

    await row.click({button: 'right'});
    const addSubpage = page.getByRole('menuitem', {name: 'Add subpage'});
    await expect(addSubpage).toBeVisible();
    await expect(addSubpage).toHaveClass(menuDensity === 'compact' ? /\btext-xs\b/ : /\btext-sm\b/);
    await expect(page.getByRole('menuitem', {name: 'Move to trash'})).toBeVisible();
    await takeSnapshot(page, testInfo); // visual: sidebar context menu at the persisted density
  });
}

// The restructured sidebar chrome: trash is a nav row under Settings, the
// color mode lives in the profile menu, and the Suggested section appears
// above the tree with a collapsible header (no Recents — too noisy).
test('sidebar chrome: trash row, color mode in profile menu, suggested section', {tag: ['@shell']}, async ({page, request}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Trash opens from its nav row at the top.
  await page.getByRole('button', {name: 'Trash'}).click();
  await expect(page.getByRole('heading', {name: 'Trash'})).toBeVisible();
  await page.keyboard.press('Escape');

  // Dark mode from the profile menu (no reset needed — the context is fresh
  // per test, and re-opening a Radix menu mid-close-animation races).
  await page.locator('[data-profile-menu]').click();
  await page.getByRole('menuitem', {name: 'Color mode'}).click();
  await page.getByRole('menuitemradio', {name: 'Dark'}).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

  // A page edited elsewhere (created via API, never visited) surfaces under
  // Suggested; the section header collapses and restores it. There is no
  // Recents section — recents live in the palette and on Home.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Sidebar Suggested ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const {name} = (await res.json()) as {id: string; name: string};
  await page.reload();
  await expect(page.locator('[data-sidebar-section="recents"]')).toHaveCount(0);
  const suggested = page.locator('[data-sidebar-section="suggested"]');
  await expect(suggested.getByText(name)).toBeVisible();
  await suggested.getByRole('button', {name: 'Suggested'}).click(); // collapse
  await expect(suggested.getByText(name)).toHaveCount(0);
  await suggested.getByRole('button', {name: 'Suggested'}).click(); // restore
  await expect(suggested.getByText(name)).toBeVisible();
});

// The sidebar "Pages" empty-state starters (IA-11 / NAV-6) must show ONLY for a
// genuinely empty library — not flash over a library that has pages while the
// initial page list is still loading. `freshWorkspace` gives a truly empty
// library; creating a page from the starter then swaps it for the tree.
test.describe('pages empty-state', () => {
  test.use({freshWorkspace: true});

  test('empty library shows starters; a real page replaces them', {tag: ['@shell']}, async ({page}) => {
    await page.goto('/');
    const empty = page.locator('[data-pages-empty]');
    await expect(empty).toBeVisible();
    // A genuinely empty library — no tree rows behind the starters.
    await expect(page.getByRole('treeitem')).toHaveCount(0);

    // Creating a page from the starter fills the tree and drops the empty-state.
    await empty.getByRole('button', {name: 'New page'}).click();
    await expect(empty).toHaveCount(0);
    await expect(page.getByRole('treeitem').first()).toBeVisible();
  });
});
