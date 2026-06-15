import {test, expect, takeSnapshot, chooseValue, chooseLabel} from './fixtures';
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

test('inputs publish to the scope; live code reads them all', async ({page}) => {
  await freshLab(page);
  await insert(page, 'number', 'Number stepper');
  await insert(page, 'toggle', 'Toggle switch');
  await insert(page, 'radio', 'Radio group');
  await insert(page, 'livecode', 'Live code');

  const code = page.locator('.obe-codeblock-live');
  await code.locator('.obe-text').click();
  await page.keyboard.type('on ? choice : n');
  await expect(code.locator('.obe-code-out')).toContainText('result = 0');

  // Step the number → the output tracks it.
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await expect(code.locator('.obe-code-out')).toContainText('result = 2');

  // Flip the toggle (the LIVE switch is inside the code bar — use the kit one).
  await page.locator('.obe-kit-toggle').getByRole('switch').click();
  await expect(code.locator('.obe-code-out')).toContainText('result = One');
  await page.getByRole('radio', {name: 'Two'}).click();
  await expect(code.locator('.obe-code-out')).toContainText('result = Two');
});

test('checklist publishes its selection as an array', async ({page}) => {
  await freshLab(page);
  await insert(page, 'choice checklist', 'Choice checklist');
  await insert(page, 'livecode', 'Live code');

  const code = page.locator('.obe-codeblock-live');
  await code.locator('.obe-text').click();
  await page.keyboard.type('checks.length');
  await expect(code.locator('.obe-code-out')).toContainText('result = 0');
  await page.getByRole('checkbox', {name: 'Alpha'}).check();
  await page.getByRole('checkbox', {name: 'Gamma'}).check();
  await expect(code.locator('.obe-code-out')).toContainText('result = 2');
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
  await chooseValue(page, chart.getByLabel('Chart kind'), 'bar');
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

test('live code: named outputs chain into formulas and charts', async ({page}) => {
  await freshLab(page);
  await insert(page, 'number', 'Number stepper');
  await insert(page, 'livecode', 'Live code');

  // Type the code body; name its output via the settings popover (⚙).
  const code = page.locator('.obe-codeblock-live').first();
  await code.locator('.obe-text').click();
  await page.keyboard.type('n * 2');
  await code.locator('.obe-kit-gear').click();
  await page.getByLabel('Output name').fill('double');
  await page.keyboard.press('Escape');
  await expect(code.locator('.obe-code-out')).toContainText('double = 0');

  // A second live block downstream reads the named output (chaining).
  await insert(page, 'livecode', 'Live code');
  const second = page.locator('.obe-codeblock-live').nth(1);
  await second.locator('.obe-text').click();
  await page.keyboard.type('double + 1');
  await second.locator('.obe-kit-gear').click();
  await page.getByLabel('Output name').fill('plus');
  await page.keyboard.press('Escape');

  // Step the input → both chained outputs track it.
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await page.getByRole('button', {name: 'Increase'}).click();
  await expect(page.locator('.obe-code-out').first()).toContainText('double = 6');
  await expect(second.locator('.obe-code-out')).toContainText('plus = 7');

  // Flipping live OFF (in the settings popover) turns it back into an inert snippet.
  await second.locator('.obe-kit-gear').click();
  await page.getByLabel('Live').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.obe-codeblock-live')).toHaveCount(1);
});

test('compound growth: a live-code series drives a multi-series chart', async ({page}) => {
  await freshLab(page);
  await insert(page, 'slider', 'Slider');
  // Name the slider's variable in its settings popover (⚙ shown on hover).
  const slider = page.locator('.obe-kit-slider');
  await slider.hover();
  await slider.locator('.obe-kit-gear').click();
  await page.getByLabel('Variable name').fill('months');
  await page.keyboard.press('Escape');
  await insert(page, 'livecode', 'Live code');
  const code = page.locator('.obe-codeblock-live');
  await code.locator('.obe-text').click();
  await page.keyboard.type(
    '({series: [{name: \'3%\', data: Array.from({length: months}, (_, i) => Math.pow(1.03, i / 12))}, {name: \'10%\', data: Array.from({length: months}, (_, i) => Math.pow(1.10, i / 12))}]})',
  );
  await code.locator('.obe-kit-gear').click();
  await page.getByLabel('Output name').fill('growth');
  await page.keyboard.press('Escape');

  await insert(page, 'chart', 'Chart');
  const chart = page.locator('.obe-kit-chart');
  await chart.hover();
  await chart.locator('.obe-kit-gear').click();
  await chart.getByLabel('Chart data expression').fill('growth');
  await chart.locator('.obe-kit-gear').click();

  // Two named series drawn, with the legend.
  await expect(chart.locator('svg polyline')).toHaveCount(2);
  await expect(chart.locator('.obe-chart-legend text', {hasText: '10%'})).toBeVisible();
});

test('pie chart renders labelled slices with a legend', async ({page}) => {
  await freshLab(page);
  await insert(page, 'chart', 'Chart');
  const chart = page.locator('.obe-kit-chart');
  await chart.hover();
  await chart.locator('.obe-kit-gear').click();
  await chart.getByLabel('Chart data expression').fill('{Won: 8, Lost: 2, Open: 5}');
  await chooseValue(page, chart.getByLabel('Chart kind'), 'pie');
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
  await expect(exprs.nth(0)).toHaveText('70'); // the formula readout
  // The status light renders as a LIVE dot (its expr is hidden): 70 ≥ truthy.
  await expect(page.locator('.kitlight')).toHaveClass(/kit-light-on/);
  // The kit chart exports as a DRAWN, kind-faithful plot over its cell:
  // three bars with their x labels, redrawn when the input moves.
  const fig = page.locator('figure[data-chart]');
  await expect(fig.locator('svg rect')).toHaveCount(3);
  await expect(fig.locator('svg text', {hasText: 'b'})).toBeVisible();
  // y-axis ticks prove the redraw: data max 21 → a "20" tick…
  await expect(fig.locator('svg text', {hasText: '20'})).toBeVisible();
  await page.locator('.reactive.slider input[type=range]').fill('3');
  await expect(exprs.nth(0)).toHaveText('30');
  // …data max 9 → the axis rescales to a "5" tick.
  await expect(fig.locator('svg rect')).toHaveCount(3);
  await expect(fig.locator('svg text', {hasText: '5'})).toBeVisible();
  await expect(fig.locator('svg text', {hasText: '20'})).toHaveCount(0);
});

test('dropdown publishes its pick; full-width radio renders stacked rows', async ({page}) => {
  await freshLab(page);
  await insert(page, 'dropdown', 'Dropdown');
  await insert(page, 'livecode', 'Live code');

  const code = page.locator('.obe-codeblock-live');
  await code.locator('.obe-text').click();
  await page.keyboard.type('pick');
  await expect(code.locator('.obe-code-out')).toContainText('result = One');
  await chooseLabel(page, page.locator('.obe-kit-dropdown [role="combobox"]'), 'Two');
  await expect(code.locator('.obe-code-out')).toContainText('result = Two');

  // Full width: the ⚙ toggle relays out the radio as stacked rows with dots.
  await insert(page, 'radio', 'Radio group');
  const radio = page.locator('.obe-kit-radio');
  await radio.getByRole('button', {name: 'Configure block'}).click();
  await radio.getByLabel('Full width').check();
  await expect(radio).toHaveClass(/obe-kit-wide/);
  await expect(radio.locator('.obe-kit-pill-dot')).toHaveCount(3);
  await radio.getByRole('radio', {name: 'Three'}).click();
  await expect(radio.getByRole('radio', {name: 'Three'})).toHaveAttribute('aria-checked', 'true');
});
