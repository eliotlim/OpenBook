import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [
      {id: 's_todo', label: 'Todo', color: 'gray'},
      {id: 's_done', label: 'Done', color: 'green'},
    ]},
  ],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []}],
};

async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Ctx ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8); // page names are globally unique — keep row names distinct
  for (const r of [
    {name: 'Alpha', properties: {p_status: 's_done'}},
    {name: 'Beta', properties: {p_status: 's_todo'}},
    {name: 'Gamma', properties: {p_status: 's_done'}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}

// Right-clicking a cell opens a context menu offering "filter by this value",
// sort, and row actions — quick UX without hunting for the row/column menus.
test('cell context menu: filter by value and row actions', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(3);

  // Right-click a "Done" status cell → "Filter: Status is Done" keeps the 2 Done rows.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  const filterItem = page.getByRole('menuitem', {name: /Filter: Status is Done/});
  await expect(filterItem).toBeVisible();
  await page.screenshot({path: 'test-results/ctx-menu.png'});
  await filterItem.click();
  await expect(titles).toHaveCount(2);

  // Right-click a remaining cell → Duplicate adds a row.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Duplicate'}).click();
  await expect(titles).toHaveCount(3);
});
