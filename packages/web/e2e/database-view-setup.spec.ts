import {test, expect, chooseLabel, chooseValue} from './fixtures';

// The view setup cards (OB view-setup UX): adding a Timeline / Calendar / Map /
// Graph view to a database without the property it lays rows out by used to
// dead-end on a prose hint. Now a setup card offers the fix itself — one
// disclosed click creates the typed property AND points the view at it — or an
// inline picker when a compatible property already exists.

// Per-test workspace reset: each test builds a fresh database (whose default
// schema has only a Status select + Notes text — no date/location/dependency).
test.use({freshWorkspace: true});

async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

/** Add a view of `type` and wait for the picker menu to fully close (its exit
 *  animation can eat the next click — see database-timeline.spec). */
async function addView(page: import('@playwright/test').Page, type: string): Promise<void> {
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: type}).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Add a view whose layout still needs a property, and wait for the View
 *  options popover to auto-open (add-view auto-config) — the deterministic
 *  sync point before interacting with the setup card behind it. Waits for the
 *  popover's own name input: the add-view menu's exit animation keeps its
 *  popper wrapper around, so a bare wrapper count can pass too early. The
 *  card click is an outside-pointerdown, so it dismisses the popover on its
 *  way. */
async function addUnconfiguredView(page: import('@playwright/test').Page, type: string): Promise<void> {
  await addView(page, type);
  await expect(page.getByLabel('View name')).toBeVisible();
}

/** Close the View-options popover by toggling its trigger, and wait for the
 *  teardown — Escape is unreliable right after a schema save re-renders the
 *  panel, and a lingering popover overlaps later clicks (its Layout grid has
 *  its own "Table" button that collides with the Table view tab). */
async function closeViewOptions(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', {name: 'View options'}).click();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
}

// Fresh DB → Add view → Timeline → ONE click creates a Date property, wires the
// view to it, and the dated canvas renders (the click-to-place first run).
test('timeline setup card: one click creates a Date property and renders the canvas', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addUnconfiguredView(page, 'Timeline');

  const create = page.getByRole('button', {name: 'Create a Date property and use it'});
  await expect(create).toBeVisible();
  await create.click();

  // The dated canvas replaces the card: today's marker + the first-run invite.
  await expect(page.getByText(/click anywhere on the timeline to add one/i)).toBeVisible();
  await expect(page.locator('div[title="Today"]')).toBeVisible();

  // The create click dismissed the auto-opened View options; wait out its
  // teardown — its Layout grid has its own "Table" button that would collide
  // with the Table view tab below.
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);

  // The property genuinely exists — it shows as a Table column.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Date/})).toBeVisible();
});

// Same one-click for the calendar (a plain date property → the month grid).
test('calendar setup card: one click creates a Date property and renders the month', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addUnconfiguredView(page, 'Calendar');

  await page.getByRole('button', {name: 'Create a Date property and use it'}).click();

  // The month grid renders (weekday header + the Today jump).
  await expect(page.getByText('Sun', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Today'})).toBeVisible();
});

// Same one-click for the map (location property → the map body mounts; with no
// coordinates yet it invites setting the new property on a row).
test('map setup card: one click creates a Location property', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addUnconfiguredView(page, 'Map');

  await page.getByRole('button', {name: 'Create a Location property and use it'}).click();
  await expect(page.getByText(/No rows have coordinates yet/)).toBeVisible();
});

// Same one-click for the graph (dependency property → the graph view mounts).
test('graph setup card: one click creates a Dependency property', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addUnconfiguredView(page, 'Graph');

  await page.getByRole('button', {name: 'Create a Dependency property and use it'}).click();
  await expect(page.getByText('No rows yet.')).toBeVisible();
});

// When a compatible property already exists, the card offers an inline picker
// instead of minting a duplicate column (chart group-by over the Status select).
test('chart setup card: picks an existing compatible property inline', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addView(page, 'Bar chart');

  // A fresh DB auto-groups the chart by its Status select; clear it to reach
  // the setup card with a compatible property present.
  await page.getByRole('button', {name: 'View options'}).click();
  await chooseLabel(page, page.getByLabel('Group by'), '—');
  await closeViewOptions(page);

  // The card offers the picker (not a bare create button); choosing Status
  // wires the view and the chart renders its groups.
  const picker = page.getByLabel('Chart group-by property');
  await expect(picker).toBeVisible();
  await chooseLabel(page, picker, 'Status');
  await expect(page.getByText('Total 0')).toBeVisible();
});

// The View-options selects carry the same one-step create as a "+ New …
// property" sentinel: on a date-less DB, Start date offers "+ New date
// property", which creates the property AND renders the timeline.
test('view options sentinel: "+ New date property" creates and wires the start date', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  // A date-less Timeline auto-opens View options (add-view auto-config), so
  // the Start date select is already on screen — no explicit open click.
  await addUnconfiguredView(page, 'Timeline');

  await chooseLabel(page, page.getByLabel('Start date'), '+ New date property');
  // A successful sentinel create closes the popover by itself, revealing the
  // freshly-configured view — no toggle-to-close dance needed.
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);

  await expect(page.getByText(/click anywhere on the timeline to add one/i)).toBeVisible();
  await expect(page.locator('div[title="Today"]')).toBeVisible();
});

// The dependency select (timeline/graph) sentinel mints a dependency column.
test('view options sentinel: "+ New dependency property" creates and wires dependencies', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  // A dependency-less Graph auto-opens View options (add-view auto-config).
  await addUnconfiguredView(page, 'Graph');

  await chooseLabel(page, page.getByLabel('Dependencies'), '+ New dependency property');
  // The sentinel create closes the popover on its own.
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);

  // The graph view mounts (no rows yet), and the column exists in the table
  // (wait out the popover teardown — its Layout "Table" button collides).
  await expect(page.getByText('No rows yet.')).toBeVisible();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Dependencies/})).toBeVisible();
});

// Adding a view auto-opens View options only when its layout still needs a
// property picked: a date-less Timeline pops the panel open (its Start date
// is one gesture away), while a config-free Gallery — or a Timeline that
// found a date property to bind to — opens quietly.
test('add view auto-config: opens View options only for unconfigured layouts', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);

  // Gallery needs no property → no popover.
  await addView(page, 'Gallery');
  await expect(page.getByRole('button', {name: 'New card'})).toBeVisible();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);

  // A date-less Timeline → View options opens on its Start date config.
  await addView(page, 'Timeline');
  await expect(page.getByLabel('Start date')).toBeVisible();
  await closeViewOptions(page);

  // Give the database a date column, back on the table view.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Due');
  await chooseValue(page, page.getByLabel('Property type'), 'date');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Due', {exact: true})).toBeVisible();

  // A new Timeline now binds to the date on its own → no popover, live canvas.
  await addView(page, 'Timeline');
  await expect(page.locator('div[title="Today"]')).toBeVisible();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
});
