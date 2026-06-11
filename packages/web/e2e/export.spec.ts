import {test, expect, takeSnapshot} from './fixtures';
import type {APIRequestContext, Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {newPage as seedPage, SERVER, useClassicEditor} from './seed';

// This spec drives the classic EditorJS editor — still fully supported, but no
// longer the default — so pin it before the app boots (see seed.ts).
test.beforeEach(async ({page}) => {
  await useClassicEditor(page);
});


async function newPage(request: APIRequestContext, name: string, blocks: unknown[], values: unknown[] = [], names: unknown[] = []): Promise<string> {
  return seedPage(request, name, {editorjs: {blocks}, values, names});
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

test('interactive HTML stays live and works offline (incl. charts)', async ({page, request, context}) => {
  const id = await newPage(
    request,
    'Live Spec',
    [
      {id: 'm1', type: 'slider', data: {name: 'n', min: 1, max: 10, step: 1, initial: 3}},
      {id: 'e1', type: 'expr', data: {name: 'doubled', source: '__C__{m1}__ * 2'}},
      {id: 'e2', type: 'expr', data: {name: 'arr', source: '{series:[{name:"s",data:Array.from({length: __C__{m1}__}, (_,i)=>i*i)}]}'}},
      {id: 'c1', type: 'chart', data: {refCellIds: ['e2']}},
    ],
    [['m1', 3], ['e1', 6], ['e2', {series: [{name: 's', data: [0, 1, 4]}]}]],
    [['n', 'm1'], ['doubled', 'e1'], ['arr', 'e2']],
  );
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  const download = await exportFromMenu(page, 'Interactive HTML');
  const html = await readFile(await download.path(), 'utf8');

  const viewer = await context.newPage();
  // Block ALL network so we prove the export (d3 + Plot inlined) is fully offline.
  await viewer.route('**/*', (route) => route.abort());
  await viewer.setContent(html, {waitUntil: 'load'});

  const val = viewer.locator('.expr[data-cell="e1"] [data-val]');
  await expect(val).toHaveText('6');
  await expect(viewer.locator('figure[data-chart] svg')).toBeVisible(); // chart renders offline

  const input = viewer.locator('.slider[data-cell="m1"] input');
  await input.fill('8');
  await input.dispatchEvent('input');
  await expect(val).toHaveText('16'); // expression recomputed live
});

test('backup: export downloads a bundle and restore brings pages back', async ({page, request}, testInfo) => {
  await newPage(request, 'Backup Spec Page', [{type: 'paragraph', data: {text: 'content'}}]);
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  // Backup & restore now lives under the Workspace → Admin settings tab.
  await page.getByRole('button', {name: 'Admin'}).click();

  const [bundle] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export backup'}).click()]);
  expect(bundle.suggestedFilename()).toContain('.openbook.json');

  await page.setInputFiles('input[type=file]', await bundle.path());
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Restore backup')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: restore dialog

  const beforePages = (await (await request.get(`${SERVER}/api/pages`)).json()) as {id: string}[];
  await dialog.getByRole('button', {name: /^Restore/}).click();
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages`)).json()) as unknown[]).length)
    .toBeGreaterThan(beforePages.length);
  // Copy mode suffixes the clashing name.
  await expect
    .poll(async () => ((await (await request.get(`${SERVER}/api/pages`)).json()) as {name: string}[]).some((p) => /\(imported\)/.test(p.name)))
    .toBe(true);

  // The restore just copied the WHOLE workspace. Against a long-lived dev
  // server that doubles the page count every run (and the "X (imported)"
  // twins then shadow other specs' fixed names), so trash the copies and
  // purge the trash to keep the workspace lean. CI never notices (fresh DB).
  const beforeIds = new Set(beforePages.map((p) => p.id));
  const after = (await (await request.get(`${SERVER}/api/pages`)).json()) as {id: string}[];
  for (const p of after.filter((p) => !beforeIds.has(p.id))) {
    await request.delete(`${SERVER}/api/pages/${p.id}`);
  }
  await request.delete(`${SERVER}/api/trash`);
});
