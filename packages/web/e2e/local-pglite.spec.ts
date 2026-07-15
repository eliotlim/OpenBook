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
test('web runs on in-webview PGlite: a page created with no server survives a reload', {tag: ['@datalayer', '@p1']}, async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));

  await page.goto('/');

  // The shell only paints once the embedded store answers `listPages()` — so a
  // visible New-page control already proves PGlite opened in the browser.
  const newPage = page.getByRole('button', {name: 'New page'}).first();
  await expect(newPage).toBeVisible();

  await newPage.click();
  // An empty workspace lands on Home, which itself writes `?page=home` — wait
  // for the param to become the REAL page id the click created.
  await expect
    .poll(() => {
      const param = new URL(page.url()).searchParams.get('page');
      return param && param !== 'home' ? param : null;
    })
    .toBeTruthy();
  const id = new URL(page.url()).searchParams.get('page');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Reload straight to the page: it must come back from IndexedDB, not 404.
  await page.goto(`/?page=${id}`);
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  expect(errors).toEqual([]);
});

// P0-4 (sharing audit 2026-07-03): on the in-browser store nothing outside this
// browser can reach the workspace, so the sharing surfaces must say so instead
// of presenting a fully-wired-looking UI that is 100% inert. Only this spec
// exercises that path — every fixtures-based spec points the app at a real
// (reachable) server, where these disclosures must NOT appear (pinned by the
// browserLocalSharing unit tests).
test('web sharing surfaces disclose the in-browser workspace honestly', {tag: ['@sharing', '@p1']}, async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'New page'}).first().click();
  await expect
    .poll(() => {
      const param = new URL(page.url()).searchParams.get('page');
      return param && param !== 'home' ? param : null;
    })
    .toBeTruthy();

  // Share dialog: the browser-local disclosure replaces the unclaimed-instance
  // one, and the copy-link hint admits the link opens the recipient's OWN
  // library. The controls stay functional (scope picker + invite field).
  await page.getByRole('button', {name: 'Share', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/This library lives only in this browser/)).toBeVisible();
  await expect(dialog.getByText(/opens their own library, not this page/)).toBeVisible();
  await expect(dialog.getByText(/Sharing takes effect once you claim/)).toHaveCount(0);
  await expect(dialog.locator('#share-scope')).toBeVisible();
  await page.keyboard.press('Escape');

  // Sharing & publishing settings: no "publish it to the web" promise — a
  // desktop-app pointer instead, with the (real) guest gate still present.
  // Opened through the UI: a `?settings=…` goto races the first-run `?page=`
  // rewrite on a fresh local store, which drops the param and closes the panel.
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Sharing & publishing'}).click();
  await expect(page.getByText('Publish to the web')).toBeVisible();
  await expect(page.getByText(/isn’t hosted anywhere/)).toBeVisible();
  await expect(page.getByText('Guests & access')).toBeVisible();

  // Members: the roster (now a section of the same Sharing tab, SHR-5) stays
  // usable but says invitees can't reach it yet.
  await expect(page.getByRole('heading', {name: 'Members'})).toBeVisible();
  await expect(page.getByText(/people you add here can’t open it yet/)).toBeVisible();
  await expect(page.getByLabel('Invite a member')).toBeVisible();
});
