import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [
      {id: 's_todo', label: 'Todo', color: 'gray'}, {id: 's_done', label: 'Done', color: 'green'},
    ]},
    {id: 'p_cost', name: 'Cost', type: 'number'},
  ],
  views: [{id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'}],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Board ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'W', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8);
  for (const r of [
    {name: 'A', properties: {p_status: 's_done', p_cost: 10}},
    {name: 'B', properties: {p_status: 's_done', p_cost: 30}},
    {name: 'C', properties: {p_status: 's_todo', p_cost: 5}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}

test('board column footer: configurable calculation', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);

  // The Done column footer sums Cost (10 + 30 = 40) by default.
  const doneFooter = page.getByRole('button', {name: /Sum.*Cost.*40/});
  await expect(doneFooter).toBeVisible();
  await page.screenshot({path: 'test-results/board-footer.png'});

  // Switch the calculation to Count → the Done footer now shows the row count (2).
  await doneFooter.click();
  await page.locator('select').nth(1).selectOption('count_all');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: /Count.*Cost.*2/})).toBeVisible();
});

// The board has a collapse-all / expand-all toggle (parity with table & list).
test('board: collapse all and expand all columns', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  const card = page.locator('[draggable="true"]').filter({hasText: /A |B |C /});
  await expect(card.first()).toBeVisible();

  // Collapse all → every column folds (cards hidden).
  await page.getByRole('button', {name: 'Collapse all'}).click();
  await expect(card).toHaveCount(0);

  // Expand all → the cards come back.
  await page.getByRole('button', {name: 'Expand all'}).click();
  await expect(card.first()).toBeVisible();
});
