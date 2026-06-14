import {test, expect, takeSnapshot} from './fixtures';
import {newPage, SERVER} from './seed';

// Typing `@` opens the block editor's mention menu (existing pages, dates,
// people). Picking a page inserts an inline link that navigates to it and
// survives reload. (The classic editor's inline "create a new page" flow is
// gone — the block editor's `@` links existing pages only.)

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  const para = page.locator('.obe-text').first();
  await para.waitFor({state: 'visible'});
  // Clicking before the editor finishes wiring focus silently drops the caret —
  // retry until the paragraph holds focus.
  await expect(async () => {
    await para.click();
    await expect(para).toBeFocused({timeout: 500});
  }).toPass({timeout: 10_000});
}

test('@ menu links an existing page inline and navigates to it', async ({page, request}) => {
  const targetId = await newPage(request, 'Roadmap E2E');
  const hostId = await newPage(request, 'Mention Host');

  await openEditor(page, hostId);
  await page.keyboard.type('See @Roadmap');
  const menu = page.getByRole('listbox', {name: 'Insert a mention'});
  await expect(menu.getByRole('option').filter({hasText: 'Roadmap E2E'})).toBeVisible();

  await page.keyboard.press('Enter');
  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Roadmap E2E/);
  await expect(link).toHaveAttribute('data-page-id', targetId);

  // Survives a reload — the mention persists in the saved block document.
  await expect
    .poll(async () => JSON.stringify((await (await request.get(`${SERVER}/api/pages/${hostId}`)).json()).data).includes(targetId))
    .toBe(true);
  await page.reload();
  await expect(page.locator('a.obe-mention')).toHaveAttribute('data-page-id', targetId);

  // Clicking the mention navigates to the linked page.
  await page.locator('a.obe-mention').click();
  await expect(page).toHaveURL(new RegExp(targetId));
});

// Visual: the @ mention menu open (kept in its own test — taking a snapshot
// mid-edit disrupts the editor selection that the insert flow relies on).
test('@ menu visual', async ({page, request}, testInfo) => {
  await newPage(request, 'Roadmap E2E');
  const hostId = await newPage(request, 'Mention Snapshot Host');
  await openEditor(page, hostId);
  await page.keyboard.type('See @Road');
  await expect(page.getByRole('listbox', {name: 'Insert a mention'})).toBeVisible();
  await takeSnapshot(page, testInfo);
});
