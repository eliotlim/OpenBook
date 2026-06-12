import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// Regression for two sidebar fixes:
//  - rows mirror the page icon (default 📄), matching the page header;
//  - right-clicking a row opens the page context menu (not the browser default),
//    which requires the tree row to forward the ContextMenuTrigger's handlers.
test('sidebar row shows the page icon and opens its context menu on right-click', async ({page}, testInfo) => {
  await page.goto('/');

  const row = page.getByRole('treeitem').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('📄'); // default page icon, mirrored from the page

  await row.click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Add subpage'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Move to trash'})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: sidebar row context menu
});

// The restructured sidebar chrome: trash is a nav row under Settings, the
// color mode lives in the profile menu, and flat page sections (Recents,
// Suggested) appear above the tree with collapsible headers.
test('sidebar chrome: trash row, color mode in profile menu, recents section', async ({page, request}) => {
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

  // Visiting pages builds the Recents section; its header collapses it.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Sidebar Recent ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id, name} = (await res.json()) as {id: string; name: string};
  await page.goto(`/?page=${id}`);
  const recents = page.locator('[data-sidebar-section="recents"]');
  await expect(recents.getByText(name)).toBeVisible();
  await recents.getByRole('button', {name: 'Recents'}).click(); // collapse
  await expect(recents.getByText(name)).toHaveCount(0);
  await recents.getByRole('button', {name: 'Recents'}).click(); // restore
  await expect(recents.getByText(name)).toBeVisible();
});
