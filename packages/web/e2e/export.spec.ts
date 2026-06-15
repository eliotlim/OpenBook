import {test, expect, takeSnapshot} from './fixtures';
import {readFileSync} from 'fs';
import type {APIRequestContext, Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {newPage as seedPage, SERVER} from './seed';

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

// The classic-reactive interactive-HTML export (legacy `__C__{cell}__` slider /
// expr / chart format) retired with the EditorJS editor. The block editor's
// interactive HTML export — inputs, live code, charts and status lights staying
// live offline — is covered by "interactive HTML: option inputs and buttons
// drive code, charts, lights offline" below.

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

// The full kit stays interactive offline: radio pills, checklists, dropdowns,
// toggles and action buttons all drive multi-line live code, charts, and
// status lights in the exported file — not just sliders.
test('interactive HTML: option inputs and buttons drive code, charts, lights offline', async ({page, request, context}) => {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `Export kit ${Date.now()}`,
      data: {
        editor: 'blocks',
        blockdoc: {
          blocks: [
            {id: 'sld', type: 'slider', props: {name: 'rate', value: 4, min: 0, max: 12}},
            {id: 'rad', type: 'radio', props: {name: 'plan', options: 'Basic, Pro', value: 'Pro', wide: true}},
            {id: 'dd', type: 'dropdown', props: {name: 'region', options: 'EU, US', value: 'EU'}},
            {id: 'tgl', type: 'toggle', props: {name: 'turbo', value: true}},
            {
              id: 'lc',
              type: 'code',
              text: [{t: 'const base = plan === "Pro" ? 100 : 50;\nreturn base + (turbo ? 20 : 0) + rate * (region === "EU" ? 10 : 5);'}],
              props: {live: true, name: 'total'},
            },
            {id: 'c1', type: 'kitchart', props: {kind: 'bar', title: 'bars', source: '[total, total * 2]', labels: 'T, 2T'}},
            {id: 'btn', type: 'actionbutton', props: {btnlabel: 'Rate up', action: 'increment', target: 'rate', amount: 2}},
            {id: 'light', type: 'statuslight', props: {label: 'Big', source: 'total > 150'}},
          ],
        },
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', {name: 'Interactive HTML'}).click(),
  ]);
  const html = readFileSync((await download.path())!, 'utf8');

  const viewer = await context.newPage();
  await viewer.route('**/*', (route) => route.abort());
  await viewer.setContent(html, {waitUntil: 'load'});

  const total = viewer.locator('[data-cell="lc"] [data-val]');
  // Pro(100) + turbo(20) + 4 × EU(10) = 160 → total > 150 → the light reads ok.
  await expect(total).toHaveText('160');
  await expect(viewer.locator('.kitlight')).toHaveAttribute('data-status', 'ok');

  // Wide radio: full-width pills with dots; flipping recomputes.
  await expect(viewer.locator('.kit-radio.kit-wide .kit-dot')).toHaveCount(2);
  await viewer.locator('.kit-radio [data-opt="Basic"]').click();
  await expect(total).toHaveText('110');
  // 110 ≤ 150 → false → the light flips to bad (no longer ok).
  await expect(viewer.locator('.kitlight')).toHaveAttribute('data-status', 'bad');

  // Dropdown + toggle + button all keep working offline.
  await viewer.locator('.kit-dropdown select').selectOption('US');
  await expect(total).toHaveText('90');
  await viewer.locator('.kit-toggle input').uncheck();
  await expect(total).toHaveText('70');
  await viewer.locator('[data-btn="btn"]').click();
  await expect(total).toHaveText('80');

  // The chart redraws from the recomputed cell (bar rects present).
  await expect.poll(() => viewer.locator('[data-chart] rect').count()).toBeGreaterThan(1);
  await viewer.close();
});
