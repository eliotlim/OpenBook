import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {SERVER} from './seed';

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

// Right-clicking a date cell offers relative "Filter by date" presets.
test('date cell context menu: relative date filter presets', async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(3);

  // Right-click a date cell → Filter by date → Today → only today's row remains.
  await page.getByText('In 3 days', {exact: true}).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Filter by date'}).click();
  await page.getByRole('menuitem', {name: 'Today', exact: true}).click();
  await expect(titles).toHaveCount(1);
});

// Regression: rows whose date property is a {start, end} *range* must appear on
// the calendar (they once bucketed to null and the month rendered empty).
test('calendar shows rows dated with a start–end range', async ({page, request}) => {
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `RangeCal ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const rangeSchema = {
    properties: [{id: 'p_span', name: 'Span', type: 'date', dateRange: true}],
    views: [
      {id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []},
      {id: 'v_cal', name: 'Calendar', type: 'calendar', filters: [], sorts: [], datePropertyId: 'p_span'},
    ],
  };
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema: rangeSchema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const name = `Ranged ${dbId.slice(0, 8)}`;
  await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name, properties: {p_span: {start: ymd(0), end: ymd(2)}}}});

  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Calendar'}).click();
  // The pill renders on the range's start day (today).
  await expect(page.locator(`[data-day-key="${ymd(0)}"]`).getByText(name)).toBeVisible();
});
