import {test, expect, takeSnapshot} from './fixtures';
import {newPage} from './seed';

// The split view's secondary page renders as a full-height pane docked at the
// window's right edge (a side peek), not a column carved out of the document
// area. Opened by URL (`?split=`), the page context menu, or the palette.

const textSnapshot = (text: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

test('split pane: full height on the right, resizable, closable', async ({page, request}) => {
  const a = await newPage(request, 'Split Primary', textSnapshot('Primary document body.'));
  const b = await newPage(request, 'Split Secondary', textSnapshot('Secondary document body.'));

  await page.goto(`/?page=${a}&split=${b}`);

  const pane = page.locator('[data-split-pane]');
  await expect(pane).toBeVisible();
  await expect(pane.getByText('Secondary document body.')).toBeVisible();
  // The primary keeps its document and the NavBar above it.
  await expect(page.locator('main').getByText('Primary document body.')).toBeVisible();

  // A tall "notebook sheet" docked on the right: it spans nearly the full
  // height, inset from the window edge by the small desk margin (--ob-page-inset).
  const viewport = page.viewportSize()!;
  const box = (await pane.boundingBox())!;
  expect(box.height).toBeGreaterThan(viewport.height * 0.9);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeLessThan(20);

  // Drag the left edge to widen the pane.
  const before = (await pane.boundingBox())!.width;
  const handle = pane.locator('[role="separator"]');
  await handle.hover();
  await page.mouse.down();
  await page.mouse.move(box.x - 120, viewport.height / 2, {steps: 5});
  await page.mouse.up();
  await expect.poll(async () => (await pane.boundingBox())!.width).toBeGreaterThan(before + 80);

  // Closing the pane returns to a single full-width document and clears ?split.
  await pane.getByRole('button', {name: 'Hide split pane'}).click();
  await expect(pane).toHaveCount(0);
  await expect(page).toHaveURL((url) => !url.searchParams.has('split'));
  await expect(page.locator('main').getByText('Primary document body.')).toBeVisible();
});

test('palette: Split view opens the current page beside itself', async ({page, request}, testInfo) => {
  const a = await newPage(request, 'Split Palette Page', textSnapshot('Palette split body.'));
  await page.goto(`/?page=${a}`);
  await expect(page.locator('main').getByText('Palette split body.')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Split view');
  await page.keyboard.press('Enter');

  const pane = page.locator('[data-split-pane]');
  await expect(pane).toBeVisible();
  await expect(pane.getByText('Palette split body.')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: full-height split pane
});
