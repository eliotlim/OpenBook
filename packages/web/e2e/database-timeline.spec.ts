import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {reclaimNames, SERVER} from './seed';

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
  await chooseValue(page, page.getByLabel('Property type'), type);
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

  // Drag the bar to the right (later in time). The timeline centres on today, so
  // a bar dated months earlier starts scrolled off-screen — reveal it first.
  const bar = page.getByTitle(/drag to reschedule/);
  await expect(bar).toBeVisible();
  await bar.scrollIntoViewIfNeeded();
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

// Drag from one bar's link handle onto another to create a dependency edge.
test('timeline drag-to-link: drag one bar onto another to add a dependency', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'When', 'date');
  await addColumn(page, 'Depends', 'dependency');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('When').first().fill('2026-03-10');
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('When').nth(1).fill('2026-03-20');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  const bars = page.getByTitle(/drag to reschedule/);
  await expect(bars).toHaveCount(2);
  // No dependency arrow yet.
  await expect(page.locator('svg path[marker-end]')).toHaveCount(0);

  // Drag the first bar's link handle onto the second bar.
  await bars.nth(0).hover();
  const handle = bars.nth(0).getByLabel('Link dependency');
  const h = (await handle.boundingBox())!;
  const target = (await bars.nth(1).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {steps: 14});
  await page.mouse.up();

  // The dependency now draws an arrow, and the second row carries the link.
  await expect(page.locator('svg path[marker-end]')).toHaveCount(1);
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Remove dependency'})).toBeVisible();
});

// With no dated rows, clicking the empty canvas places a new item at that date.
test('timeline click-to-place: clicking the empty canvas adds a dated item', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  // Nothing is placed yet; the empty state invites a click.
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(0);
  await expect(page.getByText(/click anywhere on the timeline to add one/i)).toBeVisible();

  // The today marker is a pointer-through guide; clicking through it onto the
  // canvas creates a row dated there, which renders as a bar.
  const todayBar = page.locator('div[title="Today"]');
  const tb = (await todayBar.boundingBox())!;
  await page.mouse.click(tb.x, tb.y + 90);
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(1);
});

// A dateless row sits in the "Unscheduled" tray; arm it, then click to drop it.
test('timeline unscheduled tray: arm a dateless row and click to place it', async ({page, request}) => {
  await reclaimNames(request, 'Floating'); // row titles are workspace-unique
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  // A named row, left without a date.
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Floating');
  await title.blur();
  await expect(title).toHaveValue('Floating');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  // It shows in the tray and isn't placed.
  const chip = page.getByRole('button', {name: 'Place Floating on the timeline'});
  await expect(chip).toBeVisible();
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(0);

  // Arm it, then click the canvas — it gets a date, becomes a bar, and leaves the tray.
  await chip.click();
  await expect(page.getByText('Click the timeline to place it')).toBeVisible();
  const todayBar = page.locator('div[title="Today"]');
  const tb = (await todayBar.boundingBox())!;
  await page.mouse.click(tb.x, tb.y + 60);
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(1);
  await expect(chip).toHaveCount(0);
});

// The zoom selector switches the axis between daily…yearly granularities.
test('timeline scale: switching zoom updates the axis', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('Due').first().fill('2026-03-15');

  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();

  // A fine default zoom shows a month context tier.
  await expect(page.getByText('Mar 2026')).toBeVisible();

  // Yearly zoom labels whole years and drops the month context.
  await chooseValue(page, page.getByLabel('Timeline scale'), 'year');
  await expect(page.getByText('2026', {exact: true})).toBeVisible();
  await expect(page.getByText('Mar 2026')).toHaveCount(0);
});

// A dependency graph view lays rows out as connected nodes.
test('dependency graph: shows rows as connected nodes', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Depends', 'dependency');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();
  // Let the create→refetch churn settle before anchoring a popover to a row:
  // opening it mid-churn remounts the candidate buttons under the click
  // ("element is not stable" until the 30s timeout — the long-standing flake).
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(2);
  await expect(page.getByRole('button', {name: 'Add dependency'})).toHaveCount(2);
  await page.getByRole('button', {name: 'Add dependency'}).nth(1).click();
  await expect(page.getByPlaceholder('Depends on…')).toBeVisible();
  const candidate = page.locator('[data-radix-popper-content-wrapper] button').first();
  await expect(candidate).toBeVisible();
  await candidate.click();

  // Switch to the Graph view; the dependent node reports its link count.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Graph'}).click();
  await expect(page.getByText('depends on 1 row')).toBeVisible();
});

// Opening a database row shows its columns in the page-view properties panel,
// with a config menu to show/hide and to organise them into groups.
test('page-view properties: configure visibility and groups', async ({page, request}) => {
  await reclaimNames(request, 'Row X'); // row titles are workspace-unique; free it for reruns
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
  // The bar can sit below the fold (header + properties + editor above the
  // view) — mouse coordinates only hit what's inside the viewport.
  await bar.scrollIntoViewIfNeeded();
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
