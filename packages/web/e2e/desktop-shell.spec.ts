import {test, expect, takeSnapshot} from './fixtures';
import {newPage, SERVER} from './seed';

// The desktop shell (simulated via `?shell=desktop`, which turns on in-window
// tabs) moves the workspace switcher and the sidebar hide button into the
// titlebar, before the tabs — where the real Tauri app draws them. On the web
// (no `?shell=desktop`) they stay in the sidebar / nav bar.
test('desktop shell: workspace switcher + sidebar toggle live in the titlebar', async ({page, request}, testInfo) => {
  const id = await newPage(request, 'Desktop Shell Demo');

  await page.goto(`/?page=${id}&shell=desktop`);

  // In-window tab bar is active (desktop only) and shows our page's tab...
  await expect(page.getByRole('tab', {name: /Desktop Shell Demo/})).toBeVisible();
  // ...and the compact workspace switcher now lives in the titlebar (on the web
  // it's in the sidebar, which hides it in this mode). Under the e2e fixtures
  // the app runs on a per-worker server override, so the auto-added workspace
  // is named after the server host rather than "My Workspace".
  const workspace = page.getByRole('button').filter({hasText: new URL(SERVER).host}).first();
  await expect(workspace).toBeVisible();

  // Order in the titlebar: [sidebar toggle] [workspace switcher] [back/forward].
  const back = page.getByRole('button', {name: 'Go back'});
  const wsBox = await workspace.boundingBox();
  const backBox = await back.boundingBox();
  expect(wsBox && backBox).toBeTruthy();
  expect(backBox!.x).toBeGreaterThan(wsBox!.x); // back/forward sits right of the workspace switcher

  await takeSnapshot(page, testInfo); // visual: desktop titlebar shell
});
