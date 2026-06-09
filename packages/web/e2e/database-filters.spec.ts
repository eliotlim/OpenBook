import {test, expect} from '@playwright/test';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const schema = {
  properties: [{id: 'p_status', name: 'Status', type: 'select', options: [
    {id: 's_todo', label: 'Todo', color: 'gray'}, {id: 's_done', label: 'Done', color: 'green'},
  ]}],
  views: [{id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: [{propertyId: 'p_status', direction: 'asc'}]}],
};
async function seed(request: APIRequestContext): Promise<string> {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Filt ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const tag = dbId.slice(0, 8); // page names are globally unique — keep row names distinct
  for (const r of [
    {name: 'A', properties: {p_status: 's_done'}}, {name: 'B', properties: {p_status: 's_todo'}}, {name: 'C', properties: {p_status: 's_done'}},
  ]) await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {...r, name: `${r.name} ${tag}`}});
  return pageId;
}

test('filter chips show and remove active filters', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(3);

  // Filter via the cell context menu → a chip appears and rows filter.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: /Filter: Status is Done/}).click();
  await expect(page.getByText('Status is Done', {exact: true})).toBeVisible();
  await expect(titles).toHaveCount(2);
  await page.screenshot({path: 'test-results/filter-chips.png'});

  // Removing the chip clears the filter.
  await page.getByRole('button', {name: 'Remove filter'}).click();
  await expect(page.getByText('Status is Done', {exact: true})).toHaveCount(0);
  await expect(titles).toHaveCount(3);
});

// Active sorts also show as removable chips below the toolbar.
test('sort chips show and remove active sorts', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // The seeded ascending Status sort renders a removable chip.
  await expect(page.getByRole('button', {name: 'Remove sort'})).toBeVisible();
  await page.getByRole('button', {name: 'Remove sort'}).click();
  await expect(page.getByRole('button', {name: 'Remove sort'})).toHaveCount(0);
});

// "Clear filters & sorts" in the view options resets the view in one click.
test('view options: clear filters and sorts', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // The seeded sort chip is present; Clear filters & sorts removes it.
  await expect(page.getByRole('button', {name: 'Remove sort'})).toBeVisible();
  await page.getByRole('button', {name: 'View options'}).click();
  await page.getByRole('button', {name: 'Clear filters & sorts'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Remove sort'})).toHaveCount(0);
});
