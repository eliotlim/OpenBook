import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {reclaimNames} from './seed';

/** Create a fresh database via the command palette and wait for its view. */
async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

// A formula column computes from another property (here the row title) — the
// headline "simple expression formula" feature, end to end.
test('database formula: a formula column computes from other properties', async ({page, request}, testInfo) => {
  await reclaimNames(request, 'World'); // row titles are workspace-unique; free it for reruns
  await newDatabase(page);

  // Add a formula column that greets the row's title.
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Greeting');
  await chooseValue(page, page.getByLabel('Property type'), 'formula');
  // The page title is also a textarea now — target the formula source field.
  await page.getByPlaceholder(/prop\(/).fill('concat("Hi ", Name)');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Greeting', {exact: true})).toBeVisible();

  // Add a row and name it; the formula cell recomputes to "Hi World".
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('World');
  await title.blur();

  await expect(page.getByRole('table').getByText('Hi World')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: a computed formula column
});

// The view switcher offers the new layouts and they render without error.
test('database views: board, gallery, and bar chart layouts render', async ({page}, testInfo) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  // Board view (in the default schema) shows kanban columns from the Status select.
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: kanban board

  // Add a Gallery view from the add-view menu.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Gallery'}).click();
  await expect(page.getByRole('button', {name: 'New card'})).toBeVisible();

  // Add a Bar chart view; with a grouped property it draws a bar per group.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Bar chart'}).click();
  await expect(page.getByText('No value', {exact: true})).toBeVisible();
});

// The bar chart is interactive: a readout, click-to-drill into a bar's rows, and
// a second-level "Break down by" control in the view options.
test('database bar chart: drill-down and breakdown control', async ({page}, testInfo) => {
  await newDatabase(page);

  // A named row so it's identifiable once we drill into the chart. The name is
  // run-tagged: page names are globally unique, so a bare 'Alpha' 409s against
  // the row database-context-menu.spec seeds earlier in the suite.
  const alpha = `Alpha ${Date.now()}`;
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill(alpha);
  await title.blur();

  // Switch to a Bar chart (groups by Status; the row has none → a "No value" bar).
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Bar chart'}).click();
  await expect(page.getByText('No value', {exact: true})).toBeVisible();

  // The readout strip shows the measure and the grand total.
  await expect(page.getByText('Count', {exact: true})).toBeVisible();
  await expect(page.getByText('Total 1')).toBeVisible();

  // Clicking the bar drills into its rows; the panel lists the underlying row.
  await page.getByRole('button', {name: /No value: 1/}).click();
  await expect(page.getByRole('button', {name: 'Close drill-down'})).toBeVisible();
  await expect(page.getByRole('button', {name: alpha})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: interactive bar chart + drill-down

  // The view options expose the second-level breakdown control.
  await page.getByRole('button', {name: 'View options'}).click();
  await expect(page.getByText('Break down by')).toBeVisible();
});

// A table column footer can summarise its values (here, a row count).
test('database summaries: a column footer calculation renders', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();

  // Set the Name column footer summary to "Count all" → shows the row count.
  await page.locator('tfoot button').first().click();
  await page.getByRole('menuitem', {name: 'Count all'}).click();
  await expect(page.locator('tfoot').getByText('2', {exact: true})).toBeVisible();
});

// The quick-search box filters the active view's rows.
test('database quick search: filters rows by text', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  // Run-tagged: a bare 'Findme' 409s against database-parity.spec's row.
  const findme = `Findme ${Date.now()}`;
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill(findme);
  await title.blur();

  // A non-matching query empties the view.
  await page.getByRole('textbox', {name: 'Search rows'}).fill('zzz');
  await expect(page.getByText('No rows match the current view')).toBeVisible();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(0);

  // A matching query brings the row back.
  await page.getByRole('textbox', {name: 'Search rows'}).fill('Findme ');
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(1);
});

// Inline-database embedding (linking an existing database into a document) is
// covered by database-parity.spec.ts ("linked database block").
