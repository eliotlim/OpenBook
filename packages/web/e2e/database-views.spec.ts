import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {newPage} from './seed';

// Per-test workspace reset: each test builds a fresh database and some seed
// fixed row titles, so a clean workspace before each test keeps them
// collision-free without manual name reclamation.
test.use({freshWorkspace: true});

/** Create a fresh database via the command palette and wait for its view. */
async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  // A wiped (freshWorkspace) workspace lands on Home; wait for it to hydrate.
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

// A formula column computes from another property (here the row title) — the
// headline "simple expression formula" feature, end to end.
test('database formula: a formula column computes from other properties', {tag: ['@database', '@visual', '@p1']}, async ({page}, testInfo) => {
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
test('database views: board, gallery, and bar chart layouts render', {tag: ['@database', '@visual', '@p1']}, async ({page}, testInfo) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  // Board view (in the default schema) shows kanban columns from the Status select.
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: kanban board

  // Add a Gallery view from the add-view menu.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Gallery'}).click();
  await expect(page.getByRole('button', {name: 'New row'})).toBeVisible();

  // Add a Bar chart view; with a grouped property it draws a bar per group.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Bar chart'}).click();
  await expect(page.getByText('No value', {exact: true})).toBeVisible();
});

// The bar chart is interactive: a readout, click-to-drill into a bar's rows, and
// a second-level "Break down by" control in the view options.
test('database bar chart: drill-down and breakdown control', {tag: ['@database', '@visual']}, async ({page}, testInfo) => {
  await newDatabase(page);

  // A named row so it's identifiable once we drill into the chart. The name is
  // run-tagged so a bare 'Alpha' can't make locators ambiguous against the row
  // database-context-menu.spec seeds earlier in the suite (names aren't unique).
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
test('database summaries: a column footer calculation renders', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();

  // Set the Name column footer summary to "Count all" → shows the row count.
  await page.locator('tfoot button').first().click();
  await page.getByRole('menuitem', {name: 'Count all'}).click();
  await expect(page.locator('tfoot').getByText('2', {exact: true})).toBeVisible();
});

// The quick-search box filters the active view's rows.
test('database quick search: filters rows by text', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  // Run-tagged so a bare 'Findme' can't collide with database-parity.spec's row.
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

// Switching a database's view is addressable in the URL (`?view=`), so a chosen
// board/timeline is shareable and survives a reload (URL over localStorage).
test('database view in URL: switching reflects ?view= and a deep link restores it', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  // The plain (no ?view=) load opens the default Table view.
  await expect(page).not.toHaveURL(/[?&]view=/);

  // Switch to the Board view → the id lands in the URL alongside ?page=.
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=/);
  const boardUrl = page.url();

  // Navigating away drops the now-stale ?view= (it named the db's view).
  await page.goto('/');
  await expect(page).not.toHaveURL(/[?&]view=/);

  // Opening the captured link lands straight back on the Board view.
  await page.goto(boardUrl);
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=/);
});

// A `?view=` that names no real view of the database is ignored: the db opens on
// its default (Table) view with no flash of a wrong layout, and the garbage param
// is scrubbed from the URL so it can't linger on a copied link.
test('database view in URL: an invalid ?view= scrubs to the default view', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  const pageId = new URL(page.url()).searchParams.get('page');
  expect(pageId).toBeTruthy();

  // Deep-link the db page with a bogus view id.
  await page.goto(`/?page=${pageId}&view=not-a-real-view`);

  // It settles on the default Table view (a <table>; Board/Gallery have none) and
  // the unresolvable param is dropped from the URL.
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]view=/);
});

// Per-db last-view memory (localStorage) still works with no param: a plain reopen
// (no `?view=`) restores the last-used view, and because it came from memory — not
// a deep link — the URL stays clean (no `?view=` written back).
test('database view in URL: a plain reopen restores the last view from localStorage', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  const plainUrl = page.url(); // ?page=<id>, no ?view=
  await expect(page).not.toHaveURL(/[?&]view=/);

  // Switch to Board (records it as the db's last-used view).
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();

  // Reopen the bare page URL: memory restores Board, and no ?view= is written.
  await page.goto('/');
  await page.goto(plainUrl);
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]view=/);
});

// `?view=` is scoped to the primary pane's page-level database. A database opened
// in the split pane opts out entirely: switching its view never writes ?view=, so
// it can't fight the primary page for the param.
test('database view in URL: a split-pane database never writes ?view=', {tag: ['@database']}, async ({page, request}) => {
  await newDatabase(page);
  const dbPageId = new URL(page.url()).searchParams.get('page');
  expect(dbPageId).toBeTruthy();

  // A plain primary document, with the database docked in the split pane.
  const primary = await newPage(request, 'Split Primary Doc');
  await page.goto(`/?page=${primary}&split=${dbPageId}`);
  const pane = page.locator('[data-split-pane]');
  await expect(pane).toBeVisible();

  // Switch the split-pane database's view: it renders Board, but the URL keeps
  // only ?page=&split= — a non-primary database never owns ?view=.
  await pane.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(pane.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]view=/);
});

// Inline-database embedding (linking an existing database into a document) is
// covered by database-parity.spec.ts ("linked database block").
