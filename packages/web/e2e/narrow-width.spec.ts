import {expect, test} from './fixtures';
import type {APIRequestContext} from '@playwright/test';
import {SERVER, emptySnapshot} from './seed';

test.use({freshWorkspace: true, viewport: {width: 420, height: 800}});

test('narrow shell: persisted sidebar collapses and drawer dismissals work', {tag: ['@shell']}, async ({page, request}) => {
  const destinationResponse = await request.post(`${SERVER}/api/pages`, {
    data: {name: 'Drawer destination', data: emptySnapshot},
  });
  expect(destinationResponse.ok()).toBeTruthy();
  const destinationId = ((await destinationResponse.json()) as {id: string}).id;
  // Reproduce the blocker: an existing desktop session persisted the sidebar
  // as docked + open before the browser was narrowed.
  await page.addInitScript(() => {
    localStorage.setItem('hud', JSON.stringify({sideNav: {open: true, docked: true}}));
  });
  await page.goto(`/?page=${destinationId}`);

  const drawer = page.locator('[data-sidebar-drawer]');
  await expect(drawer).not.toBeInViewport();

  await page.getByRole('button', {name: 'Toggle sidebar'}).click();
  await expect(drawer).toBeInViewport();

  const scrim = page.locator('[data-sidebar-scrim]');
  await expect(scrim).toBeVisible();
  // Click on the uncovered right edge, not the drawer layered over the scrim.
  await scrim.click({position: {x: 400, y: 100}});
  await expect(scrim).toHaveCount(0);
  await expect(drawer).not.toBeInViewport();

  await page.getByRole('button', {name: 'Toggle sidebar'}).click();
  await expect(drawer).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeInViewport();

  await page.getByRole('button', {name: 'Toggle sidebar'}).click();
  await expect(drawer).toBeInViewport();
  await drawer.getByRole('button', {name: 'Home', exact: true}).click();
  await expect(drawer).not.toBeInViewport();
});

test('narrow settings: Appearance color modes remain visible and clickable', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Toggle sidebar'}).click();
  const drawer = page.locator('[data-sidebar-drawer]');
  await expect(drawer).toBeInViewport();
  await drawer.getByRole('button', {name: 'Settings'}).click();
  await expect(drawer).not.toBeInViewport();
  await page.getByRole('button', {name: 'Appearance', exact: true}).click();

  for (const [label, value] of [
    ['Light', 'light'],
    ['Dark', 'dark'],
    ['System', 'system'],
  ] as const) {
    const option = page.getByRole('button', {name: label, exact: true});
    await expect(option).toBeVisible();
    await expect(option).toBeInViewport();
    await option.click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('theme'))).toBe(value);
  }
});

async function seedDatabase(request: APIRequestContext): Promise<string> {
  const pageResponse = await request.post(`${SERVER}/api/pages`, {
    data: {name: 'Narrow database', data: emptySnapshot},
  });
  expect(pageResponse.ok()).toBeTruthy();
  const pageId = ((await pageResponse.json()) as {id: string}).id;
  const schema = {
    properties: [{id: 'p_status', name: 'Status', type: 'select', options: [{id: 's_open', label: 'Open', color: 'blue'}]}],
    views: [
      {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
      {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
      {id: 'v_list', name: 'List', type: 'list', filters: [], sorts: []},
      {id: 'v_gallery', name: 'Gallery', type: 'gallery', filters: [], sorts: []},
    ],
  };
  const databaseResponse = await request.post(`${SERVER}/api/databases`, {
    data: {pageId, name: 'Narrow database', schema},
  });
  expect(databaseResponse.ok()).toBeTruthy();
  const databaseId = ((await databaseResponse.json()) as {id: string}).id;
  const rowResponse = await request.post(`${SERVER}/api/databases/${databaseId}/rows`, {
    data: {name: 'First narrow row', properties: {p_status: 's_open'}},
  });
  expect(rowResponse.ok()).toBeTruthy();
  return pageId;
}

test('narrow database: toolbar stays compact and horizontally scrollable', {tag: ['@database']}, async ({page, request}) => {
  const pageId = await seedDatabase(request);
  await page.goto(`/?page=${pageId}`);

  const toolbar = page.locator('[data-database-toolbar]');
  await expect(toolbar).toBeVisible();
  const box = await toolbar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(44);
  expect(await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test('page header controls collapse by pane width without wrapping or overlap', {tag: ['@editor']}, async ({page, request}) => {
  await page.setViewportSize({width: 1400, height: 800});
  const pageResponse = await request.post(`${SERVER}/api/pages`, {
    data: {name: 'Responsive header controls', data: emptySnapshot},
  });
  expect(pageResponse.ok()).toBeTruthy();
  const pageId = ((await pageResponse.json()) as {id: string}).id;

  await page.goto(`/?page=${pageId}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  const bar = page.locator('[data-page-header-controls]');
  const assertSingleRow = async (): Promise<void> => {
    await page.getByLabel('Page title').hover();
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.height).toBeLessThanOrEqual(32);
    expect(await bar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    const boxes = await bar.locator('[data-page-header-item]:visible').evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return {left: box.left, right: box.right, top: box.top, bottom: box.bottom};
      }),
    );
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(barBox!.x - 1);
      expect(box.right).toBeLessThanOrEqual(barBox!.x + barBox!.width + 1);
      expect(box.top).toBeGreaterThanOrEqual(barBox!.y - 1);
      expect(box.bottom).toBeLessThanOrEqual(barBox!.y + barBox!.height + 1);
    }
    const ordered = boxes.sort((a, b) => a.left - b.left);
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index].left).toBeGreaterThanOrEqual(ordered[index - 1].right - 1);
    }
  };

  // A desktop-wide viewport still narrows the primary editor once a split is
  // opened. Enter through this header's own control, then prove the 40rem
  // collapse follows the editor pane rather than the 1400px viewport.
  await assertSingleRow();
  await expect(bar.locator('[data-page-header-item="add-cover"]')).toBeVisible();
  await bar.getByRole('button', {name: 'Customise page'}).click();
  const splitPane = page.locator('[data-split-pane]');
  await expect(splitPane).toBeVisible();
  await expect(bar.locator('[data-page-header-item="add-cover"]')).toBeHidden();
  await splitPane.getByRole('button', {name: 'Hide split pane'}).click();
  await expect(splitPane).toHaveCount(0);
  // Restore the wide primary-pane setup used by the viewport-only checks below.
  await page.getByRole('button', {name: 'Toggle sidebar'}).click();
  await expect(page.locator('[data-sidebar-drawer]')).not.toBeInViewport();

  await page.setViewportSize({width: 900, height: 800});
  await assertSingleRow();
  await expect(bar.locator('[data-page-header-item="backlinks"]')).toBeVisible();
  await expect(bar.locator('[data-page-header-item="add-cover"]')).toBeVisible();
  await expect(bar.getByRole('button', {name: 'More actions'})).toBeHidden();

  await page.setViewportSize({width: 570, height: 800});
  await assertSingleRow();
  await expect(bar.locator('[data-page-header-item="backlinks"]')).toBeVisible();
  await expect(bar.locator('[data-page-header-item="add-cover"]')).toBeHidden();
  await bar.getByRole('button', {name: 'More actions'}).click();
  await expect(page.getByRole('menuitem', {name: 'Add cover'})).toBeVisible();
  await page.keyboard.press('Escape');

  await page.setViewportSize({width: 360, height: 800});
  await assertSingleRow();
  await expect(bar.locator('[data-page-header-item="backlinks"]')).toBeHidden();
  await bar.getByRole('button', {name: 'More actions'}).click();
  await expect(page.getByRole('menuitem', {name: 'Linked references'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Add cover'})).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await assertSingleRow();
});
