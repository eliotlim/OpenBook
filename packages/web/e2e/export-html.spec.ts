import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {readFile} from 'node:fs/promises';

import {SERVER} from './seed';

// Per-test workspace reset: the seed below creates fixed-named pages and rows
// ('Project Root', 'Ship the export', …), so a clean workspace before each test
// keeps them collision-free without manual name reclamation.
test.use({freshWorkspace: true});

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
  // All four names are workspace-unique (rows are pages too); the per-test
  // freshWorkspace reset guarantees they are free before each test.
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
test('interactive HTML export: databases render and nested pages navigate', {tag: ['@export']}, async ({page, request}, testInfo) => {
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

test('interactive HTML export: served bundle has no unlisted subpage, mention, or row', {tag: ['@export', '@manager-verified']}, async ({page, request}, testInfo) => {
  const hiddenSubpage = await api(request, 'post', '/api/pages', {
    name: 'UP4 Hidden Subpage E2E',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'UP4 hidden subpage body'}}]}, values: [], names: []},
  });
  const hiddenMention = await api(request, 'post', '/api/pages', {
    name: 'UP4 Hidden Mention E2E',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'UP4 hidden mention body'}}]}, values: [], names: []},
  });
  const visibleChild = await api(request, 'post', '/api/pages', {
    name: 'UP4 Visible Child E2E',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'UP4 visible child body'}}]}, values: [], names: []},
  });
  const root = await api(request, 'post', '/api/pages', {
    name: 'UP4 Leak Matrix Root',
    data: {
      editorjs: {
        blocks: [
          {type: 'subpage', data: {kind: 'page', pageId: visibleChild.id}},
          {type: 'subpage', data: {kind: 'page', pageId: hiddenSubpage.id}},
          {
            type: 'paragraph',
            data: {text: `before <a class="ob-mention" data-page-id="${hiddenMention.id}">UP4 Hidden Mention E2E</a> after`},
          },
        ],
      },
      values: [],
      names: [],
    },
  });
  const db = await api(request, 'post', '/api/databases', {pageId: root.id, name: 'UP4 Matrix Rows', schema});
  const visibleRow = await api(request, 'post', `/api/databases/${db.id}/rows`, {name: 'UP4 Visible Row E2E', properties: {}});
  const hiddenRow = await api(request, 'post', `/api/databases/${db.id}/rows`, {name: 'UP4 Hidden Row E2E', properties: {}});

  for (const id of [hiddenSubpage.id, hiddenMention.id, hiddenRow.id]) {
    const res = await request.put(`${SERVER}/api/pages/${id}/visibility`, {data: {listed: false}});
    expect(res.ok()).toBe(true);
  }

  await page.goto(`/?page=${root.id}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).click();
  await page.getByRole('menuitem', {name: 'Interactive HTML'}).click();
  const download = await downloadPromise;
  await expect(page.getByText('3 hidden pages skipped.')).toBeVisible();

  const filePath = testInfo.outputPath('unlisted-clean-export.html');
  await download.saveAs(filePath);
  const html = await readFile(filePath, 'utf8');
  for (const secret of [
    hiddenSubpage.id,
    'UP4 Hidden Subpage E2E',
    hiddenMention.id,
    'UP4 Hidden Mention E2E',
    hiddenRow.id,
    'UP4 Hidden Row E2E',
  ]) {
    expect(html).not.toContain(secret);
  }

  // Serve the captured artifact over HTTP so the browser leg exercises the
  // same hydrated viewer boundary as a hosted export, not the authoring app.
  await page.route('http://up4-export.test/**', (route) =>
    route.fulfill({status: 200, contentType: 'text/html', body: html}),
  );
  await page.goto('http://up4-export.test/export.html');
  await expect(page.getByText('UP4 Visible Row E2E')).toBeVisible();
  await expect(page.getByText(/UP4 Hidden/)).toHaveCount(0);
  await expect(page.locator(`[data-page-id="${visibleRow.id}"]`)).toBeVisible();
  await page.getByRole('link', {name: /UP4 Visible Child E2E/}).first().click();
  await expect(page.getByText('UP4 visible child body')).toBeVisible();
});
