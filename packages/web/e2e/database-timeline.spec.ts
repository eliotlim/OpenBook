import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

async function addColumn(page: import('@playwright/test').Page, name: string, type: string): Promise<void> {
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill(name);
  await page.locator('select').first().selectOption(type);
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText(name, {exact: true})).toBeVisible();
}

// A timeline view lays a dated row out as a bar on a month axis.
test('timeline view: a dated row renders as a bar', async ({page}, testInfo) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('Due').first().fill('2026-03-15');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  // The month axis labels the spanned month.
  await expect(page.getByText('Mar 2026')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: gantt timeline
});

// A dependency property links one row to another (drawn as arrows on a timeline).
test('dependencies: link a row to another row', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Depends', 'dependency');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();

  // Link the second row's "Depends" cell to the first row (the only candidate).
  await page.getByRole('button', {name: 'Add dependency'}).nth(1).click();
  const picker = page.getByPlaceholder('Depends on…');
  await expect(picker).toBeVisible();
  // Candidates are the buttons in the picker popover; pick the first one.
  await page.locator('[data-radix-popper-content-wrapper] button').first().click();

  // The link renders as a removable chip in the cell.
  await expect(page.getByRole('button', {name: 'Remove dependency'})).toBeVisible();
});

// A timeline bar can be dragged to reschedule the row's date.
test('timeline drag: dragging a bar reschedules the row', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'When', 'date');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('When').first().fill('2026-03-15');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  // Drag the bar to the right (later in time).
  const bar = page.getByTitle(/drag to reschedule/);
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 170, box.y + box.height / 2, {steps: 12});
  await page.mouse.up();

  // Back in the table, the date has moved off its original value (dated cells
  // render as text; click to reveal the native input).
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await page.getByLabel('When').first().click();
  await expect(page.getByLabel('When').first()).not.toHaveValue('2026-03-15');
});

// A dependency graph view lays rows out as connected nodes.
test('dependency graph: shows rows as connected nodes', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Depends', 'dependency');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'Add dependency'}).nth(1).click();
  await expect(page.getByPlaceholder('Depends on…')).toBeVisible();
  await page.locator('[data-radix-popper-content-wrapper] button').first().click();

  // Switch to the Graph view; the dependent node reports its link count.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Graph'}).click();
  await expect(page.getByText('depends on 1 row')).toBeVisible();
});

// Opening a database row shows its columns in the page-view properties panel,
// with a config menu to show/hide and to organise them into groups.
test('page-view properties: configure visibility and groups', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Row X');
  await title.blur();

  // Open the row in the split pane → its properties panel renders.
  await page.getByRole('button', {name: 'Open row'}).first().click();

  // The config menu manages property visibility + groups.
  await page.getByRole('button', {name: 'Configure properties'}).click();
  await expect(page.getByText('Groups', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Add', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Group name'})).toHaveValue('New group');
});

// Regression: a timeline over *separate* Start/End columns must move both
// edges in one drag — two sequential single-property writes raced and the
// second reverted the first (only one edge moved).
test('timeline drag with separate start/end columns moves both dates', async ({page, request}) => {
  const schema = {
    properties: [
      {id: 'p_start', name: 'Start', type: 'date'},
      {id: 'p_end', name: 'End', type: 'date'},
    ],
    views: [
      {id: 'v_tl', name: 'Timeline', type: 'timeline', filters: [], sorts: [], datePropertyId: 'p_start', endDatePropertyId: 'p_end'},
    ],
  };
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `TwoProp ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name: `Span ${dbId.slice(0, 8)}`, properties: {p_start: '2026-03-02', p_end: '2026-03-16'}}});

  await page.goto(`/?page=${pageId}`);
  const bar = page.getByTitle(/drag to reschedule/);
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, {steps: 10});
  await page.mouse.up();

  // Both dates moved by the same delta — the 14-day span is preserved.
  await expect
    .poll(async () => {
      const rows = (await (await request.get(`${SERVER}/api/databases/${dbId}/rows`)).json()) as Array<{properties: Record<string, string>}>;
      const {p_start, p_end} = rows[0].properties;
      const days = (Date.parse(p_end) - Date.parse(p_start)) / 86_400_000;
      return {days, moved: p_start !== '2026-03-02'};
    })
    .toEqual({days: 14, moved: true});
});
