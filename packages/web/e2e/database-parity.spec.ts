// Behavioural (non-visual) tests — use plain Playwright to skip the Chromatic
// per-test snapshot (its archive helper is flaky in headless CI runs).
import {test, expect, chooseValue, chooseLabel} from './fixtures';
import {readFileSync} from 'node:fs';
import {reclaimNames} from './seed';

// Every test creates its own database (newDatabase) or seeds under a
// Date.now()-unique name, and fixed row names are reclaimed per test — so the
// file (40 tests, the suite's longest by far) fans out across workers.
test.describe.configure({mode: 'parallel'});

async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

/** Click "New row" n times, letting the create→refetch churn settle between
 *  clicks. Back-to-back clicks land while the table remounts and the second
 *  one is swallowed — rows then never reach nth(1) (flaky under load). */
async function addRows(page: import('@playwright/test').Page, n: number): Promise<void> {
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  const start = await titles.count();
  for (let i = 1; i <= n; i += 1) {
    await page.getByRole('button', {name: 'New row'}).click();
    await expect(titles).toHaveCount(start + i);
  }
}

async function addColumn(page: import('@playwright/test').Page, name: string, type: string): Promise<void> {
  await page.getByRole('button', {name: 'Add column'}).click();
  const popover = page.locator('[data-radix-popper-content-wrapper]');
  // Pick the type first (numeric types add a format select, re-rendering the
  // popover), then fill the name and submit with Enter. Submitting via the name
  // field's keydown avoids clicking the "Add property" button while the popover
  // is still animating into place — that race left the click waiting forever.
  await chooseValue(page, popover.getByLabel('Property type'), type);
  await expect(popover.getByLabel('Property type')).toHaveAttribute('data-value', type);
  const nameField = popover.getByPlaceholder('Property name');
  await nameField.fill(name);
  await nameField.press('Enter');
  await expect(page.getByText(name, {exact: true})).toBeVisible();
}

// A status property edits via a grouped dropdown (To-do / In progress / Complete).
test('status property: grouped option dropdown', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Stage', 'status');
  await page.getByRole('button', {name: 'New row'}).click();

  // The Stage cell is the last "Empty" button (after the default Status select).
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).last().click();
  await expect(page.getByRole('menuitem', {name: 'In progress'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'In progress'}).click();
  await expect(page.getByRole('table').getByText('In progress')).toBeVisible();
});

// A rollup property aggregates over a relation. Adding the rollup after a
// dependency column defaults it to counting that dependency — no config needed.
test('rollup property: counts related rows', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Links', 'dependency');
  await addColumn(page, 'Count', 'rollup');

  await addRows(page, 2);

  // Link the second row to the first → its rollup count becomes 1.
  await page.getByRole('button', {name: 'Add dependency'}).nth(1).click();
  await expect(page.getByPlaceholder('Depends on…')).toBeVisible();
  await page.locator('[data-radix-popper-content-wrapper] button').first().click();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('table').getByText('1', {exact: true})).toBeVisible();
});

// Dragging a row between days on the calendar reschedules its date.
test('calendar drag: reschedule a row by dragging to another day', async ({page, request}) => {
  await reclaimNames(request, 'Event'); // typed row titles are workspace-unique; free them for reruns
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');
  await page.getByRole('button', {name: 'New row'}).click();

  // Name the row and date it the 10th of the current month.
  const now = new Date();
  const onDay = (d: number) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Event');
  await title.blur();
  await page.getByLabel('Due').first().fill(onDay(10));

  // Open a calendar view (shows the current month) and drag the pill to day 15.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Calendar'}).click();
  const pill = page.locator('[draggable="true"]:not([role])').filter({hasText: 'Event'});
  await expect(pill).toBeVisible();
  // Dispatch HTML5 drag events directly (the handlers use React state, not
  // dataTransfer); awaited dispatches let React re-render between them.
  await pill.dispatchEvent('dragstart');
  await expect(pill).toHaveClass(/opacity-40/); // wait for the drag state to apply
  await page.locator(`[data-day-key="${onDay(15)}"]`).dispatchEvent('dragover');
  await page.locator(`[data-day-key="${onDay(15)}"]`).dispatchEvent('drop');
  await pill.dispatchEvent('dragend');

  // Back in the table, the date moved to the 15th (dated cells render as
  // text; click to reveal the native input).
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await page.getByLabel('Due').first().click();
  await expect(page.getByLabel('Due').first()).toHaveValue(onDay(15));
});

// Dragging a kanban column header reorders the group property's options.
test('board column reorder: drag a kanban column', async ({page}) => {
  await newDatabase(page); // default Board view groups by Status (Todo / In progress / Done)
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // Columns start ordered Todo · In progress · Done.
  const cols = page.locator('[data-col-key]');
  await expect(cols.first()).toContainText('Todo');

  await cols.filter({hasText: 'Done'}).dispatchEvent('dragstart');
  await cols.filter({hasText: 'Todo'}).dispatchEvent('dragover');
  await cols.filter({hasText: 'Todo'}).dispatchEvent('drop');
  await cols.filter({hasText: 'Done'}).dispatchEvent('dragend');

  // "Done" moved to the front.
  await expect(cols.first()).toContainText('Done');
});

// Dragging a column header reorders the database's columns.
test('column reorder: drag a column header', async ({page}) => {
  await newDatabase(page); // default columns: Status, Notes
  // Header order is Name · Status · Notes · (Add column).
  await expect(page.getByRole('columnheader').nth(1)).toContainText('Status');

  const status = page.getByRole('columnheader', {name: /Status/});
  const notes = page.getByRole('columnheader', {name: /Notes/});
  await notes.dispatchEvent('dragstart');
  await status.dispatchEvent('dragover');
  await status.dispatchEvent('drop');
  await notes.dispatchEvent('dragend');

  // Notes moved before Status.
  await expect(page.getByRole('columnheader').nth(1)).toContainText('Notes');
});

// Exporting a view downloads its rows as CSV.
test('export CSV: downloads the view rows', async ({page, request}) => {
  await reclaimNames(request, 'CsvRow');
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('CsvRow');
  await title.blur();

  await page.getByRole('button', {name: 'View options'}).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', {name: 'Export CSV'}).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const content = readFileSync((await download.path())!, 'utf8');
  expect(content.split('\n')[0]).toMatch(/^Name,/);
  expect(content).toContain('CsvRow');
});

// Importing a CSV creates rows, mapping columns by name (here the default Notes).
test('import CSV: creates rows from a file', async ({page, request}) => {
  await reclaimNames(request, 'Alpha', 'Beta'); // the CSV names rows; creation 409s if they're taken
  await newDatabase(page);

  await page.getByRole('button', {name: 'View options'}).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', {name: 'Import CSV'}).click(),
  ]);
  await chooser.setFiles({
    name: 'data.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Notes\nAlpha,first\nBeta,second'),
  });

  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveValue('Alpha');
  await expect(titles.nth(1)).toHaveValue('Beta');
});

// The row menu can duplicate a row (title + properties + content).
test('duplicate row: copies a row', async ({page, request}) => {
  await reclaimNames(request, 'Original', 'Original (copy)');
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Original');
  await title.blur();

  await page.getByRole('button', {name: 'Row actions'}).first().click();
  await page.getByRole('menuitem', {name: 'Duplicate'}).click();

  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveValue('Original');
  await expect(titles.nth(1)).toHaveValue('Original (copy)');
});

// A row can nest sub-items, which expand/collapse in the table.
test('sub-items: nest a row and collapse it', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  // Add a sub-item under the row (hover affordance on the title cell).
  await page.getByRole('button', {name: 'Add sub-item'}).first().click();
  await expect(page.getByRole('button', {name: 'Collapse sub-items'})).toBeVisible();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(2);

  // Collapsing the parent hides the sub-item.
  await page.getByRole('button', {name: 'Collapse sub-items'}).click();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(1);
});

// NOTE: the inline "Link to database" embed (block editor slash → link picker →
// existing database) is not covered here yet — it needs a block-editor-native
// e2e against a server page. The feature itself is unchanged by the classic
// editor's retirement; only the old EditorJS inline-database insertion is gone.

// A files & media property holds URLs (rendered as chips / image thumbnails).
test('files property: add a file URL', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Media', 'files');
  await page.getByRole('button', {name: 'New row'}).click();

  await page.getByRole('table').getByRole('button', {name: 'Add file'}).first().click();
  await page.getByPlaceholder('Image or file URL…').fill('https://example.com/report.pdf');
  await page.getByRole('button', {name: 'Add file URL'}).click();

  await expect(page.getByRole('table').getByText('report.pdf')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Remove file'})).toBeVisible();
});

// Filters combine as an OR group across two conditions.
test('filter groups: OR across two conditions', async ({page, request}) => {
  await reclaimNames(request, 'Apple', 'Banana');
  await newDatabase(page);
  await addRows(page, 2);
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await titles.nth(0).fill('Apple');
  await titles.nth(0).blur();
  await titles.nth(1).fill('Banana');
  await titles.nth(1).blur();

  await page.getByRole('button', {name: /^Filter/}).click();
  await page.getByRole('button', {name: 'Any', exact: true}).click();
  const values = page.locator('[data-radix-popper-content-wrapper] input[placeholder="value"]');
  await page.getByRole('button', {name: 'Condition', exact: true}).click();
  await expect(values).toHaveCount(1);
  await page.getByRole('button', {name: 'Condition', exact: true}).click();
  await expect(values).toHaveCount(2);

  // Both conditions default to Title · contains; target each row.
  await values.nth(0).fill('Apple');
  await expect(values.nth(0)).toHaveValue('Apple');
  await values.nth(1).fill('Banana');
  await expect(values.nth(1)).toHaveValue('Banana');
  await page.keyboard.press('Escape');

  // OR keeps both rows; the badge counts two conditions.
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(2);
  await expect(page.getByRole('button', {name: 'Filter (2)'})).toBeVisible();
});

// A two-way dependency mirrors links onto a generated partner property:
// linking A → B from A's column auto-populates B's "(related)" column.
test('two-way dependency: linking one side populates the inverse', async ({page, request}) => {
  await reclaimNames(request, 'Task A', 'Task B');
  await newDatabase(page);
  await addColumn(page, 'Blocks', 'dependency');

  // Promote the dependency to two-way → spawns a "Blocks (related)" column.
  await page.getByRole('columnheader', {name: 'Blocks Property options'}).getByLabel('Property options').click();
  await page.getByRole('button', {name: 'Make two-way'}).click();
  await page.keyboard.press('Escape'); // close the property menu
  await expect(page.getByRole('columnheader', {name: /Blocks \(related\)/})).toBeVisible();

  // Two named rows. Let the create→refetch churn settle before typing into
  // the second title — filling mid-churn waits on a remounting input until
  // the timeout (the long-standing dependency-picker flake family).
  await addRows(page, 2);
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(2);
  await titles.nth(0).fill('Task A');
  await titles.nth(0).blur();
  await titles.nth(1).fill('Task B');
  await titles.nth(1).blur();

  // From Task A's Blocks cell, depend on Task B (first "Add dependency" = row 0, col Blocks).
  await page.getByRole('button', {name: 'Add dependency'}).nth(0).click();
  await expect(page.getByPlaceholder('Depends on…')).toBeVisible();
  await page.locator('[data-radix-popper-content-wrapper]').getByRole('button', {name: 'Task B'}).click();
  await page.keyboard.press('Escape');

  // The inverse appears: Task B's "(related)" cell now lists Task A.
  await expect(page.getByRole('table').getByText('Task A', {exact: true})).toBeVisible();
  await expect(page.getByRole('table').getByText('Task B', {exact: true})).toBeVisible();
});

// A number property can render "as a bar": the cell pairs its input with a
// progress track filled relative to the target (default 100).
test('number show-as-bar: renders a progress fill scaled to the value', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Score', 'number');

  // Switch the Score column to "Show as Bar".
  await page.getByRole('columnheader', {name: 'Score Property options'}).getByLabel('Property options').click();
  await chooseValue(page, page.getByLabel('Show number as'), 'bar');
  await page.keyboard.press('Escape');

  // A row scored 50/100 → the bar fills to 50%.
  await page.getByRole('button', {name: 'New row'}).click();
  const cell = page.getByRole('table').getByLabel('Score');
  await cell.fill('50');
  await cell.blur();

  const fill = page.locator('[data-number-display="bar"] [style*="width"]');
  await expect(fill).toBeVisible();
  await expect(fill).toHaveAttribute('style', /width:\s*50%/);
});

// Saving a row as a template lets a later "New ▾" recreate its property values.
test('row templates: save a row as a template and create from it', async ({page, request}) => {
  await reclaimNames(request, 'Bug report');
  await newDatabase(page);
  await addColumn(page, 'Priority', 'number');

  // A row named "Bug report" with Priority 3.
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Bug report');
  await title.blur();
  const priority = page.getByRole('table').getByLabel('Priority');
  await priority.fill('3');
  await priority.blur();

  // Save it as a template via the row menu.
  await page.getByRole('button', {name: 'Row actions'}).click();
  await page.getByRole('menuitem', {name: 'Save as template'}).click();

  // The toolbar gains a "New from template" caret; create a row from the template.
  await page.getByRole('button', {name: 'New from template'}).click();
  await page.getByRole('menuitem', {name: 'Bug report'}).click();

  // A second row exists and inherited Priority 3.
  const priorities = page.getByRole('table').getByLabel('Priority');
  await expect(priorities).toHaveCount(2);
  await expect(priorities.nth(1)).toHaveValue('3');
});

// A grouped table shows each group's own calculation, not just one table total.
test('per-group summaries: each group footer shows its own sum', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Amount', 'number');

  // Two rows with amounts in two different Status groups (Todo / Done).
  await addRows(page, 2);
  const amounts = page.getByRole('table').getByLabel('Amount');
  await amounts.nth(0).fill('10');
  await amounts.nth(0).blur();
  await amounts.nth(1).fill('5');
  await amounts.nth(1).blur();

  // Status is a select with preset options; assign Todo to row 1, Done to row 2.
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).first().click();
  await page.getByRole('menuitem', {name: 'Todo'}).click();
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).first().click();
  await page.getByRole('menuitem', {name: 'Done'}).click();

  // Group the table by Status.
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseLabel(page, page.getByLabel('Group by'), 'Status');
  await page.keyboard.press('Escape');

  // Set the Amount column's footer calculation to Sum (last footer picker).
  await page.locator('tfoot button').filter({hasText: 'Calculate'}).last().click();
  await page.getByRole('menuitem', {name: 'Sum', exact: true}).click();

  // Each group footer sums only its own rows (10 and 5); the table total is 15.
  // Both the group footer and the table footer can show the sum — assert
  // the per-group cell specifically.
  await expect(page.getByRole('table').locator('td').filter({hasText: /^10$/})).toBeVisible();
  await expect(page.getByRole('table').getByText('5', {exact: true})).toBeVisible();
  await expect(page.locator('tfoot').getByText('15', {exact: true})).toBeVisible();
});

// A unique_id column auto-numbers rows — backfilling existing ones — and renders
// with the configured prefix (TASK-1, TASK-2…).
test('unique id: auto-numbers rows with a prefix', async ({page}) => {
  await newDatabase(page);

  // Two rows exist before the ID column is added.
  await addRows(page, 2);

  // Adding the unique_id column backfills both rows (1, 2).
  await addColumn(page, 'Ref', 'unique_id');

  // Give it a prefix → cells read TASK-1 / TASK-2.
  await page.getByRole('columnheader', {name: 'Ref Property options'}).getByLabel('Property options').click();
  await page.getByLabel('ID prefix').fill('TASK');
  await page.getByLabel('ID prefix').blur();
  await page.keyboard.press('Escape');

  await expect(page.getByRole('table').getByText('TASK-1', {exact: true})).toBeVisible();
  await expect(page.getByRole('table').getByText('TASK-2', {exact: true})).toBeVisible();

  // A newly-added row continues the sequence (TASK-3).
  await page.getByRole('button', {name: 'New row'}).click();
  await expect(page.getByRole('table').getByText('TASK-3', {exact: true})).toBeVisible();
});

// Select options can be reordered by dragging their handle; order drives the
// dropdown list and the board's kanban columns.
test('reorder select options: drag an option to the top', async ({page}) => {
  await newDatabase(page); // default Status select: Todo · In progress · Done

  await page.getByRole('columnheader', {name: 'Status Property options'}).getByLabel('Property options').click();
  const popover = page.locator('[data-radix-popper-content-wrapper]');
  const rows = popover.locator('[data-opt-key]');
  const handles = popover.getByLabel('Reorder option');
  await expect(rows.first().locator('input')).toHaveValue('Todo');

  // Drag "Done" (3rd handle) onto the "Todo" row (1st).
  await handles.nth(2).dispatchEvent('dragstart');
  await expect(rows.nth(2)).toHaveClass(/opacity-40/); // drag state applied
  await rows.nth(0).dispatchEvent('dragover');
  await rows.nth(0).dispatchEvent('drop');
  await handles.nth(2).dispatchEvent('dragend');

  // "Done" is now first.
  await expect(rows.first().locator('input')).toHaveValue('Done');
});

// Kanban columns can be collapsed to a narrow strip and expanded again.
test('board column collapse: fold and unfold a kanban column', async ({page}) => {
  await newDatabase(page); // default Board view groups by Status (Todo / In progress / Done)
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // Collapse the Todo column → its expand affordance appears, collapse one goes.
  await page.getByRole('button', {name: 'Collapse Todo column'}).click();
  await expect(page.getByRole('button', {name: 'Expand Todo column'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Collapse Todo column'})).toHaveCount(0);

  // Expand it again.
  await page.getByRole('button', {name: 'Expand Todo column'}).click();
  await expect(page.getByRole('button', {name: 'Collapse Todo column'})).toBeVisible();
});

// "Hide empty groups" drops grouped columns/sections that currently have no rows.
test('hide empty groups: empty Status groups disappear when toggled', async ({page}) => {
  await newDatabase(page); // Status select: Todo / In progress / Done

  // One row in the Todo group; the other two stay empty.
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).first().click();
  await page.getByRole('menuitem', {name: 'Todo'}).click();

  // Group the table by Status → three group headers, two of them empty.
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseLabel(page, page.getByLabel('Group by'), 'Status');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByText('In progress')).toBeVisible();
  await expect(page.getByRole('table').getByText('Done')).toBeVisible();

  // Hide empty groups → only Todo (the non-empty group) remains.
  await page.getByRole('button', {name: 'View options'}).click();
  await page.getByText('Hide empty groups').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Todo 1'})).toBeVisible(); // Todo group header (label + count)
  await expect(page.getByRole('table').getByText('In progress')).toHaveCount(0);
  await expect(page.getByRole('table').getByText('Done')).toHaveCount(0);
});

// A date property can "Include time", switching its cell to a datetime input
// that stores YYYY-MM-DDTHH:mm.
test('date include time: cell becomes a datetime input', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'When', 'date');

  // Turn on "Include time" for the When column.
  await page.getByRole('columnheader', {name: 'When Property options'}).getByLabel('Property options').click();
  await page.getByText('Include time').click();
  await page.keyboard.press('Escape');

  // The cell now accepts a date *and* time.
  await page.getByRole('button', {name: 'New row'}).click();
  const cell = page.getByRole('table').getByLabel('When');
  await expect(cell).toHaveAttribute('type', 'datetime-local');
  await cell.fill('2026-06-09T14:30');
  await expect(cell).toHaveValue('2026-06-09T14:30');
});

// A gallery's card size (Small / Medium / Large) changes the grid track width.
test('gallery card size: switches the card grid width', async ({page}) => {
  await newDatabase(page);

  // Open a gallery view (defaults to medium cards). The empty grid has no height,
  // so assert the track class is applied rather than its visibility.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Gallery'}).click();
  await expect(page.locator('[class*="minmax(210px"]')).toHaveCount(1);

  // Switch to Large → the grid track widens.
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseValue(page, page.getByLabel('Card size'), 'large');
  await page.keyboard.press('Escape');
  await expect(page.locator('[class*="minmax(300px"]')).toHaveCount(1);
  await expect(page.locator('[class*="minmax(210px"]')).toHaveCount(0);
});

// Clicking a day's "+" on the calendar creates a row dated to that day.
test('calendar quick-add: click a day to create a dated row', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  // Open a calendar view (auto-bound to the Due date property).
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Calendar'}).click();

  const now = new Date();
  const onDay = (d: number) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  await page.getByRole('button', {name: `Add on ${onDay(12)}`}).click();

  // Back in the table, the new row carries that date (dated cells render as
  // text; click to reveal the native input).
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await page.getByRole('table').getByLabel('Due').click();
  await expect(page.getByRole('table').getByLabel('Due')).toHaveValue(onDay(12));
});

// The Name column is frozen (sticky) so it stays put when a wide table scrolls.
test('frozen name column: the Name header and cells are sticky', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  const nameHeader = page.getByRole('columnheader', {name: 'Name'});
  await expect(nameHeader).toHaveCSS('position', 'sticky');
  await expect(nameHeader).toHaveCSS('left', '0px');

  // The row's title cell is sticky too (it holds the Untitled title input).
  const titleCell = page.getByRole('table').getByPlaceholder('Untitled').first().locator('xpath=ancestor::td');
  await expect(titleCell).toHaveCSS('position', 'sticky');
});

// The list view can be grouped, like the table — rows fall under group headers.
test('list view grouping: group a list by Status', async ({page, request}) => {
  await reclaimNames(request, 'ListGroupRow');
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  // A name no other test uses — page names are workspace-unique across the run.
  await title.fill('ListGroupRow');
  await title.blur();
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).first().click();
  await page.getByRole('menuitem', {name: 'Todo'}).click();

  // Switch to the List view and group it by Status.
  await page.getByRole('button', {name: 'List', exact: true}).click();
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseLabel(page, page.getByLabel('Group by'), 'Status');
  await page.keyboard.press('Escape');

  // A Todo group header (label + count) now wraps the row.
  await expect(page.getByRole('button', {name: 'Todo 1'})).toBeVisible();
  await expect(page.getByText('ListGroupRow')).toBeVisible();
});

// Renaming a row to a name that already exists (workspace names are unique) is
// handled gracefully — the title reverts instead of crashing the app.
test('duplicate rename: reverts instead of crashing', async ({page, request}) => {
  await reclaimNames(request, 'UniqueTitleX'); // row 0 must be able to claim it; row 1's clash is the test
  await newDatabase(page);
  await addRows(page, 2);
  const titles = page.getByRole('table').getByPlaceholder('Untitled');

  // First row claims a unique name.
  await titles.nth(0).fill('UniqueTitleX');
  await titles.nth(0).blur();
  await expect(titles.nth(0)).toHaveValue('UniqueTitleX');

  // Second row tries to take the same name → server 409s.
  await titles.nth(1).fill('UniqueTitleX');
  await titles.nth(1).blur();

  // No runtime-error overlay, and the second row's title reverts to empty.
  await expect(titles.nth(1)).toHaveValue('');
  await expect(page.getByRole('dialog', {name: 'Runtime Error'})).toHaveCount(0);
});

// View tabs can be dragged to reorder them.
test('reorder view tabs: drag a view tab to the front', async ({page}) => {
  await newDatabase(page); // default views: Table · Board · List
  const tabs = page.locator('[data-view-tab]');
  await expect(tabs.first()).toContainText('Table');

  // Drag the List tab onto the Table tab → List moves to the front.
  const list = page.getByRole('button', {name: 'List', exact: true});
  await list.dispatchEvent('dragstart');
  await expect(list).toHaveClass(/opacity-40/); // drag state applied
  const table = page.getByRole('button', {name: 'Table', exact: true});
  await table.dispatchEvent('dragover');
  await table.dispatchEvent('drop');
  await list.dispatchEvent('dragend');

  await expect(tabs.first()).toContainText('List');
});

// A column header menu can sort the view by that column ascending/descending.
test('column header sort: sort ascending from the property menu', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Num', 'number');

  // Two rows out of order: 2 then 1.
  await addRows(page, 2);
  const nums = page.getByRole('table').getByLabel('Num');
  await nums.nth(0).fill('2');
  await nums.nth(0).blur();
  await nums.nth(1).fill('1');
  await nums.nth(1).blur();

  // Sort ascending from the Num column menu.
  await page.getByRole('columnheader', {name: 'Num Property options'}).getByLabel('Property options').click();
  await page.getByRole('button', {name: 'Sort asc'}).click();

  // Rows reorder so the smallest is first.
  await expect(page.getByRole('table').getByLabel('Num').nth(0)).toHaveValue('1');
  await expect(page.getByRole('table').getByLabel('Num').nth(1)).toHaveValue('2');
});

// A number column can use a Pound (£) format, shown in read-only displays.
test('currency format: pound shows in the summary footer', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Price', 'number');

  // Set the Price column's number format to Pound (£).
  await page.getByRole('columnheader', {name: 'Price Property options'}).getByLabel('Property options').click();
  const popover = page.locator('[data-radix-popper-content-wrapper]');
  await chooseValue(page, popover.getByLabel('Number format'), 'pound');
  await page.keyboard.press('Escape');

  // A row priced 10, then sum the column in the footer.
  await page.getByRole('button', {name: 'New row'}).click();
  const price = page.getByRole('table').getByLabel('Price');
  await price.fill('10');
  await price.blur();
  await page.locator('tfoot button').filter({hasText: 'Calculate'}).last().click();
  await page.getByRole('menuitem', {name: 'Sum', exact: true}).click();

  await expect(page.locator('tfoot').getByText('£10.00')).toBeVisible();
});

// "Hide in view" from a column's menu removes that column from the table.
test('hide column in view: removes the column header', async ({page}) => {
  await newDatabase(page); // default columns: Status, Notes
  await expect(page.getByRole('columnheader', {name: /Notes/})).toBeVisible();

  await page.getByRole('columnheader', {name: 'Notes Property options'}).getByLabel('Property options').click();
  await page.getByRole('button', {name: 'Hide in view'}).click();

  // Notes is gone from the header; Status remains.
  await expect(page.getByRole('columnheader', {name: /Notes/})).toHaveCount(0);
  await expect(page.getByRole('columnheader', {name: /Status/})).toBeVisible();
});

// Rows can be multi-selected and deleted in bulk from the selection bar.
test('bulk select: delete multiple rows at once', async ({page}) => {
  await newDatabase(page);
  await addRows(page, 3);
  await expect(page.getByRole('table').getByLabel('Select row')).toHaveCount(3);

  // Select two rows → the selection bar appears.
  await page.getByRole('table').getByLabel('Select row').nth(0).check();
  await page.getByRole('table').getByLabel('Select row').nth(1).check();
  await expect(page.getByText('2 selected')).toBeVisible();

  // Bulk delete leaves one row and clears the selection.
  await page.getByRole('button', {name: 'Delete'}).click();
  await expect(page.getByRole('table').getByLabel('Select row')).toHaveCount(1);
  await expect(page.getByText('2 selected')).toHaveCount(0);
});

// "Duplicate property" clones a column (config + position) as "<name> copy".
test('duplicate property: clones a column next to it', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Budget', 'number');

  await page.getByRole('columnheader', {name: 'Budget Property options'}).getByLabel('Property options').click();
  await page.getByRole('button', {name: 'Duplicate property'}).click();

  // A "Budget copy" column now exists alongside the original.
  await expect(page.getByRole('columnheader', {name: /Budget copy/})).toBeVisible();
  await expect(page.getByRole('columnheader', {name: /^Budget Property options$/})).toBeVisible();
});

// The selection bar can duplicate the selected rows in bulk.
test('bulk duplicate: copies the selected rows', async ({page}) => {
  await newDatabase(page);
  await addRows(page, 2);
  await expect(page.getByRole('table').getByLabel('Select row')).toHaveCount(2);

  // Select both and duplicate → four rows total.
  await page.getByRole('table').getByLabel('Select all rows').check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', {name: 'Duplicate'}).click();

  await expect(page.getByRole('table').getByLabel('Select row')).toHaveCount(4);
});

// A sorted column shows a direction indicator in its header (data-sort hook).
test('sort indicator: header reflects the active sort direction', async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Score', 'number');

  // No sort yet.
  await expect(page.locator('th[data-sort="asc"]')).toHaveCount(0);

  // Sort the Score column descending from its menu.
  await page.getByRole('columnheader', {name: 'Score Property options'}).getByLabel('Property options').click();
  await page.getByRole('button', {name: 'Sort desc'}).click();

  // The Score header now advertises a descending sort.
  await expect(page.locator('th[data-sort="desc"]')).toHaveCount(1);
  await expect(page.locator('th[data-sort="desc"]')).toContainText('Score');
});

// The selection bar can set a select/status value on all selected rows at once.
test('bulk set status: applies a value to selected rows', async ({page}) => {
  await newDatabase(page); // Status select: Todo / In progress / Done
  await addRows(page, 2);

  // Select both rows, then set Status → Done from the bar (Set property ▸ Status ▸ Done).
  await page.getByRole('table').getByLabel('Select all rows').check();
  await page.getByRole('button', {name: 'Set property'}).click();
  await page.getByRole('menuitem', {name: 'Status'}).click();
  await page.getByRole('menuitem', {name: 'Done'}).click();

  // Both Status cells now show Done.
  await expect(page.getByRole('table').getByText('Done')).toHaveCount(2);
});

// The toolbar count shows "X of Y" when a search/filter narrows the rows.
test('filtered row count: shows X of Y', async ({page, request}) => {
  await reclaimNames(request, 'Findme');
  await newDatabase(page);
  await addRows(page, 2);
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await titles.nth(0).fill('Findme');
  await titles.nth(0).blur();
  await expect(page.getByText('2 rows')).toBeVisible();

  // Searching for one row narrows the count.
  await page.getByLabel('Search rows').fill('Findme');
  await expect(page.getByText('1 of 2')).toBeVisible();
});

// A grouped table offers Collapse all / Expand all to fold every group at once.
test('collapse all groups: folds and unfolds every group', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('table').getByRole('button', {name: 'Empty'}).first().click();
  await page.getByRole('menuitem', {name: 'Todo'}).click();

  // Group by Status → one row under the Todo group.
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseLabel(page, page.getByLabel('Group by'), 'Status');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(1);

  // Collapse all hides the row; expand all brings it back.
  await page.getByRole('button', {name: 'Collapse all'}).click();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(0);
  await page.getByRole('button', {name: 'Expand all'}).click();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(1);
});

// "Insert below" from the row menu adds a row right after the chosen one.
test('insert row below: positions the new row after the source', async ({page, request}) => {
  await reclaimNames(request, 'RowOne', 'RowTwo');
  await newDatabase(page);
  await addRows(page, 2);
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await titles.nth(0).fill('RowOne');
  await titles.nth(0).blur();
  await titles.nth(1).fill('RowTwo');
  await titles.nth(1).blur();

  // Insert a row below RowOne via its menu (first row's actions).
  await page.getByRole('table').getByRole('button', {name: 'Row actions'}).first().click();
  await page.getByRole('menuitem', {name: 'Insert below'}).click();

  // Order is now RowOne, (new untitled), RowTwo.
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(3);
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(0)).toHaveValue('RowOne');
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(1)).toHaveValue('');
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(2)).toHaveValue('RowTwo');
});

// Double-clicking a view tab renames it inline.
test('rename view tab: double-click to rename', async ({page}) => {
  await newDatabase(page); // default views: Table · Board · List
  await page.getByRole('button', {name: 'Table', exact: true}).dblclick();

  const input = page.getByRole('textbox', {name: 'Rename view'});
  await expect(input).toBeVisible();
  await input.fill('Planning');
  await input.press('Enter');

  await expect(page.getByRole('button', {name: 'Planning', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toHaveCount(0);
});

// "Insert above" from the row menu adds a row right before the chosen one.
test('insert row above: positions the new row before the source', async ({page}) => {
  await newDatabase(page);
  await addRows(page, 2);
  // Run-tagged: page names are globally unique, so bare names 409 when the
  // suite reuses a dev server whose earlier runs created them.
  const tag = Date.now();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await titles.nth(0).fill(`First ${tag}`);
  await titles.nth(0).blur();
  await titles.nth(1).fill(`Second ${tag}`);
  await titles.nth(1).blur();

  // Insert above the second row (its menu = nth(1) actions).
  await page.getByRole('table').getByRole('button', {name: 'Row actions'}).nth(1).click();
  await page.getByRole('menuitem', {name: 'Insert above'}).click();

  // Order is now First, (new untitled), Second.
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(3);
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(0)).toHaveValue(`First ${tag}`);
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(1)).toHaveValue('');
  await expect(page.getByRole('table').getByPlaceholder('Untitled').nth(2)).toHaveValue(`Second ${tag}`);
});
