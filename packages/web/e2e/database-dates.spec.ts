import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const schema = {
  properties: [{id: 'p_due', name: 'Due', type: 'date', dateDisplay: 'relative'}],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []}],
};
const ymd = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Rel ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'A', properties: {p_due: ymd(0)}},
    {name: 'B', properties: {p_due: ymd(3)}},
    {name: 'C', properties: {p_due: ymd(-1)}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}
test('relative date display', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await expect(page.getByText('Today', {exact: true})).toBeVisible();
  await expect(page.getByText('In 3 days', {exact: true})).toBeVisible();
  await expect(page.getByText('Yesterday', {exact: true})).toBeVisible();
});
