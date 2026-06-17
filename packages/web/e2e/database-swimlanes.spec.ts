import {test, expect} from './fixtures';

// Sub-grouping swimlanes (T9), exercised through the improved `roadmap` template:
// its board sub-groups by Area (horizontal lanes) and its timeline bands by Area.

async function openRoadmap(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
  await page.locator('[data-template="roadmap"]').click();
  await expect(page.getByLabel('Page title')).toHaveValue(/^Product roadmap/);
}

test('board: Area sub-group renders as full-width lane bars above the cards', async ({page}) => {
  await openRoadmap(page);
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // The primary group is the stage columns…
  await expect(page.locator('[data-col-key]').filter({hasText: 'Building'}).first()).toBeVisible();

  // …and each Area is a collapsible lane HEADER (a horizontal bar), not a column.
  for (const area of ['Core', 'Growth', 'Infra']) {
    await expect(page.getByRole('button', {name: `Collapse ${area} lane`})).toBeVisible();
  }

  // The lane bar spans the full board width (wider than a single column), and
  // collapsing it hides that lane's cards.
  const coreLane = page.getByRole('button', {name: 'Collapse Core lane'});
  await coreLane.click();
  await expect(page.getByRole('button', {name: 'Expand Core lane'})).toBeVisible();
});

test('timeline: groups render as collapsible Gantt bands', async ({page}) => {
  await openRoadmap(page);
  // Roadmap opens on the timeline; bands are labelled by Area.
  await expect(page.getByRole('button', {name: 'Timeline', exact: true})).toBeVisible();
  for (const area of ['Core', 'Growth', 'Infra']) {
    await expect(page.getByRole('button', {name: `Collapse ${area} band`})).toBeVisible();
  }
  // Bars still render within their bands.
  await expect(page.getByTitle(/drag to reschedule/).first()).toBeVisible();
});

// HTML5 drag-and-drop via dispatched DragEvents sharing one DataTransfer — the
// reliable way to drive native DnD from Playwright (mouse moves don't start it).
async function dragGutter(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', {dataTransfer: dt});
  await target.dispatchEvent('dragover', {dataTransfer: dt});
  await target.dispatchEvent('drop', {dataTransfer: dt});
  await source.dispatchEvent('dragend', {dataTransfer: dt});
}

// The first word of a lane/band bar's text is its Area label (the rest is the
// row count). Order-agnostic so a prior test's reorder of the shared roadmap
// can't break us — we drag whatever is currently second up to the front.
const firstWord = (s: string): string => s.trim().split(/\s+/)[0];

test('board: dragging a lane gutter reorders the swimlanes', async ({page}) => {
  await openRoadmap(page);
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  const lanes = page.locator('[data-lane-key]');
  await expect(lanes.nth(1)).toBeVisible(); // at least two swimlanes
  const first = firstWord(await lanes.first().innerText());
  const second = firstWord(await lanes.nth(1).innerText());
  expect(second).not.toBe(first);

  // Drag the second lane's gutter onto the first lane → it moves to the front.
  await dragGutter(page, page.getByLabel(`Reorder ${second} lane`), lanes.first());

  await expect(lanes.first()).toContainText(second);
});

test('timeline: dragging a band gutter reorders the bands', async ({page}) => {
  await openRoadmap(page);
  const bands = page.locator('[data-band-key]');
  await expect(bands.nth(1)).toBeVisible(); // at least two bands
  const first = firstWord(await bands.first().innerText());
  const second = firstWord(await bands.nth(1).innerText());
  expect(second).not.toBe(first);

  // Drag the second band's gutter onto the first band → it moves to the front.
  await dragGutter(page, page.getByLabel(`Reorder ${second} band`), bands.first());

  await expect(bands.first()).toContainText(second);
});
