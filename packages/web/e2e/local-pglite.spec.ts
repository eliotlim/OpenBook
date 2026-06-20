import {test, expect} from '@playwright/test';

/**
 * The in-webview data layer (item 2): with NO server configured, the web app
 * runs an embedded PGlite store on IndexedDB. This spec deliberately uses the
 * raw Playwright `test` (not `./fixtures`, which injects an `openbook.serverUrl`
 * override and a per-worker data server) so the app boots on the local store.
 * Each test gets a fresh, storage-isolated context, so PGlite starts empty.
 *
 * It proves two things that only a real browser can: PGlite actually opens and
 * answers queries (the shell renders), and writes survive a reload (IndexedDB
 * durability) — the whole point of running the store in the webview.
 */
test('web runs on in-webview PGlite: a page created with no server survives a reload', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));

  await page.goto('/');

  // The shell only paints once the embedded store answers `listPages()` — so a
  // visible New-page control already proves PGlite opened in the browser.
  const newPage = page.getByRole('button', {name: 'New page'}).first();
  await expect(newPage).toBeVisible();

  await newPage.click();
  await expect(page).toHaveURL(/page=/);
  const id = new URL(page.url()).searchParams.get('page');
  expect(id).toBeTruthy();
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Reload straight to the page: it must come back from IndexedDB, not 404.
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  expect(errors).toEqual([]);
});
