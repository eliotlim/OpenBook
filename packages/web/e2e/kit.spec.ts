import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// The block editor's artifact kit: named inputs publish onto a shared
// reactive scope; charts, formulas, and status lights compute over it.
// Driven in the lab sandbox (localStorage only, fresh per context).

test.describe.configure({mode: 'parallel'});

const freshLab = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.addInitScript(() => localStorage.removeItem('obe-lab-doc'));
  await page.goto('/editor-lab');
  await expect(page.locator('.obe-text').first()).toBeVisible();
};

/** Add an empty block below the last row, slash-insert by EXACT label. */
const insert = async (page: import('@playwright/test').Page, query: string, label: string): Promise<void> => {
  const lastRow = page.locator('[data-block-row]').last();
  await lastRow.hover();
  await lastRow.locator('..').getByRole('button', {name: 'Add a block below'}).last().click();
  await page.keyboard.type(`/${query}`);
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: label})});
  await item.first().click();
};

test('inputs publish to the scope; a formula reads them all', async ({page}) => {
  await freshLab(page);
  await insert(page, 'number', 'Number stepper');
  await insert(page, 'toggle', 'Toggle switch');
  await insert(page, 'radio', 'Radio group');
  await insert(page, 'formula', 'Formula');

  await page.locator('.obe-formula-src').fill('on ? choice : n');
  await expect(page.locator('.obe-formula-out')).toHaveText('0');

  // Step the number → the formula tracks it.
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await expect(page.locator('.obe-formula-out')).toHaveText('2');

  // Flip the toggle → the formula switches to the radio's value.
  await page.getByRole('switch').click();
  await expect(page.locator('.obe-formula-out')).toHaveText('One');
  await page.getByRole('radio', {name: 'Two'}).click();
  await expect(page.locator('.obe-formula-out')).toHaveText('Two');
});

test('checklist publishes its selection as an array', async ({page}) => {
  await freshLab(page);
  await insert(page, 'choice checklist', 'Choice checklist');
  await insert(page, 'formula', 'Formula');

  await page.locator('.obe-formula-src').fill('checks.length');
  await expect(page.locator('.obe-formula-out')).toHaveText('0');
  await page.getByRole('checkbox', {name: 'Alpha'}).check();
  await page.getByRole('checkbox', {name: 'Gamma'}).check();
  await expect(page.locator('.obe-formula-out')).toHaveText('2');
});

test('radio group: arrow keys move and select (roving tabindex)', async ({page}) => {
  await freshLab(page);
  await insert(page, 'radio', 'Radio group');
  const group = page.getByRole('radiogroup');
  await group.getByRole('radio', {name: 'One'}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', {name: 'Two'})).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio', {name: 'Two'})).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(group.getByRole('radio', {name: 'One'})).toHaveAttribute('aria-checked', 'true');
  // Wraps from the first back to the last.
  await page.keyboard.press('ArrowUp');
  await expect(group.getByRole('radio', {name: 'Three'})).toHaveAttribute('aria-checked', 'true');
});

test('chart + status light + button: the full artifact loop', async ({page}, testInfo) => {
  await freshLab(page);
  await insert(page, 'number', 'Number stepper');
  await insert(page, 'chart', 'Chart');
  await insert(page, 'status', 'Status light');
  await insert(page, 'button', 'Button');

  // Chart over n (bar kind) via the ⚙ config.
  const chart = page.locator('.obe-kit-chart');
  await chart.hover();
  await chart.locator('.obe-kit-gear').click();
  await chart.getByLabel('Chart data expression').fill('[n, n*2, 10]');
  await chart.getByLabel('Chart kind').selectOption('bar');
  await chart.getByLabel('Labels (comma-separated)').fill('n, 2n, ten');
  await chart.locator('.obe-kit-gear').click();
  await expect(chart.locator('svg rect')).toHaveCount(3);
  await expect(chart.locator('svg text', {hasText: 'ten'})).toBeVisible();

  // Status thresholds over n.
  const status = page.locator('.obe-kit-status');
  await status.hover();
  await status.locator('.obe-kit-gear').click();
  await status.getByLabel('Status expression').fill('n');
  await status.getByLabel('Ok threshold').fill('5');
  await status.getByLabel('Warn threshold').fill('2');
  await status.locator('.obe-kit-gear').click();
  await expect(status).toHaveAttribute('data-status', 'bad');

  // Stepping n crosses the warn threshold…
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await expect(status).toHaveAttribute('data-status', 'warn');

  // …and the action button (increments n) pushes it to ok.
  await page.getByRole('button', {name: 'Click me'}).click();
  await page.getByRole('button', {name: 'Click me'}).click();
  await page.getByRole('button', {name: 'Click me'}).click();
  await expect(status).toHaveAttribute('data-status', 'ok');
  await expect(page.getByLabel('n value')).toHaveValue('6');

  await takeSnapshot(page, testInfo); // visual: a live artifact (stepper → chart/status)
});

test('pie chart renders labelled slices with a legend', async ({page}) => {
  await freshLab(page);
  await insert(page, 'chart', 'Chart');
  const chart = page.locator('.obe-kit-chart');
  await chart.hover();
  await chart.locator('.obe-kit-gear').click();
  await chart.getByLabel('Chart data expression').fill('{Won: 8, Lost: 2, Open: 5}');
  await chart.getByLabel('Chart kind').selectOption('pie');
  await chart.locator('.obe-kit-gear').click();
  await expect(chart.locator('svg path')).toHaveCount(3);
  await expect(chart.locator('svg text', {hasText: 'Won · 53%'})).toBeVisible();
});

test('tooltip reveals on focus; link card carries its URL', async ({page}) => {
  await freshLab(page);
  await insert(page, 'tooltip', 'Tooltip');
  await insert(page, 'link card', 'Link card');

  const term = page.locator('.obe-kit-term');
  await expect(term).toContainText('Term');
  await term.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Explanation shown on hover.');

  const card = page.locator('.obe-kit-linkcard');
  await card.hover();
  await page.locator('.obe-kit-linkcard-wrap .obe-kit-gear').click();
  await page.getByLabel('Card title').fill('OpenBook');
  await page.getByLabel('Card URL').fill('example.com/docs');
  await expect(card).toHaveAttribute('href', 'https://example.com/docs');
  await expect(card).toContainText('OpenBook');
});

test('location block takes coordinates and links to a map', async ({page}) => {
  await freshLab(page);
  await insert(page, 'location', 'Location');
  await page.getByLabel('Latitude').fill('51.5074');
  await page.getByLabel('Longitude').fill('-0.1278');
  const map = page.getByRole('link', {name: 'Open map'});
  await expect(map).toHaveAttribute('href', /openstreetmap\.org.*51\.5074.*-0\.1278/);
});

test('HTML export keeps a kit artifact computing offline', async ({page, request}, testInfo) => {
  // A real page: a stepper feeding a status light and a formula.
  const blockdoc = {
    blocks: [
      {id: 'n1', type: 'number', props: {name: 'done', label: 'Tasks done', value: 7, min: 0, max: 10, step: 1}},
      {id: 's1', type: 'statuslight', props: {label: 'Readiness', source: 'done * 10', okAt: 50, warnAt: 20}},
      {id: 'f1', type: 'formula', props: {source: 'done * 10'}},
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', title: 'Trend', labels: 'a, b, c', source: '[done, done*2, done*3]'}},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Kit Export ${Date.now()}`, data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-kit-status')).toBeVisible();

  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).hover();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', {name: /HTML/}).click()]);

  // Open the standalone file: the stepper rides as a range input, and moving
  // it recomputes both expressions with no server anywhere. (Save under a
  // .html name — the raw download path has no extension, and file:// then
  // serves it as plain text.)
  const file = testInfo.outputPath('kit-export.html');
  await download.saveAs(file);
  await page.goto(`file://${file}`);
  const exprs = page.locator('.reactive.expr [data-val]');
  await expect(exprs.nth(0)).toHaveText('70');
  await expect(exprs.nth(1)).toHaveText('70');
  // The kit chart exports as a DRAWN, kind-faithful plot over its cell:
  // three bars with their x labels, redrawn when the input moves.
  const fig = page.locator('figure[data-chart]');
  await expect(fig.locator('svg rect')).toHaveCount(3);
  await expect(fig.locator('svg text', {hasText: 'b'})).toBeVisible();
  // y-axis ticks prove the redraw: data max 21 → a "20" tick…
  await expect(fig.locator('svg text', {hasText: '20'})).toBeVisible();
  await page.locator('.reactive.slider input[type=range]').fill('3');
  await expect(exprs.nth(0)).toHaveText('30');
  await expect(exprs.nth(1)).toHaveText('30');
  // …data max 9 → the axis rescales to a "5" tick.
  await expect(fig.locator('svg rect')).toHaveCount(3);
  await expect(fig.locator('svg text', {hasText: '5'})).toBeVisible();
  await expect(fig.locator('svg text', {hasText: '20'})).toHaveCount(0);
});
