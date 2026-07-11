import {test, expect, chooseLabel} from './fixtures';

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

// Fresh DB → Add view → Timeline → ONE click creates a Date property, wires the
// view to it, and the dated canvas renders (the click-to-place first run).
test('timeline setup card: one click creates a Date property and renders the canvas', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addView(page, 'Timeline');

  const create = page.getByRole('button', {name: 'Create a Date property and use it'});
  await expect(create).toBeVisible();
  await create.click();

  // The dated canvas replaces the card: today's marker + the first-run invite.
  await expect(page.getByText(/click anywhere on the timeline to add one/i)).toBeVisible();
  await expect(page.locator('div[title="Today"]')).toBeVisible();

  // The property genuinely exists — it shows as a Table column.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Date/})).toBeVisible();
});

// Same one-click for the calendar (a plain date property → the month grid).
test('calendar setup card: one click creates a Date property and renders the month', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addView(page, 'Calendar');

  await page.getByRole('button', {name: 'Create a Date property and use it'}).click();

  // The month grid renders (weekday header + the Today jump).
  await expect(page.getByText('Sun', {exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Today'})).toBeVisible();
});

// Same one-click for the map (location property → the map body mounts; with no
// coordinates yet it invites setting the new property on a row).
test('map setup card: one click creates a Location property', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addView(page, 'Map');

  await page.getByRole('button', {name: 'Create a Location property and use it'}).click();
  await expect(page.getByText(/No rows have coordinates yet/)).toBeVisible();
});

// Same one-click for the graph (dependency property → the graph view mounts).
test('graph setup card: one click creates a Dependency property', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addView(page, 'Graph');

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
  await page.keyboard.press('Escape');

  // The card offers the picker (not a bare create button); choosing Status
  // wires the view and the chart renders its groups.
  const picker = page.getByLabel('Chart group-by property');
  await expect(picker).toBeVisible();
  await chooseLabel(page, picker, 'Status');
  await expect(page.getByText('Total 0')).toBeVisible();
});
