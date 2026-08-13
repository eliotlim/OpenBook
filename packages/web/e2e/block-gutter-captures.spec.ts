import type {APIRequestContext, Locator, Page, TestInfo} from '@playwright/test';
import {expect, test} from './fixtures';
import {newPage, SERVER} from './seed';

// BB-6 manager verification: Chromium is intentionally unavailable in the
// worker sandbox. Run this tagged spec on a browser host and compare the paired
// `*-before.png` / `*-after.png` attachments for all four pane geometries.
test.use({freshWorkspace: true});

const snapshot = (text: string) => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

async function pageWithBlock(request: APIRequestContext, name: string, database = false): Promise<string> {
  const pageId = await newPage(request, name, snapshot(`${name} body`));
  if (database) {
    const response = await request.post(`${SERVER}/api/databases`, {
      data: {
        pageId,
        name: `${name} database`,
        schema: {properties: [], views: [{id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []}]},
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  return pageId;
}

type GutterGeometry = {
  gutterLeft: number;
  gripLeft: number;
  gripRight: number;
  clipLeft: number;
  clipRight: number;
};

async function gutterGeometry(grip: Locator): Promise<GutterGeometry> {
  return grip.evaluate((element) => {
    const gripRect = element.getBoundingClientRect();
    const gutterRect = element.closest('.obe-gutter')!.getBoundingClientRect();
    let clipLeft = 0;
    let clipRight = document.documentElement.clientWidth;
    let ancestor = element.parentElement;
    while (ancestor) {
      const overflowX = getComputedStyle(ancestor).overflowX;
      if (overflowX === 'hidden' || overflowX === 'clip' || overflowX === 'auto' || overflowX === 'scroll') {
        const rect = ancestor.getBoundingClientRect();
        clipLeft = Math.max(clipLeft, rect.left);
        clipRight = Math.min(clipRight, rect.right);
      }
      ancestor = ancestor.parentElement;
    }
    return {gutterLeft: gutterRect.left, gripLeft: gripRect.left, gripRight: gripRect.right, clipLeft, clipRight};
  });
}

async function captureBeforeAfter(
  page: Page,
  testInfo: TestInfo,
  scope: Locator,
  name: string,
  options: {priorNarrowFallback?: boolean; expectPlus: boolean; expectPriorClip: boolean},
): Promise<void> {
  const root = scope.locator('.obe-root').first();
  const row = root.locator('.obe-row').first();
  const gutter = row.locator('.obe-gutter').first();
  const grip = gutter.getByRole('button', {name: 'Drag to move, click for actions'});
  const add = gutter.getByRole('button', {name: 'Add a block below'});
  await expect(row).toBeVisible();

  const priorGutter = options.priorNarrowFallback
    ? `
      .obe-gutter:not(.obe-gutter-nested) { left: -1.6rem !important; }
      .obe-gutter:not(.obe-gutter-nested) > button:first-child { display: none !important; }
    `
    : `
      .obe-gutter:not(.obe-gutter-nested) { left: -3.4rem !important; }
      .obe-gutter:not(.obe-gutter-nested) > button:first-child { display: grid !important; }
    `;
  const baseline = await page.addStyleTag({
    content: `
      .obe-editor-pane .max-w-none { padding-left: 0 !important; }
      ${priorGutter}
    `,
  });

  await row.hover();
  await expect(grip).toBeVisible();
  const before = await gutterGeometry(grip);
  if (options.expectPriorClip) expect(before.gutterLeft).toBeLessThan(before.clipLeft);
  await page.screenshot({path: testInfo.outputPath(`${name}-before.png`), animations: 'disabled'});

  await baseline.evaluate((element) => element.parentNode?.removeChild(element));
  await row.hover();
  await expect(grip).toBeVisible();
  if (options.expectPlus) await expect(add).toBeVisible();
  else await expect(add).toBeHidden();

  const after = await gutterGeometry(grip);
  expect(after.gripLeft).toBeGreaterThanOrEqual(after.clipLeft - 0.5);
  expect(after.gripRight).toBeLessThanOrEqual(after.clipRight + 0.5);
  expect(await gutter.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');
  expect(await grip.getAttribute('draggable')).toBe('true');
  await page.screenshot({path: testInfo.outputPath(`${name}-after.png`), animations: 'disabled'});
}

test(
  'manager capture: centered standard page at 1024px',
  {tag: ['@editor', '@manager-verified']},
  async ({page, request}, testInfo) => {
    await page.setViewportSize({width: 1024, height: 800});
    await page.addInitScript(() => {
      // A docked sidebar stays in document flow even when `open` is false.
      // Undock it so this capture really exercises a 1024px document pane.
      localStorage.setItem('hud', JSON.stringify({sideNav: {open: false, docked: false}}));
    });
    const pageId = await pageWithBlock(request, 'BB-6 standard');
    await page.goto(`/?page=${pageId}`);
    await captureBeforeAfter(page, testInfo, page.locator('main'), 'bb6-standard-1024', {
      expectPlus: true,
      expectPriorClip: false,
    });
  },
);

test(
  'manager capture: full-width database page at 1440px',
  {tag: ['@editor', '@database', '@manager-verified']},
  async ({page, request}, testInfo) => {
    await page.setViewportSize({width: 1440, height: 800});
    await page.addInitScript(() => {
      localStorage.setItem('hud', JSON.stringify({sideNav: {open: false, docked: false}}));
    });
    const pageId = await pageWithBlock(request, 'BB-6 full database', true);
    await page.goto(`/?page=${pageId}`);
    await expect(page.locator('main .obe-root')).toHaveClass(/obe-full/);
    await captureBeforeAfter(page, testInfo, page.locator('main'), 'bb6-full-database-1440', {
      expectPlus: true,
      expectPriorClip: true,
    });
  },
);

test(
  'manager capture: 420px split pane in a wide window',
  {tag: ['@editor', '@shell', '@manager-verified']},
  async ({page, request}, testInfo) => {
    await page.setViewportSize({width: 1400, height: 800});
    const primaryId = await pageWithBlock(request, 'BB-6 split primary');
    const splitId = await pageWithBlock(request, 'BB-6 split secondary');
    await page.goto(`/?page=${primaryId}&split=${splitId}`);

    const pane = page.locator('[data-split-pane]');
    await expect(pane).toBeVisible();
    const box = (await pane.boundingBox())!;
    const divider = pane.getByRole('separator');
    const dividerBox = (await divider.boundingBox())!;
    const startX = dividerBox.x + dividerBox.width / 2;
    const startY = dividerBox.y + dividerBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Move from the actual pointer-down coordinate. Targeting from the pane's
    // left edge ignores the divider's half-width and leaves the pane ~3px wide.
    await page.mouse.move(startX + box.width - 420, startY, {steps: 5});
    await page.mouse.up();
    await expect.poll(async () => Math.round((await pane.boundingBox())!.width)).toBe(420);

    await captureBeforeAfter(page, testInfo, pane, 'bb6-split-pane-420', {
      expectPlus: false,
      expectPriorClip: true,
    });
  },
);

test(
  'manager capture: standard page in a 600px window',
  {tag: ['@editor', '@manager-verified']},
  async ({page, request}, testInfo) => {
    await page.setViewportSize({width: 600, height: 800});
    const pageId = await pageWithBlock(request, 'BB-6 narrow window');
    await page.goto(`/?page=${pageId}`);
    await captureBeforeAfter(page, testInfo, page.locator('main'), 'bb6-window-600', {
      priorNarrowFallback: true,
      expectPlus: false,
      expectPriorClip: true,
    });
  },
);
