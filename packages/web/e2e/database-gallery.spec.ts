import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {SERVER} from './seed';

const schema = {
  properties: [{id: 'p_status', name: 'Status', type: 'select', options: [
    {id: 's_todo', label: 'Todo', color: 'orange'}, {id: 's_done', label: 'Done', color: 'green'},
  ]}],
  views: [{id: 'v_gal', name: 'Gallery', type: 'gallery', filters: [], sorts: [], groupByPropertyId: 'p_status'}],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Gal ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'Apple', properties: {p_status: 's_done'}}, {name: 'Banana', properties: {p_status: 's_todo'}}, {name: 'Cherry', properties: {p_status: 's_done'}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}

// A grouped gallery splits cards into titled sections by the group property.
test('gallery grouping: cards split into sections by a property', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'New card'}).waitFor();
  // Two group sections (Todo, Done) — one card under Todo, two under Done.
  await expect(page.locator('[data-group]')).toHaveCount(2);
  await expect(page.locator('[data-group="s_done"]').getByRole('button')).toHaveCount(2);
  await expect(page.locator('[data-group="s_todo"]').getByRole('button')).toHaveCount(1);
});
