import {test, expect, takeSnapshot} from './fixtures';
import {newPage, SERVER} from './seed';

// Typing `[[` opens the block editor's wikilink menu — a Notion-style
// alternative to `@`. Picking an existing page inserts the same inline chip an
// `@`-mention does; a name that matches nothing offers a "Create" row that makes
// the page a CHILD of the current page and links it; Escape leaves the literal.

test.use({freshWorkspace: true});

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  const para = page.locator('.obe-text').first();
  await para.waitFor({state: 'visible'});
  await expect(async () => {
    await para.click();
    await expect(para).toBeFocused({timeout: 500});
  }).toPass({timeout: 10_000});
}

test('[[ links an existing page inline and navigates to it', {tag: ['@editor']}, async ({page, request}) => {
  const targetId = await newPage(request, 'Roadmap Wiki');
  const hostId = await newPage(request, 'Wiki Host');

  await openEditor(page, hostId);
  await page.keyboard.type('See [[Roadmap Wiki'); // exact name → the page leads, no Create row
  const menu = page.getByRole('listbox', {name: 'Link to page'});
  await expect(menu.getByRole('option').filter({hasText: 'Roadmap Wiki'})).toBeVisible();

  await page.keyboard.press('Enter');
  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Roadmap Wiki/);
  await expect(link).toHaveAttribute('data-page-id', targetId);
  // The literal brackets are consumed.
  await expect(page.locator('.obe-text').first()).not.toContainText('[[');

  // Persists across reload (saved in the block document).
  await expect
    .poll(async () => JSON.stringify((await (await request.get(`${SERVER}/api/pages/${hostId}`)).json()).data).includes(targetId))
    .toBe(true);
  await page.reload();
  await expect(page.locator('a.obe-mention')).toHaveAttribute('data-page-id', targetId);

  // Clicking navigates to the linked page.
  await page.locator('a.obe-mention').click();
  await expect(page).toHaveURL(new RegExp(targetId));
});

test('[[ Create row makes a child page and links it (backlink picks it up)', {tag: ['@editor']}, async ({page, request}) => {
  const hostId = await newPage(request, 'Wiki Create Host');
  await openEditor(page, hostId);

  await page.keyboard.type('Link [[Fresh Wiki Page');
  const menu = page.getByRole('listbox', {name: 'Link to page'});
  await expect(menu.getByRole('option').filter({hasText: 'Create'})).toBeVisible();
  // A typed closing `]]` commits the highlighted (Create) row.
  await page.keyboard.type(']]');

  const link = page.locator('a.obe-mention');
  await expect(link).toHaveText(/Fresh Wiki Page/);
  const newId = await link.getAttribute('data-page-id');
  expect(newId).toBeTruthy();

  // The created page is a CHILD of the host page.
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages/${newId}`)).json()) as {parentId?: string}).parentId)
    .toBe(hostId);

  // Backlinks on the new page find the host (the mention edge is a real backlink,
  // exactly as an `@`-mention would produce).
  await expect
    .poll(async () => {
      const rows = (await (await request.get(`${SERVER}/api/pages/${newId}/backlinks`)).json()) as Array<{id: string}>;
      return rows.some((r) => r.id === hostId);
    })
    .toBe(true);
});

test('[[ Escape leaves the literal text untouched', {tag: ['@editor']}, async ({page, request}) => {
  const hostId = await newPage(request, 'Wiki Escape Host');
  await openEditor(page, hostId);

  await page.keyboard.type('Keep [[literal');
  await expect(page.getByRole('listbox', {name: 'Link to page'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', {name: 'Link to page'})).toBeHidden();
  await expect(page.locator('.obe-text').first()).toContainText('[[literal');
  await expect(page.locator('a.obe-mention')).toHaveCount(0);
});

// Visual: the wikilink menu open (its own test — snapshotting mid-edit disrupts
// the selection the insert flow relies on).
test('[[ menu visual', {tag: ['@editor', '@visual']}, async ({page, request}, testInfo) => {
  await newPage(request, 'Roadmap Wiki');
  const hostId = await newPage(request, 'Wiki Snapshot Host');
  await openEditor(page, hostId);
  await page.keyboard.type('See [[Road');
  await expect(page.getByRole('listbox', {name: 'Link to page'})).toBeVisible();
  await takeSnapshot(page, testInfo);
});
