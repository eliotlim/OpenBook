import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';

import {reclaimNames, SERVER, useClassicEditor} from './seed';

// This spec drives the classic EditorJS editor — still fully supported, but no
// longer the default — so pin it before the app boots (see seed.ts).
test.beforeEach(async ({page}) => {
  await useClassicEditor(page);
});


const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [
      {id: 's_todo', label: 'Todo', color: 'gray'},
      {id: 's_done', label: 'Done', color: 'green'},
    ]},
    {id: 'p_cost', name: 'Cost', type: 'number'},
  ],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []}],
};

async function api(request: APIRequestContext, method: 'post' | 'put', path: string, data: unknown): Promise<{id: string}> {
  const res = await request[method](`${SERVER}${path}`, {data});
  return (await res.json()) as {id: string};
}

/** Seed a root page that links a subpage and hosts a database with row pages. */
async function seed(request: APIRequestContext): Promise<string> {
  // All four names are workspace-unique (rows are pages too) — free them for reruns.
  await reclaimNames(request, 'Child Notes', 'Project Root', 'Ship the export', 'Write the tests');
  const child = await api(request, 'post', '/api/pages', {
    name: 'Child Notes',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Hello from the child page.'}}]}, values: [], names: []},
  });
  const root = await api(request, 'post', '/api/pages', {
    name: 'Project Root',
    data: {editorjs: {blocks: [{type: 'subpage', data: {kind: 'page', pageId: child.id}}]}, values: [], names: []},
  });
  const db = await api(request, 'post', '/api/databases', {pageId: root.id, name: 'Tasks', schema});
  const r1 = await api(request, 'post', `/api/databases/${db.id}/rows`, {name: 'Ship the export', properties: {p_status: 's_done', p_cost: 13}});
  await api(request, 'post', `/api/databases/${db.id}/rows`, {name: 'Write the tests', properties: {p_status: 's_todo', p_cost: 5}});
  // The first row gets its own page body (keep its name — a bare PUT would blank it).
  await request.put(`${SERVER}/api/pages/${r1.id}`, {
    data: {name: 'Ship the export', data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Row detail: shipped on time.'}}]}, values: [], names: []}},
  });
  return root.id;
}

// The interactive HTML export bundles the page's whole reachable subtree into one
// self-contained file: databases render as tables and every nested page navigates.
test('interactive HTML export: databases render and nested pages navigate', async ({page, request}, testInfo) => {
  const rootId = await seed(request);
  await page.goto(`/?page=${rootId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // Page actions → Export → Interactive HTML, captured as a download.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  await page.getByRole('menuitem', {name: 'Interactive HTML'}).click();
  const download = await downloadPromise;
  const filePath = testInfo.outputPath('export.html');
  await download.saveAs(filePath);

  // Open the standalone file (no server) and verify the database table.
  await page.goto(`file://${filePath}`);
  await expect(page.locator('table.db-table')).toBeVisible();
  await expect(page.getByRole('link', {name: /Ship the export/})).toBeVisible();
  await expect(page.getByRole('link', {name: /Write the tests/})).toBeVisible();
  await expect(page.locator('.tag', {hasText: 'Done'})).toBeVisible();

  // A database row navigates into its own page (and Back returns to the root).
  await page.getByRole('link', {name: /Ship the export/}).click();
  await expect(page.getByText('Row detail: shipped on time.')).toBeVisible();
  await page.getByRole('button', {name: /Back/}).click();
  await expect(page.locator('table.db-table')).toBeVisible();

  // The subpage link navigates to the nested child page.
  await page.getByRole('link', {name: /Child Notes/}).click();
  await expect(page.getByText('Hello from the child page.')).toBeVisible();
});
