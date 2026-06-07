import {test, expect, takeSnapshot} from '@chromatic-com/playwright';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

async function newPage(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  return ((await res.json()) as {id: string}).id;
}

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  await page.locator('.ce-block').first().waitFor({state: 'visible'});
  await page.locator('.ce-paragraph').first().click();
}

test('inline `:` shortcode inserts an emoji that persists', async ({page, request}, testInfo) => {
  const id = await newPage(request, 'Emoji Inline E2E');
  await openEditor(page, id);

  await page.keyboard.type('mood :heart');
  const list = page.getByRole('listbox', {name: 'Emoji'});
  await expect(list).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: inline emoji shortcode list

  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();

  const para = page.locator('.ce-paragraph').first();
  await expect(para).not.toContainText(':heart'); // shortcode consumed
  const inserted = (await para.textContent())?.trim() ?? '';
  expect(inserted).toMatch(/^mood \S+$/); // "mood " + an emoji glyph

  // The inserted emoji survives a reload (it autosaved).
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.ce-paragraph').first()).toHaveText(inserted);
});

test('the profile avatar opens the grid picker and applies a choice', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Profile'}).click();

  const avatar = page.locator('#ob-profile-avatar');
  await expect(avatar).toHaveText('🙂'); // the fallback before a pick
  await avatar.click();

  const picker = page.locator('.EmojiPickerReact');
  await expect(picker).toBeVisible();
  await picker.locator('input').first().fill('heart');
  await picker.locator('[data-unified]').first().click();

  await expect(picker).toBeHidden(); // picking closes the popover
  await expect(avatar).not.toHaveText('🙂'); // the avatar updated
});
