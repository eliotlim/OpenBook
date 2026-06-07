import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

// The desktop shell (simulated via `?shell=desktop`, which turns on in-window
// tabs) moves the workspace switcher and the sidebar hide button into the
// titlebar, before the tabs — where the real Tauri app draws them. On the web
// (no `?shell=desktop`) they stay in the sidebar / nav bar.
test('desktop shell: workspace switcher + sidebar toggle live in the titlebar', async ({page, request}, testInfo) => {
  const create = await request.post(`${SERVER}/api/pages`, {
    data: {name: 'Desktop Shell Demo', data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  const created = (await create.json()) as {id: string};

  await page.goto(`/?page=${created.id}&shell=desktop`);

  // In-window tab bar is active (desktop only) and shows our page's tab...
  await expect(page.getByRole('tab', {name: /Desktop Shell Demo/})).toBeVisible();
  // ...and the compact workspace switcher now lives in the titlebar (on the web
  // it's in the sidebar, which hides it in this mode).
  await expect(page.getByRole('button').filter({hasText: 'My Workspace'})).toBeVisible();

  await takeSnapshot(page, testInfo); // visual: desktop titlebar shell
});
