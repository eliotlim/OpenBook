import {existsSync} from 'fs';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {expect, test, type Page} from '@playwright/test';

/**
 * Harness for the standalone viewer bundle (packages/ui/src/viewer, built by
 * `pnpm --filter @book.dev/ui run build:viewer` into
 * packages/ui/src/export/vendor/openbook-viewer.js).
 *
 * The fixtures are BARE HTML files: a JSON island (single page) or a space
 * bundle (two pages) plus the bundle via a relative <script src>, opened from
 * file:// — proving the bundle is fully self-contained: no server, no network,
 * CSS injected by the script itself. Each test also collects every http(s)
 * request and console error and asserts both stay empty.
 */

const BUNDLE = path.resolve(__dirname, '../../ui/src/export/vendor/openbook-viewer.js');
const fixtureUrl = (name: string): string => pathToFileURL(path.join(__dirname, 'fixtures', name)).href;

interface Watch {
  network: string[];
  errors: string[];
}

/** Track http(s) requests + console/page errors from before navigation. */
function watch(page: Page): Watch {
  const network: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => {
    if (/^https?:/i.test(r.url())) network.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return {network, errors};
}

test.beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `Viewer bundle missing at ${BUNDLE} — run: pnpm --filter @book.dev/ui run build:viewer`,
    );
  }
});

test.describe('island (single page)', () => {
  test('renders a page island standalone, locked but interactive, with no network', async ({page}) => {
    const {network, errors} = watch(page);
    await page.goto(fixtureUrl('island.html'));

    const viewer = page.locator('.ob-viewer');
    await expect(viewer).toBeVisible();
    const islandBefore = await page.locator('script[data-openbook-snapshot]').textContent();

    // ── Static content: title, heading, rich text ──────────────────────────
    await expect(page.locator('.ob-viewer-title')).toContainText('Viewer fixture');
    await expect(viewer.locator('[role="heading"][aria-level="1"]')).toContainText('Viewer fixture');
    await expect(viewer.getByText('Interactive export. Drag')).toBeVisible();

    // ── Image block from a data: URI ───────────────────────────────────────
    const img = viewer.locator('img[alt="grey square"]');
    await expect(img).toBeVisible();
    expect(await img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(8);

    // ── Reactive chain: slider → formula / live code → chart / status ──────
    const slider = viewer.locator('input[type="range"][aria-label="months value"]');
    await expect(slider).toHaveValue('120');
    const formulaOut = viewer.locator('.obe-formula-out');
    await expect(formulaOut).toHaveText('240');
    const chartSvg = viewer.locator('.obe-chart-svg');
    await expect(chartSvg).toBeVisible();
    const status = viewer.locator('.obe-kit-status');
    await expect(status).toHaveAttribute('data-status', 'ok');

    const chartBefore = await chartSvg.innerHTML();
    await slider.focus();
    await page.keyboard.press('ArrowRight'); // 120 → 121, a real user drag
    await expect(slider).toHaveValue('121');
    await expect(formulaOut).toHaveText('242'); // formula recomputed
    await expect(status).toHaveAttribute('data-status', 'bad'); // months <= 120 flipped
    expect(await chartSvg.innerHTML()).not.toBe(chartBefore); // chart redrew

    // ── Accordion collapse toggling (reader navigation stays live) ─────────
    const bodyA = viewer.getByText('Accordion body A');
    await expect(bodyA).toBeVisible();
    const toggleA = viewer.locator('.obe-acc-toggle').first();
    await toggleA.click();
    await expect(bodyA).toBeHidden();
    await toggleA.click();
    await expect(bodyA).toBeVisible();

    // ── Group renders (author chrome hidden) ───────────────────────────────
    await expect(viewer.getByText('Group body text')).toBeVisible();
    await expect(viewer.locator('.obe-group-btn:visible')).toHaveCount(0);

    // ── Tabs switch ────────────────────────────────────────────────────────
    await expect(viewer.getByText('first tab body')).toBeVisible();
    await viewer.getByRole('tab', {name: 'Second'}).click();
    await expect(viewer.getByText('second tab body')).toBeVisible();
    await expect(viewer.getByText('first tab body')).toBeHidden();

    // ── Locked semantics: no editing affordances anywhere ──────────────────
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    for (const chrome of ['.obe-gutter', '.obe-kit-gear', '.obe-cnt-add', '.obe-code-actions']) {
      await expect(page.locator(`${chrome}:visible`), `${chrome} must be hidden`).toHaveCount(0);
    }
    // Kit inline labels freeze to plain spans under the page lock.
    await expect(page.locator('input.obe-kit-inline')).toHaveCount(0);

    // ── Interactions never touched the island or the outside world ─────────
    expect(await page.locator('script[data-openbook-snapshot]').textContent()).toBe(islandBefore);
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('space bundle (multi page)', () => {
  test('navigates pages via nav links, mentions and the hash', async ({page}) => {
    const {network, errors} = watch(page);
    await page.goto(fixtureUrl('space.html'));

    // Page one renders with the nav.
    await expect(page.locator('[data-viewer-page="pg-one"]')).toBeVisible();
    await expect(page.getByText('Hello from page one')).toBeVisible();
    const nav = page.locator('.ob-viewer-nav');
    await expect(nav.locator('a')).toHaveCount(2);

    // Nav link → page two (hash-based).
    await nav.getByText('Second page').click();
    await expect(page.locator('[data-viewer-page="pg-two"]')).toBeVisible();
    await expect(page.getByText('Content of the second page.')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#page=pg-two');

    // Browser back returns to page one.
    await page.goBack();
    await expect(page.locator('[data-viewer-page="pg-one"]')).toBeVisible();

    // An in-content mention of a bundled page navigates too.
    await page.locator('a.obe-mention', {hasText: 'Second page'}).click();
    await expect(page.locator('[data-viewer-page="pg-two"]')).toBeVisible();

    // Deep link: initial hash selects the page.
    await page.goto(`${fixtureUrl('space.html')}#page=pg-two`);
    await expect(page.locator('[data-viewer-page="pg-two"]')).toBeVisible();

    expect(network).toEqual([]);
    expect(errors).toEqual([]);
  });
});
