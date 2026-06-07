import {test, expect} from '@chromatic-com/playwright';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

async function newPage(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  return ((await res.json()) as {id: string}).id;
}

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
