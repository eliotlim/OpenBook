import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [
      {id: 's_todo', label: 'Todo', color: 'gray'},
      {id: 's_done', label: 'Done', color: 'green'},
    ]},
    {id: 'p_cost', name: 'Cost', type: 'number'},
  ],
  views: [{
    id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: [],
    metrics: [
      {id: 'm_count', propertyId: 'title', type: 'count_all'},
      {id: 'm_sum', propertyId: 'p_cost', type: 'sum'},
    ],
  }],
};

async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Metrics ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  for (const r of [
    {name: 'A', properties: {p_status: 's_done', p_cost: 10}},
    {name: 'B', properties: {p_status: 's_todo', p_cost: 20}},
    {name: 'C', properties: {p_status: 's_done', p_cost: 30}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: r});
  return pageId;
}

// Dashboard metric cards aggregate the view's *filtered* rows and recompute live.
test('dashboard metric cards: compute, recompute on filter, and add', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  const count = page.locator('button', {hasText: 'Rows · Count all'});
  const sum = page.locator('button', {hasText: 'Cost · Sum'});
  await expect(count).toContainText('3');
  await expect(sum).toContainText('60');

  // Filtering (via the cell context menu) recomputes the cards over Done rows.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: /Filter: Status is Done/}).click();
  await expect(count).toContainText('2');
  await expect(sum).toContainText('40');

  // "Add metric card" in the view options adds another card.
  await expect(page.getByText('Rows · Count all')).toHaveCount(1);
  await page.getByRole('button', {name: 'View options'}).click();
  await page.getByRole('button', {name: 'Add metric card'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Rows · Count all')).toHaveCount(2);
});
