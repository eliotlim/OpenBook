import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

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
