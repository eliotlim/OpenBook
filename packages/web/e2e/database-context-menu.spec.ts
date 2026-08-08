import {test, expect} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {SERVER} from './seed';


const schema = {
  properties: [
    {id: 'p_status', name: 'Status', type: 'select', options: [
      {id: 's_todo', label: 'Todo', color: 'gray'},
      {id: 's_done', label: 'Done', color: 'green'},
    ]},
  ],
  views: [
    {id: 'v_tbl', name: 'Table', type: 'table', filters: [], sorts: []},
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
  ],
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
test('cell context menu: filter by value and row actions', {tag: ['@database']}, async ({page, request}) => {
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

// Board (and gallery) cards get the same right-click row actions.
test('board card context menu: duplicate via right-click', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // Each kanban card shows the row title; right-click → Duplicate adds a card.
  const cards = page.locator('[draggable="true"]').filter({hasText: /Alpha|Beta|Gamma/});
  const before = await cards.count();
  await page.getByText('Beta', {exact: false}).first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Duplicate'}).click();
  await expect(cards).toHaveCount(before + 1);
});

// "Group by this column" from the cell context menu groups the table.
test('cell context menu: group by column', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // Right-click a Status cell → Group by Status → the grouped "Collapse all" appears.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: /Group by Status/}).click();
  await expect(page.getByRole('button', {name: 'Collapse all'})).toBeVisible();
});

// Right-clicking a column header offers column actions (hide, sort, group, …).
test('column header context menu: hide column', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const header = page.getByRole('table').getByText('Status', {exact: true});
  await expect(header).toBeVisible();

  // Right-click the Status header → Hide in view → the column disappears.
  await header.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Hide in view'}).click();
  await expect(page.getByRole('table').getByText('Status', {exact: true})).toHaveCount(0);
});

// ── TBL-9: row/column context menus at parity with block tables ─────────────

// Right-click a row → Insert above/below place the new row around the anchor.
test('row context menu: insert above and below', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(3);

  // Insert above the middle (Beta) row → the blank row lands at index 1.
  await page.getByRole('table').getByText('Todo').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Insert above'}).click();
  await expect(titles).toHaveCount(4);
  await expect(titles.nth(1)).toHaveValue('');

  // Insert below the last (Gamma) row → a blank row lands at the end.
  await page.getByRole('table').getByText('Done').last().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Insert below'}).click();
  await expect(titles).toHaveCount(5);
  await expect(titles.last()).toHaveValue('');
});

// Selecting 2+ rows and right-clicking one of them offers whole-selection ops.
test('row context menu: multi-select bulk delete and duplicate', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(3);

  // Tick the first two row checkboxes (they reveal on hover, but stay actionable).
  const boxes = page.getByRole('table').getByLabel('Select row');
  await boxes.nth(0).check();
  await boxes.nth(1).check();

  // Right-click a selected row's cell → Duplicate 2 rows.
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Duplicate 2 rows'}).click();
  await expect(titles).toHaveCount(5);

  // Re-select two rows and bulk delete them.
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole('table').getByText('Done').first().click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete 2 rows'}).click();
  await expect(titles).toHaveCount(3);
});

// Header sort/filter write onto the VIEW, so they survive a reload.
test('column header context menu: sort and filter persist on the view', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const header = page.getByRole('table').getByText('Status', {exact: true});

  // Sort ascending → the header carries the sort marker + a sort chip appears.
  await header.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Sort ascending'}).click();
  await expect(page.locator('th[data-sort="asc"]')).toHaveCount(1);

  // Filter by Status → a valueless "is not empty" condition lands as a chip.
  await header.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Filter by Status'}).click();
  await expect(page.getByText('Status is not empty')).toBeVisible();

  // Both live on the view (schema), so a reload keeps them.
  await page.reload();
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await expect(page.locator('th[data-sort="asc"]')).toHaveCount(1);
  await expect(page.getByText('Status is not empty')).toBeVisible();
});

// Insert property left/right lands the new column beside the anchor and persists.
test('column header context menu: insert property left and right', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  const header = page.getByRole('table').getByText('Status', {exact: true});
  const headings = page.locator('thead th');

  // Insert right of Status → Name | Status | Property.
  await header.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Insert right'}).click();
  await expect(headings.nth(2)).toContainText('Property');

  // Insert left of Status → Name | Property | Status | Property.
  await header.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Insert left'}).click();
  await expect(headings.nth(1)).toContainText('Property');
  await expect(headings.nth(2)).toContainText('Status');

  // Schema write → the reload keeps both new columns in place.
  await page.reload();
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await expect(headings.nth(1)).toContainText('Property');
  await expect(headings.nth(2)).toContainText('Status');
  await expect(headings.nth(3)).toContainText('Property');
});

// "Edit property…" opens the full editor at the pointer; a rename persists.
// Delete property removes the column for good.
test('column header context menu: edit and delete property', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // Edit property… → the PropertyMenu editor opens; rename Status → Stage.
  await page.getByRole('table').getByText('Status', {exact: true}).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Edit property…'}).click();
  const name = page.getByLabel('Property name');
  await expect(name).toHaveValue('Status');
  await name.fill('Stage');
  await name.blur();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByText('Stage', {exact: true})).toBeVisible();

  // The rename is a schema write — reload keeps it.
  await page.reload();
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await expect(page.getByRole('table').getByText('Stage', {exact: true})).toBeVisible();

  // Delete property → the column is gone, and stays gone after a reload.
  await page.getByRole('table').getByText('Stage', {exact: true}).click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Delete property'}).click();
  await expect(page.getByRole('table').getByText('Stage', {exact: true})).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', {name: 'Add column'}).waitFor();
  await expect(page.getByRole('table').getByText('Stage', {exact: true})).toHaveCount(0);
});

// The header `⋯` editor keeps working and now surfaces the SAME shared action
// list as the right-click menu (single item-list source, no drift).
test('header property editor: unregressed and shares the column action list', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seed(request);
  await page.goto(`/?page=${pageId}`);
  await page.getByRole('button', {name: 'Add column'}).waitFor();

  // Open the `⋯` editor (reveals on header hover; stays actionable).
  await page.getByRole('table').getByText('Status', {exact: true}).hover();
  await page.getByLabel('Property options').click();

  // The editor form is intact…
  await expect(page.getByLabel('Property name')).toHaveValue('Status');
  // …and the shared column actions render inside it.
  await expect(page.getByText('Sort ascending')).toBeVisible();
  await expect(page.getByText('Filter by Status')).toBeVisible();
  await expect(page.getByText('Insert right')).toBeVisible();
  await expect(page.getByText('Delete property')).toBeVisible();

  // An action from the editor works end-to-end (sort marks the header).
  await page.getByText('Sort ascending').click();
  await expect(page.locator('th[data-sort="asc"]')).toHaveCount(1);
});
