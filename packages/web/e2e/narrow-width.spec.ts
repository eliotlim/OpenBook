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
