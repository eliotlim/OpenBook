import {test, expect, takeSnapshot} from './fixtures';
import {} from './seed';

// The template gallery: ready-made pages created client-side. Three are rich
// block-doc "artifacts" — reactive inputs feeding collapsed live-code, status
// lights, charts, cards, multi-column layouts, callouts, and divider/notes
// blocks so each doubles as a slide deck. Four are database fixtures; roadmap
// and field map back the swimlane and map specs. These tests drive the
// gallery as a user would: open it, pick a card, land on the created page.

async function hydrated(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
}

async function openGallery(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
}

async function pick(page: import('@playwright/test').Page, id: string): Promise<void> {
  await openGallery(page);
  await page.locator(`[data-template="${id}"]`).click();
}

test('gallery: lists every template with names and descriptions', {tag: ['@shell', '@visual']}, async ({page}, testInfo) => {
  await hydrated(page);
  await openGallery(page);

  for (const name of ['Grocery price tracker', 'Project task board', 'Reading list', 'Project intake', 'Savings & investing', 'Product roadmap', 'Field map', 'Pitch deck', 'Compound growth', 'Team status dashboard', 'Product HQ']) {
    await expect(page.getByRole('button', {name: new RegExp(name)})).toBeVisible();
  }
  await takeSnapshot(page, testInfo); // visual: the template gallery

  // Escape closes without creating anything.
  await page.keyboard.press('Escape');
  await expect(page.getByText('Start with a template')).toBeHidden();
});

test('grocery price tracker: baskets steer the cheapest pick and the budget light', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'grocery-tracker');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Grocery price tracker/);
  // A bar (basket by shop) and a line (trend) — both live.
  await expect(page.locator('.obe-kit-chart')).toHaveCount(2);
  // Aldi (86) is the cheapest of 86/99/112 → the narration names it, light is green.
  await expect(page.locator('.obe-code-out', {hasText: 'Aldi'}).first()).toBeVisible();
  const status = page.locator('.obe-kit-status');
  await expect(status).toHaveAttribute('data-status', 'ok'); // budget 120 − best 86 = 34

  // Drop the budget below the cheapest basket → the light goes red.
  await page.getByLabel('budget value').fill('60');
  await expect(status).toHaveAttribute('data-status', 'bad');
});

test('project task board: a kanban database grouped by status', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'task-board');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Project task board/);
  // Opens on the board with the status columns; table + calendar views back it.
  await expect(page.getByRole('button', {name: 'Board', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Calendar', exact: true})).toBeVisible();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page.locator('[data-col-key]').filter({hasText: 'Backlog'}).first()).toBeVisible();

  // The table view shows the schema columns and every seeded row.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Priority/})).toBeVisible();
  await expect(page.getByRole('columnheader', {name: /Due/})).toBeVisible();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(7);
});

test('reading list: a shelf-grouped gallery database', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'reading-list');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Reading list/);
  // Opens on the gallery; a table view backs it.
  await expect(page.getByRole('button', {name: 'Gallery', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toBeVisible();

  // The gallery renders seeded book covers (inline PNGs on the files-typed cover
  // property) — real cards, not empty cover slots. At least the three seeded
  // covers load as <img> (one per shelf).
  const covers = page.locator('img[src^="data:image/png"]');
  await expect(covers.first()).toBeVisible();
  expect(await covers.count()).toBeGreaterThanOrEqual(3);

  // The table view lists every seeded book with its author column.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Author/})).toBeVisible();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(6);
});

test('project intake: a gated wizard with a live prioritisation', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'project-intake');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Project intake/);
  // The progress bar (bound to the accordion completion) and the three stages.
  await expect(page.getByRole('progressbar').first()).toBeVisible();
  await expect(page.locator('.obe-acc-label')).toHaveCount(3);
  // Prioritisation: impact 7 vs effort 4 → a quick win (green), with its bar chart.
  await expect(page.locator('.obe-kit-chart')).toHaveCount(1);
  await expect(page.locator('.obe-kit-status').first()).toHaveAttribute('data-status', 'ok');
});

test('savings & investing: sliders steer a live compounding projection', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'savings-planner');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Savings & investing/);
  // An area projection (two named series + legend) and a runway bar.
  await expect(page.locator('.obe-kit-chart')).toHaveCount(2);
  const area = page.locator('.obe-kit-chart[data-chart-kind="area"]');
  await expect(area.locator('svg polyline')).toHaveCount(2); // Invested + Projected
  await expect(area.locator('.obe-chart-legend text', {hasText: 'Projected'})).toBeVisible();
  await expect(page.locator('.obe-code-out', {hasText: 'After 20 years'}).first()).toBeVisible();

  // Stretch the horizon → the narration tracks it.
  await page.getByLabel('years value').fill('30');
  await expect(page.locator('.obe-code-out', {hasText: 'After 30 years'}).first()).toBeVisible();
});

test('pitch deck: a five-slide deck with a live donut and speaker notes in the presenter view', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'pitch-deck');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Pitch deck/);
  // The showcase chart: a donut (a kind no other template uses), fed by sliders.
  await expect(page.locator('.obe-kit-chart[data-chart-kind="donut"]')).toBeVisible();
  // Recurring share 62% ≥ the 60% bar → the light starts green.
  await expect(page.locator('.obe-kit-status')).toHaveAttribute('data-status', 'ok');

  // Present it (presenter view avoids the OS fullscreen request in headless).
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Present'}).click();
  await page.getByRole('menuitem', {name: 'Presenter view'}).click();

  const present = page.locator('.ob-present');
  await expect(present).toBeVisible();
  // Five slides, opening on the title slide…
  await expect(present.locator('.ob-present-counter')).toHaveText('1 / 5');
  await expect(present.locator('.ob-present-stage').getByRole('heading', {name: 'Brightloop'})).toBeVisible();
  // …whose speaker note shows in the presenter notes panel, not on the stage.
  await expect(present.locator('.ob-present-notes-panel').getByText(/Thirty seconds, tops/)).toBeVisible();
  await expect(present.locator('.ob-present-stage').getByText(/Thirty seconds, tops/)).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(present).toHaveCount(0);
});

test('compound growth: the sample document as a fresh gallery copy', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'compound-growth');

  // A fresh copy under the gallery's own name (not the Home starter's
  // "Compound Growth (sample)" — that open-or-create entry point is separate).
  await expect(page.getByLabel('Page title')).toHaveValue(/^Compound growth/);
  // The months slider feeds four compound-growth curves on one live chart.
  const chart = page.locator('.obe-kit-chart[data-chart-kind="line"]');
  await expect(chart).toBeVisible();
  await expect(chart.locator('svg polyline')).toHaveCount(4);
  await expect(chart.locator('.obe-chart-legend text', {hasText: '10%'})).toBeVisible();
});

test('team status dashboard: a locked, synced panel stays live while its text freezes', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'team-status');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Team status dashboard/);

  // The Pulse group is locked: its text is frozen (contenteditable off) even
  // though the page around it stays editable…
  const group = page.locator('.obe-group-locked');
  await expect(group).toBeVisible();
  await expect(group.locator('[data-block-text="td-g-note"]')).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('[data-block-text="td-tag"]')).toHaveAttribute('contenteditable', 'true');

  // …but its controls stay live (the interactive exemption): the kudos button
  // steps the counter, and the formula + toggle both feed the morale readout.
  const toggle = group.getByRole('switch');
  await expect(toggle).toBeEnabled();
  await expect(group.locator('.obe-formula-out')).toHaveText('25'); // 2 kudos × 10 + on-call 5
  // The momentum light reads the (namespaced) kudos count: it loads amber —
  // 2 is below ok-at 3 but at/above warn-at 1.
  await expect(group.locator('.obe-kit-status')).toHaveAttribute('data-status', 'warn');
  await group.getByRole('button', {name: 'Give kudos'}).click();
  await expect(page.getByLabel('kudos value')).toHaveValue('3');
  await expect(group.locator('.obe-formula-out')).toHaveText('35');
  // …and the Give-kudos click flips it green: 3 ≥ ok-at 3.
  await expect(group.locator('.obe-kit-status')).toHaveAttribute('data-status', 'ok');
  await toggle.click(); // still operable under the lock
  await expect(group.locator('.obe-formula-out')).toHaveText('30');

  // The funnel chart (a kind no other template uses) and the tabs container.
  await expect(page.locator('.obe-kit-chart[data-chart-kind="funnel"]')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', {name: 'Next week'}).click();
  await expect(page.getByText('Rotate the on-call')).toBeVisible();
});

test('product hq: two databases linked by a relation, rolled up, and chained on a timeline', {tag: ['@shell']}, async ({page}) => {
  await hydrated(page);
  await pick(page, 'product-hq');

  // Lands on the Initiatives table. The relation chips resolve TASK titles
  // from the other database…
  await expect(page.getByLabel('Page title')).toHaveValue(/^Product HQ/);
  const table = page.getByRole('table');
  await expect(table.getByText('Ship onboarding checklist')).toBeVisible();
  await expect(table.getByText('Migrate legacy invoices')).toBeVisible();
  // …and the rollups fold the linked tasks: % done per initiative (1 of 2
  // onboarding tasks; 0 of 2 performance; 1 of 1 billing).
  await expect(table.getByText('50%', {exact: true})).toBeVisible();
  await expect(table.getByText('0%', {exact: true})).toBeVisible();
  await expect(table.getByText('100%', {exact: true})).toBeVisible();

  // The Tasks database is a sub-page; it opens on a timeline whose dependency
  // property draws the two seeded blocked-by arrows.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Product HQ Tasks');
  await page.getByRole('option', {name: /Product HQ Tasks/}).first().click();
  await expect(page.getByLabel('Page title')).toHaveValue(/^Product HQ.*Tasks/);
  await expect(page.getByRole('button', {name: 'Timeline', exact: true})).toBeVisible();
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(5);
  await expect(page.locator('svg path[marker-end]')).toHaveCount(2);
});

test('instantiating a template twice suffixes the page and row names (names are unique)', {tag: ['@shell']}, async ({page}) => {
  // A database template is the hard case: its sample-row pages share the
  // workspace-unique name space too, so both runs must fully materialize.
  await hydrated(page);
  await pick(page, 'task-board');
  await expect(page.getByLabel('Page title')).toHaveValue(/^Project task board/);
  const first = await page.getByLabel('Page title').inputValue();
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(7);

  await pick(page, 'task-board');
  await expect(page.getByLabel('Page title')).not.toHaveValue(first);
  await expect(page.getByLabel('Page title')).toHaveValue(/^Project task board \d+$/);
  // The second copy carries all seven sample rows despite the name collisions.
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(7);
});
