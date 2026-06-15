import {test, expect, takeSnapshot} from './fixtures';
import {} from './seed';

// The template gallery: ready-made pages created client-side. Five are rich
// block-doc "artifacts" — reactive inputs feeding collapsed live-code, status
// lights, charts, cards, multi-column layouts, callouts, and divider/notes
// blocks so each doubles as a slide deck. Two are database fixtures (roadmap,
// field map) exercised by the swimlane and map specs. These tests drive the
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

test('gallery: lists every template with names and descriptions', async ({page}, testInfo) => {
  await hydrated(page);
  await openGallery(page);

  for (const name of ['Grocery price tracker', 'Project task board', 'Reading list', 'Project intake', 'Savings & investing', 'Product roadmap', 'Field map']) {
    await expect(page.getByRole('button', {name: new RegExp(name)})).toBeVisible();
  }
  await takeSnapshot(page, testInfo); // visual: the template gallery

  // Escape closes without creating anything.
  await page.keyboard.press('Escape');
  await expect(page.getByText('Start with a template')).toBeHidden();
});

test('grocery price tracker: baskets steer the cheapest pick and the budget light', async ({page}) => {
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

test('project task board: capacity check flips with the team size', async ({page}) => {
  await hydrated(page);
  await pick(page, 'task-board');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Project task board/);
  // The board's three columns.
  for (const col of ['Backlog', 'In progress', 'Done']) {
    await expect(page.getByRole('heading', {name: new RegExp(col)})).toBeVisible();
  }
  // Donut + burndown line.
  await expect(page.locator('.obe-kit-chart')).toHaveCount(2);
  await expect(page.locator('.obe-code-out', {hasText: 'points done'}).first()).toBeVisible();

  // capacity 20 < committed 24 → amber; pulling in a teammate (+5) clears it.
  const status = page.locator('.obe-kit-status');
  await expect(status).toHaveAttribute('data-status', 'warn');
  await page.getByRole('button', {name: /Pull in a teammate/}).click();
  await expect(page.getByLabel('capacity value')).toHaveValue('25');
  await expect(status).toHaveAttribute('data-status', 'ok');
});

test('reading list: logging a book moves the year goal', async ({page}) => {
  await hydrated(page);
  await pick(page, 'reading-list');

  await expect(page.getByLabel('Page title')).toHaveValue(/^Reading list/);
  await expect(page.locator('.obe-kit-chart')).toHaveCount(2); // read-vs-to-go donut + genre bar
  await expect(page.locator('.obe-kit-status')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('.obe-code-out', {hasText: 'of 24 books'}).first()).toBeVisible();

  // Log a finished book → the counter steps and the narration follows.
  await page.getByRole('button', {name: 'Log a finished book'}).click();
  await expect(page.getByLabel('read value')).toHaveValue('11');
});

test('project intake: a gated wizard with a live prioritisation', async ({page}) => {
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

test('savings & investing: sliders steer a live compounding projection', async ({page}) => {
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

test('instantiating a template twice suffixes the page name (names are unique)', async ({page}) => {
  await hydrated(page);
  await pick(page, 'grocery-tracker');
  await expect(page.getByLabel('Page title')).toHaveValue(/^Grocery price tracker/);
  const first = await page.getByLabel('Page title').inputValue();

  await pick(page, 'grocery-tracker');
  await expect(page.getByLabel('Page title')).not.toHaveValue(first);
  await expect(page.getByLabel('Page title')).toHaveValue(/^Grocery price tracker \d+$/);
});
