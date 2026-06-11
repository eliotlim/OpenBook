import {test, expect} from './fixtures';
import {SERVER} from './seed';

// Sub-items as first-class groups: a view's group-by can be the parent item
// itself ('__parent__'), turning each parent row into a board column / table
// group / chart slice of its direct children. These tests seed parent/child
// rows through the API (row names are workspace-unique, hence the tag) and
// drive the grouping exactly as a user would.


type Seeded = {pageId: string; dbId: string; epicA: string; epicB: string; tag: string};

/** A database with two parent rows (2 + 1 children), one loose row, and
 *  board + pie views already grouped by sub-items. */
async function seed(request: import('@playwright/test').APIRequestContext, suffix: string): Promise<Seeded> {
  const tag = `${Date.now()}-${suffix}`;
  const schema = {
    properties: [
      {
        id: 'p_status',
        name: 'Status',
        type: 'select',
        options: [
          {id: 'opt_todo', label: 'Todo', color: 'gray'},
          {id: 'opt_done', label: 'Done', color: 'green'},
        ],
      },
    ],
    views: [
      {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
      {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: '__parent__'},
      {id: 'v_pie', name: 'Pie', type: 'pie', filters: [], sorts: [], groupByPropertyId: '__parent__'},
    ],
  };
  const p = await request.post(`${SERVER}/api/pages`, {
    data: {name: `SubItems ${tag}`, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: `SubItems ${tag}`, schema}});
  const dbId = ((await d.json()) as {id: string}).id;

  const row = async (name: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const r = await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name, ...extra}});
    return ((await r.json()) as {id: string}).id;
  };
  const epicA = await row(`Epic Alpha ${tag}`);
  const epicB = await row(`Epic Beta ${tag}`);
  await row(`Alpha task 1 ${tag}`, {parentId: epicA, properties: {p_status: 'opt_todo'}});
  await row(`Alpha task 2 ${tag}`, {parentId: epicA, properties: {p_status: 'opt_todo'}});
  await row(`Beta task 1 ${tag}`, {parentId: epicB, properties: {p_status: 'opt_done'}});
  await row(`Loose task ${tag}`);
  return {pageId, dbId, epicA, epicB, tag};
}

async function rowsOf(request: import('@playwright/test').APIRequestContext, dbId: string): Promise<{id: string; name: string | null; parentId: string | null}[]> {
  return (await (await request.get(`${SERVER}/api/databases/${dbId}/rows`)).json()) as {id: string; name: string | null; parentId: string | null}[];
}

test('board grouped by sub-items: a column per parent, drag a card to re-parent', async ({page, request}) => {
  const {pageId, dbId, epicB, tag} = await seed(request, 'drag');
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // One column per parent (its direct children inside), plus the loose-rows column.
  const cols = page.locator('[data-col-key]');
  await expect(cols.filter({hasText: `Epic Alpha ${tag}`})).toBeVisible();
  await expect(cols.filter({hasText: `Epic Beta ${tag}`})).toBeVisible();
  await expect(cols.filter({hasText: 'No parent'})).toBeVisible();
  await expect(page.locator('[draggable="true"]').filter({hasText: `Alpha task 1 ${tag}`})).toBeVisible();

  // Drag the loose card onto Epic Beta's column → it becomes Beta's sub-item.
  const loose = page.locator('[draggable="true"]').filter({hasText: `Loose task ${tag}`});
  await loose.dispatchEvent('dragstart');
  await cols.filter({hasText: `Epic Beta ${tag}`}).dispatchEvent('dragover');
  await cols.filter({hasText: `Epic Beta ${tag}`}).dispatchEvent('drop');
  await loose.dispatchEvent('dragend');

  await expect
    .poll(async () => (await rowsOf(request, dbId)).find((r) => r.name === `Loose task ${tag}`)?.parentId ?? null)
    .toBe(epicB);
  // No loose rows remain, so the "No parent" column folds away.
  await expect(cols.filter({hasText: 'No parent'})).toHaveCount(0);
});

test('board grouped by sub-items: "+ New" in a parent column creates a sub-item', async ({page, request}) => {
  const {pageId, dbId, epicA, tag} = await seed(request, 'new');
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  const alphaCol = page.locator('[data-col-key]').filter({hasText: `Epic Alpha ${tag}`});
  await expect(alphaCol).toBeVisible();
  // The column container (the header's parent) holds the per-column "New" button.
  await alphaCol.locator('xpath=..').getByRole('button', {name: 'New', exact: true}).click();

  await expect
    .poll(async () => (await rowsOf(request, dbId)).filter((r) => r.parentId === epicA).length)
    .toBe(3);
});

test('pie chart grouped by sub-items: one slice per parent, sized by its children', async ({page, request}) => {
  const {pageId, tag} = await seed(request, 'pie');
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Pie', exact: true}).click();

  // The legend lists each parent with its child count (2 + 1; loose rows have
  // no slice of their own — they fold into the no-parent group).
  const alpha = page.getByRole('button', {name: new RegExp(`Epic Alpha ${tag}`)});
  await expect(alpha).toBeVisible();
  await expect(alpha).toContainText('2');
  await expect(page.getByRole('button', {name: new RegExp(`Epic Beta ${tag}`)})).toContainText('1');
});

test('table grouped by sub-items via view options: children under parent headings', async ({page, request}) => {
  const {pageId, tag} = await seed(request, 'tbl');
  await page.goto(`/?page=${pageId}`);
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toBeVisible();

  await page.getByRole('button', {name: 'View options'}).click();
  await page.getByLabel('Group by').selectOption('__parent__');
  await page.keyboard.press('Escape');

  // Group headers carry the parent names; the loose row gets the trailing group.
  await expect(page.getByRole('button', {name: new RegExp(`Epic Alpha ${tag}`)})).toBeVisible();
  await expect(page.getByRole('button', {name: new RegExp(`Epic Beta ${tag}`)})).toBeVisible();
  await expect(page.getByRole('button', {name: /No parent/})).toBeVisible();
});
