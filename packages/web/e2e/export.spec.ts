import {test, expect, takeSnapshot} from './fixtures';
import {readFileSync} from 'fs';
import type {APIRequestContext, Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import type {LibraryBackup} from '@book.dev/sdk';
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

test('page export: Markdown, HTML and vector PDFs download', {tag: ['@export', '@p1']}, async ({page, request}) => {
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

test('backup: export downloads a bundle and restore brings pages back', {tag: ['@export', '@visual']}, async ({page, request}, testInfo) => {
  await newPage(request, 'Backup Spec Page', [{type: 'paragraph', data: {text: 'content'}}]);
  await page.goto('/');
  await page.getByRole('button', {name: 'Settings'}).first().click();
  // Backup & restore now lives under the Advanced → Backups & data settings tab.
  await page.getByRole('button', {name: 'Backups & data'}).click();

  const [bundle] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Export backup'}).click()]);
  expect(bundle.suggestedFilename()).toContain('.openbook.json');

  // Carry a scheduled writer's recorded inconsistency through the REAL restore
  // dialog. The selected page references bytes omitted from the asset manifest;
  // server preflight accepts that only when the component forwards `skipped[]`.
  const skipCarrying = JSON.parse(await readFile((await bundle.path())!, 'utf8')) as LibraryBackup;
  const skippedPage = skipCarrying.pages.find((p) => p.name === 'Backup Spec Page')!;
  const missingAsset = 'a'.repeat(64);
  skippedPage.data = {
    ...skippedPage.data,
    blockdoc: {v: 1, update: '', blocks: [{id: 'missing-image', type: 'image', props: {assetId: missingAsset}}]},
  };
  skipCarrying.skipped = [{id: missingAsset, refs: [skippedPage.id], reason: 'missing-bytes'}];
  await page.setInputFiles('input[type=file]', {
    name: 'skip-carrying.openbook.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(skipCarrying)),
  });
  // The Settings panel is itself a role=dialog (and carries a "Restore backup…"
  // button), so scope to the restore dialog by its unique summary copy.
  const dialog = page.getByRole('dialog').filter({hasText: 'Pick what to restore'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Restore backup')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: restore dialog

  const beforePages = (await (await request.get(`${SERVER}/api/pages`)).json()) as {id: string}[];
  await dialog.getByRole('button', {name: /^Restore/}).click();
  // Deterministic completion signal: the restore dialog only closes and the
  // settings status line only renders "Restored N pages…" once importLibrary
  // has fully resolved server-side. Gate on that instead of a timed poll (the
  // old flake was a race between a fixed poll window and a slow long-lived dev
  // server).
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Restored \d+ pages/)).toBeVisible();
  await expect(page.getByText(/Warning: partial restore from scheduled backup/)).toBeVisible();
  // With restore provably applied, the copies now exist: the clashing page came
  // back as a name-suffixed twin (copy mode) and the page count grew.
  const afterRestore = (await (await request.get(`${SERVER}/api/pages`)).json()) as {name: string}[];
  expect(afterRestore.some((p) => /Backup Spec Page \(imported\)/.test(p.name))).toBe(true);
  expect(afterRestore.length).toBeGreaterThan(beforePages.length);

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

// The full kit stays interactive offline: radio pills, dropdowns, toggles and
// action buttons all drive multi-line live code, charts, and status lights in
// the exported file. Block-doc exports hydrate through the vendored viewer
// (the REAL block renderer, locked-but-interactive), so the assertions target
// the app's own widget markup — the retired bespoke runtime's `[data-cell]`
// scaffolding no longer exists on this path.
test('interactive HTML: option inputs and buttons drive code, charts, lights offline', {tag: ['@export']}, async ({page, request, context}) => {
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

  // The vendored viewer hydrated over the static body (no legacy runtime).
  await expect(viewer.locator('.ob-viewer')).toBeVisible();
  await expect(viewer.locator('main')).toHaveCount(0);

  const total = viewer.locator('.obe-code-out');
  // Pro(100) + turbo(20) + 4 × EU(10) = 160 → total > 150 → the light reads ok.
  await expect(total).toContainText('= 160');
  const light = viewer.locator('.obe-kit-status');
  await expect(light).toHaveAttribute('data-status', 'ok');

  // Radio pills; flipping recomputes.
  await viewer.getByRole('radio', {name: 'Basic'}).click();
  await expect(total).toContainText('= 110');
  // 110 ≤ 150 → false → the light flips to bad (no longer ok).
  await expect(light).toHaveAttribute('data-status', 'bad');

  // Dropdown (the app's custom listbox) + toggle + button keep working offline.
  await viewer.getByRole('combobox', {name: 'region value'}).click();
  await viewer.getByRole('option', {name: 'US'}).click();
  await expect(total).toContainText('= 90');
  await viewer.getByRole('switch', {name: 'turbo toggle'}).click();
  await expect(total).toContainText('= 70');
  await viewer.getByRole('button', {name: 'Rate up'}).click();
  await expect(total).toContainText('= 80');

  // The chart redraws from the recomputed value (bar rects present).
  await expect.poll(() => viewer.locator('.obe-chart-svg rect').count()).toBeGreaterThan(1);

  // Nothing was edited or persisted: the source island is byte-unchanged.
  await expect(viewer.locator('[contenteditable="true"]')).toHaveCount(0);
  await viewer.close();
});
