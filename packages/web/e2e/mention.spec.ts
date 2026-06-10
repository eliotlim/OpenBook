import {test, expect, takeSnapshot} from '@chromatic-com/playwright';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

async function newPage(request: APIRequestContext, name: string): Promise<string> {
  // Page names are workspace-unique and these are fixed (the visual baseline
  // depends on them), so reclaim the name first — reruns against a long-lived
  // dev server would otherwise 409 (trashing a page frees its name).
  await reclaimName(request, name);
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  return ((await res.json()) as {id: string}).id;
}

async function reclaimName(request: APIRequestContext, name: string): Promise<void> {
  const pages = (await (await request.get(`${SERVER}/api/pages`)).json()) as {id: string; name: string | null}[];
  const taken = pages.find((p) => p.name === name);
  if (taken) await request.delete(`${SERVER}/api/pages/${taken.id}`);
}

async function openEditor(page: import('@playwright/test').Page, pageId: string): Promise<void> {
  await page.goto(`/?page=${pageId}`);
  await page.locator('.ce-block').first().waitFor({state: 'visible'});
  await page.locator('.ce-paragraph').first().click();
}

// Typing `@` opens a page-link menu; picking a page inserts an inline link that
// navigates to it and survives reload (the PageLinkInlineTool sanitize whitelist).
test('@ menu links an existing page inline and navigates to it', async ({page, request}) => {
  const targetId = await newPage(request, 'Roadmap E2E');
  const hostId = await newPage(request, 'Mention Host');

  await openEditor(page, hostId);
  await page.keyboard.type('See @Roadmap E2E');
  await expect(page.getByRole('listbox', {name: 'Link to page'}).getByRole('option')).toContainText('Roadmap E2E');

  await page.keyboard.press('Enter');
  const link = page.locator('a.ob-mention');
  await expect(link).toHaveText(/Roadmap E2E/);
  await expect(link).toHaveAttribute('data-page-id', targetId);

  // Survives a reload (the inline anchor is preserved through save sanitization).
  // Wait for autosave to persist the mention first.
  await expect
    .poll(async () => JSON.stringify((await (await request.get(`${SERVER}/api/pages/${hostId}`)).json()).data.editorjs).includes(targetId))
    .toBe(true);
  await page.reload();
  await expect(page.locator('a.ob-mention')).toHaveAttribute('data-page-id', targetId);

  // Clicking the mention navigates to the linked page.
  await page.locator('a.ob-mention').click();
  await expect(page).toHaveURL(new RegExp(targetId));
});

// No exact match → the menu offers to create the page, then links it.
test('@ menu creates a new page and links it', async ({page, request}) => {
  const hostId = await newPage(request, 'Mention Create Host');
  await openEditor(page, hostId);

  const novel = 'Quokka Notes E2E';
  await reclaimName(request, novel); // the @-create flow makes this page; free the name for reruns
  await page.keyboard.type(`Link @${novel}`);
  await expect(page.getByRole('listbox', {name: 'Link to page'}).getByText('Create page')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator('a.ob-mention')).toHaveText(new RegExp(novel));
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages`)).json()) as {name: string}[]).some((p) => p.name === novel))
    .toBe(true);
});

// Visual: the @ page-link menu open (kept in its own test — taking a snapshot
// mid-edit disrupts the editor selection that the insert flow relies on).
test('@ menu visual', async ({page, request}, testInfo) => {
  await newPage(request, 'Roadmap E2E');
  const hostId = await newPage(request, 'Mention Snapshot Host');
  await openEditor(page, hostId);
  await page.keyboard.type('See @Road');
  await expect(page.getByRole('listbox', {name: 'Link to page'})).toBeVisible();
  await takeSnapshot(page, testInfo);
});
