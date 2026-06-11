import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {SERVER} from './seed';

const schema = {
  properties: [{id: 'p_status', name: 'Status', type: 'select', options: [
    {id: 's_todo', label: 'Todo', color: 'gray'}, {id: 's_done', label: 'Done', color: 'green'},
  ]}],
  views: [{
    id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: [],
    colorRules: [{id: 'cr1', propertyId: 'p_status', operator: 'equals', value: 's_done', color: 'red'}],
  }],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Cond ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'A', properties: {p_status: 's_done'}}, {name: 'B', properties: {p_status: 's_todo'}}, {name: 'C', properties: {p_status: 's_done'}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}
test('conditional formatting', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await page.screenshot({path: 'test-results/cond-format.png'});
  // The two Done rows get a 3px coloured left edge; the Todo row does not.
  const accented = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('table tbody td:first-child')];
    return tds.filter((td) => getComputedStyle(td).borderLeftWidth === '3px').length;
  });
  expect(accented).toBe(2);
});
