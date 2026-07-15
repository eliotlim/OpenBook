import {test, expect, takeSnapshot} from './fixtures';
import {newPage, reclaimNames, SERVER} from './seed';

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

test('@ menu links an existing page inline and navigates to it', {tag: ['@editor']}, async ({page, request}) => {
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
test('@ menu visual', {tag: ['@editor', '@visual']}, async ({page, request}, testInfo) => {
  await newPage(request, 'Roadmap E2E');
  const hostId = await newPage(request, 'Mention Snapshot Host');
  await openEditor(page, hostId);
  await page.keyboard.type('See @Road');
  await expect(page.getByRole('listbox', {name: 'Insert a mention'})).toBeVisible();
  await takeSnapshot(page, testInfo);
});

// A database row is a page too, so `@` can link one (IA-5): the mention picker
// surfaces rows alongside top-level pages, and picking a row inserts a chip that
// points at the row's page id.
test('@ menu links a database row', {tag: ['@editor']}, async ({page, request}) => {
  // A database with a single, distinctively-named row.
  const dbPage = await newPage(request, 'Mention Rows DB');
  const d = await request.post(`${SERVER}/api/databases`, {
    data: {pageId: dbPage, name: 'Tasks', schema: {properties: [], views: []}},
  });
  const dbId = ((await d.json()) as {id: string}).id;
  await reclaimNames(request, 'Zephyr Row');
  const r = await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name: 'Zephyr Row'}});
  const rowId = ((await r.json()) as {id: string}).id;

  const hostId = await newPage(request, 'Mention Row Host');
  await openEditor(page, hostId);
  await page.keyboard.type('Ref @Zephyr');
  const menu = page.getByRole('listbox', {name: 'Insert a mention'});
  await expect(menu.getByRole('option').filter({hasText: 'Zephyr Row'})).toBeVisible();

  await page.keyboard.press('Enter');
  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Zephyr Row/);
  await expect(link).toHaveAttribute('data-page-id', rowId);
});
