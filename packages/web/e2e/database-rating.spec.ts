import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const schema = {
  properties: [{id: 'p_rate', name: 'Rating', type: 'rating'}],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []}],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Rate ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'A', properties: {p_rate: 3}}, {name: 'B', properties: {p_rate: 5}}, {name: 'C', properties: {p_rate: 1}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}
test('rating cell', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  // Each rating cell renders 5 star buttons.
  const firstCell = page.getByRole('group', {name: 'Rating'}).first();
  await expect(firstCell.getByRole('button')).toHaveCount(5);
  await page.screenshot({path: 'test-results/rating.png'});
  // Clicking the 4th star sets the rating (the cell stays interactive).
  await firstCell.getByRole('button', {name: '4 stars'}).click();
  await expect(firstCell.getByRole('button', {name: '4 stars'})).toHaveAttribute('aria-pressed', 'true');
});
