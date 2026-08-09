import {test, expect, takeSnapshot, chooseValue} from './fixtures';
import {SERVER} from './seed';

// Per-test workspace reset: each test builds a fresh database and some seed
// fixed row titles, so a clean workspace before each test keeps them
// collision-free without manual name reclamation.
test.use({freshWorkspace: true});

// The timeline view centres on *today*, so any fixed calendar date becomes a
// time-bomb: once "today" drifts past it, the bar scrolls off-screen and its
// month label stops rendering. Seed every date relative to the current date so
// bars stay near centre (visible without scrolling) and month labels stay
// current, no matter when CI runs.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** ISO date (YYYY-MM-DD) `n` days from today; `n` may be negative. */
const dayFromToday = (n: number): string => {
  const t = new Date();
  return isoOf(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
};
/** The axis' month-tier label for an ISO date — matches databaseTimeline's
 *  `MONTHS[m] + ' ' + year` format, e.g. "Jul 2026". */
const monthLabelOf = (iso: string): string => {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  // A wiped (freshWorkspace) workspace lands on Home; wait for it to hydrate.
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

/** Add a Timeline view and wait for the picker menu to fully close — its exit
 *  animation intercepted the first canvas click under load (the click-to-place
 *  "flake" was the closing menu eating the click). */
async function openTimeline(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Timeline'}).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

async function addColumn(page: import('@playwright/test').Page, name: string, type: string): Promise<void> {
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill(name);
  await chooseValue(page, page.getByLabel('Property type'), type);
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText(name, {exact: true})).toBeVisible();
}

// A timeline view lays a dated row out as a bar on a month axis.
test('timeline view: a dated row renders as a bar', {tag: ['@database', '@visual']}, async ({page}, testInfo) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  const due = dayFromToday(0);
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('Due').first().fill(due);

  await openTimeline(page);

  // The month axis labels the spanned (current) month.
  await expect(page.getByText(monthLabelOf(due))).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: gantt timeline
});

// A dependency property links one row to another (drawn as arrows on a timeline).
test('dependencies: link a row to another row', {tag: ['@database']}, async ({page}) => {
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

/** Reliable body-drag on a timeline bar. The drag handler binds its
 *  `pointermove`/`pointerup` listeners on `window` in a React effect that only
 *  runs *after* the pointerdown-driven re-render, so a single fast move can be
 *  missed. Land the press, nudge past the 3px move threshold to force the state
 *  update (and give the effect a tick to attach), then walk to the target in
 *  steps before releasing. */
async function dragBarBy(page: import('@playwright/test').Page, bar: import('@playwright/test').Locator, dx: number): Promise<void> {
  // The bar can sit below the fold (header + properties + editor above the
  // view) — mouse coordinates only hit what's inside the viewport.
  await expect(bar).toBeVisible();
  await bar.scrollIntoViewIfNeeded();
  const box = (await bar.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Nudge to trip the move threshold and let the window listener attach.
  await page.mouse.move(cx + 8, cy, {steps: 3});
  await page.mouse.move(cx + dx, cy, {steps: 12});
  await page.mouse.up();
}

// A timeline bar can be dragged to reschedule the row's date. Built on the API
// (like the two-property sibling below) so verification is deterministic: poll
// the row's stored date rather than round-tripping through the table cell.
test('timeline drag: dragging a bar reschedules the row', {tag: ['@database']}, async ({page, request}) => {
  const schema = {
    properties: [{id: 'p_when', name: 'When', type: 'date'}],
    views: [{id: 'v_tl', name: 'Timeline', type: 'timeline', filters: [], sorts: [], datePropertyId: 'p_when'}],
  };
  const p = await request.post(`${SERVER}/api/pages`, {data: {name: `Drag ${Date.now()}`, data: {editorjs: {blocks: []}, values: [], names: []}}});
  const pageId = ((await p.json()) as {id: string}).id;
  const d = await request.post(`${SERVER}/api/databases`, {data: {pageId, name: 'T', schema}});
  const dbId = ((await d.json()) as {id: string}).id;
  const when = dayFromToday(0); // today → bar renders near centre, visible without scroll
  await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name: `Row ${dbId.slice(0, 8)}`, properties: {p_when: when}}});

  await page.goto(`/?page=${pageId}`);
  await dragBarBy(page, page.getByTitle(/drag to reschedule/), 170);

  // The stored date has moved later off its original value.
  await expect
    .poll(async () => {
      const rows = (await (await request.get(`${SERVER}/api/databases/${dbId}/rows`)).json()) as Array<{properties: Record<string, string>}>;
      return rows[0]?.properties.p_when;
    })
    .not.toBe(when);
});

// Drag from one bar's link handle onto another to create a dependency edge.
test('timeline drag-to-link: drag one bar onto another to add a dependency', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'When', 'date');
  await addColumn(page, 'Depends', 'dependency');

  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('When').first().fill(dayFromToday(-5));
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('When').nth(1).fill(dayFromToday(5));

  await openTimeline(page);

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
test('timeline click-to-place: clicking the empty canvas adds a dated item', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  await openTimeline(page);

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

// A dateless row appears as its own lane (no bar) that you click to schedule.
test('timeline unscheduled row: a dateless row gets a click-to-place lane', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');

  // A named row, left without a date.
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Floating');
  await title.blur();
  await expect(title).toHaveValue('Floating');

  await openTimeline(page);

  // It has a lane (clickable to schedule), but no bar yet.
  const lane = page.getByRole('button', {name: 'Place on timeline'});
  await expect(lane).toBeVisible();
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(0);

  // Click the lane at today's marker — the row gets a date, becomes a bar, and the
  // lane is gone.
  const laneBox = (await lane.boundingBox())!;
  const todayBar = page.locator('div[title="Today"]');
  const tb = (await todayBar.boundingBox())!;
  await page.mouse.click(tb.x, laneBox.y + laneBox.height / 2);
  await expect(page.getByTitle(/drag to reschedule/)).toHaveCount(1);
  await expect(lane).toHaveCount(0);
});

// The zoom selector switches the axis between daily…yearly granularities.
test('timeline scale: switching zoom updates the axis', {tag: ['@database']}, async ({page}) => {
  await newDatabase(page);
  await addColumn(page, 'Due', 'date');
  const due = dayFromToday(0);
  const [year] = due.split('-');
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByLabel('Due').first().fill(due);

  await openTimeline(page);

  // A fine default zoom shows a month context tier (the current month).
  await expect(page.getByText(monthLabelOf(due))).toBeVisible();

  // Yearly zoom labels whole years and drops the month context.
  await chooseValue(page, page.getByLabel('Timeline scale'), 'year');
  await expect(page.getByText(year, {exact: true})).toBeVisible();
  await expect(page.getByText(monthLabelOf(due))).toHaveCount(0);
});

// A dependency graph view lays rows out as connected nodes.
test('dependency graph: shows rows as connected nodes', {tag: ['@database']}, async ({page}) => {
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
test('page-view properties: configure visibility and groups', {tag: ['@database']}, async ({page}) => {
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
test('timeline drag with separate start/end columns moves both dates', {tag: ['@database']}, async ({page, request}) => {
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
  // A 14-day span straddling today, so the bar renders near centre.
  const startDate = dayFromToday(-7);
  const endDate = dayFromToday(7);
  await request.post(`${SERVER}/api/databases/${dbId}/rows`, {data: {name: `Span ${dbId.slice(0, 8)}`, properties: {p_start: startDate, p_end: endDate}}});

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
      return {days, moved: p_start !== startDate};
    })
    .toEqual({days: 14, moved: true});
});
