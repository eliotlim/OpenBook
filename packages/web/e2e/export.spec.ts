import {test, expect, takeSnapshot} from '@chromatic-com/playwright';
import type {APIRequestContext, Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const SERVER = 'http://127.0.0.1:4319';

async function newPage(request: APIRequestContext, name: string, blocks: unknown[], values: unknown[] = [], names: unknown[] = []): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {data: {name, data: {editorjs: {blocks}, values, names}}});
  return ((await res.json()) as {id: string}).id;
}

async function exportFromMenu(page: Page, item: string) {
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', {name: item}).click()]);
  return download;
}

test('page export: Markdown, HTML and vector PDFs download', async ({page, request}) => {
  const id = await newPage(request, 'Export Spec', [
    {type: 'header', data: {text: 'Title', level: 2}},
    {type: 'paragraph', data: {text: 'hello <b>world</b>'}},
    {type: 'list', data: {style: 'unordered', items: ['a', 'b']}},
    {id: 's1', type: 'slider', data: {name: 'n', min: 1, max: 10, step: 1, initial: 3}},
  ], [['s1', 3]]);
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  const md = await exportFromMenu(page, 'Markdown (.md)');
  expect(md.suggestedFilename()).toBe('Export Spec.md');

  const html = await exportFromMenu(page, 'Interactive HTML');
  expect(html.suggestedFilename()).toBe('Export Spec.html');

  const pdf = await exportFromMenu(page, 'PDF — paged');
  expect(pdf.suggestedFilename()).toBe('Export Spec.pdf');
  const head = (await readFile(await pdf.path())).subarray(0, 5).toString('latin1');
  expect(head).toBe('%PDF-'); // a real (vector) PDF, not a rasterized image

  await exportFromMenu(page, 'PDF — continuous');
});

test('interactive HTML stays live: a slider recomputes its expression', async ({page, request, context}) => {
  const id = await newPage(
    request,
    'Live Spec',
    [
      {id: 'm1', type: 'slider', data: {name: 'n', min: 1, max: 10, step: 1, initial: 3}},
      {id: 'e1', type: 'expr', data: {name: 'doubled', source: '__C__{m1}__ * 2'}},
    ],
    [['m1', 3], ['e1', 6]],
    [['n', 'm1'], ['doubled', 'e1']],
  );
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  const download = await exportFromMenu(page, 'Interactive HTML');
  const html = await readFile(await download.path(), 'utf8');

  const viewer = await context.newPage();
  await viewer.setContent(html, {waitUntil: 'load'});
  const val = viewer.locator('.expr[data-cell="e1"] [data-val]');
  await expect(val).toHaveText('6');
  const input = viewer.locator('.slider[data-cell="m1"] input');
  await input.fill('8');
  await input.dispatchEvent('input');
  await expect(val).toHaveText('16'); // recomputed live, no CDN needed
});

test('backup: export downloads a bundle and restore brings pages back', async ({page, request}, testInfo) => {
  await newPage(request, 'Backup Spec Page', [{type: 'paragraph', data: {text: 'content'}}]);
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Backup'}).click();

  const [bundle] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export backup'}).click()]);
  expect(bundle.suggestedFilename()).toContain('.openbook.json');

  await page.setInputFiles('input[type=file]', await bundle.path());
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Restore backup')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: restore dialog

  const before = ((await (await request.get(`${SERVER}/api/pages`)).json()) as unknown[]).length;
  await dialog.getByRole('button', {name: /^Restore/}).click();
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages`)).json()) as unknown[]).length)
    .toBeGreaterThan(before);
  // Copy mode suffixes the clashing name.
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages`)).json()) as {name: string}[]).some((p) => /\(imported\)/.test(p.name)))
    .toBe(true);
});
