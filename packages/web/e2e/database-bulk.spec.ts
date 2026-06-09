import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [{id: 's_todo', label: 'Todo', color: 'gray'}, {id: 's_done', label: 'Done', color: 'green'}]},
    {id: 'p_prio', name: 'Priority', type: 'select', options: [{id: 'pr_low', label: 'Low', color: 'blue'}, {id: 'pr_high', label: 'High', color: 'red'}]},
  ],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []}],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Bulk ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'A', properties: {p_status: 's_todo'}}, {name: 'B', properties: {p_status: 's_done'}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}
test('bulk set any select property', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // Select all rows via the header checkbox.
  await page.getByRole('table').getByRole('checkbox').first().check();
  await expect(page.getByText('2 selected')).toBeVisible();

  // "Set" offers a submenu per select property; set Priority → High on all rows.
  await page.getByRole('button', {name: 'Set property'}).click();
  await page.getByRole('menuitem', {name: 'Priority'}).click();
  await page.getByRole('menuitem', {name: 'High'}).click();
  await expect(page.getByText('High')).toHaveCount(2);
});
