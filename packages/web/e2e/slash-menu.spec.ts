import {test, expect} from './fixtures';
import {newPage, useClassicEditor} from './seed';

// This spec drives the classic EditorJS editor — still fully supported, but no
// longer the default — so pin it before the app boots (see seed.ts).
test.beforeEach(async ({page}) => {
  await useClassicEditor(page);
});


// EditorJS's block/slash menu now preselects its first item, so pressing Enter
// inserts it without arrowing down first.
test('block menu preselects the first item so Enter inserts it', async ({page, request}) => {
  const id = await newPage(request, 'Slash Demo');
  await page.goto(`/?page=${id}`);
  await page.locator('.ce-block').first().waitFor({state: 'visible'});
  await page.locator('.ce-paragraph').first().click();

  await page.keyboard.type('/head');
  // The popover opens with the first match focused (the preselect).
  await expect(page.locator('.ce-popover--opened .ce-popover-item--focused')).toBeVisible();

  await page.keyboard.press('Enter');
  await expect(page.locator('.ce-header')).toBeVisible();
});
