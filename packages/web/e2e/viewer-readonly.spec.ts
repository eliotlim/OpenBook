import {test, expect, takeSnapshot} from './fixtures';
import {SERVER} from './seed';

// Whole-document read-only / viewer rendering (OB-205). A caller who can't write
// reads the page locked: no edit chrome (gutter, block menu, slash, drag, title
// typing), but interactive widgets stay live — the present-mode treatment lifted
// to a normal page.
//
// We make THIS browser read-only by intercepting `GET /api/instance` and closing
// the guest gate to `read` in the response only — the UI's `useCanWrite` then
// resolves to "can't write" and locks the document. The real server is never
// mutated (the per-worker data server is shared across spec files; closing the
// gate for real would 403 every other spec's guest writes), and the page content
// still loads from the untouched server.
test('a read-only viewer sees no edit chrome, cannot type, but widgets stay live', async ({page, request}, testInfo) => {
  const blockdoc = {
    blocks: [
      {id: 'h1', type: 'heading', props: {level: 1}, text: [{t: 'Read Only Report'}]},
      {id: 'p1', type: 'paragraph', text: [{t: 'You are viewing this page.'}]},
      {id: 'sl', type: 'slider', props: {name: 'x', value: 4, min: 0, max: 10}},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `Viewer ${Date.now()}`,
      data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []},
    },
  });
  const {id} = (await res.json()) as {id: string};

  // Present the instance as guest-read-only to this context only.
  await page.route('**/api/instance', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const info = await real.json();
    await route.fulfill({json: {...info, guestAccess: 'read'}});
  });

  await page.goto(`/?page=${id}`);

  // The editor renders, and settles into its locked state (the marker class the
  // read-only CSS keys off — also our "canWrite resolved to false" signal).
  const root = page.locator('.obe-root');
  await expect(root).toHaveClass(/obe-readonly/);
  await expect(root.getByText('You are viewing this page.')).toBeVisible();

  // No edit chrome: no gutter add-block / drag handle, no inline block menu.
  await expect(page.getByLabel('Add a block below')).toHaveCount(0);
  await expect(page.getByLabel('Drag to move, click for actions')).toHaveCount(0);
  await expect(root.locator('.obe-gutter')).toHaveCount(0);

  // The paragraph is not editable, and typing into it changes nothing.
  const para = page.locator('.obe-text-paragraph');
  await expect(para).toHaveAttribute('contenteditable', 'false');
  await para.click();
  await page.keyboard.type('SHOULD NOT APPEAR');
  await expect(root).not.toContainText('SHOULD NOT APPEAR');

  // Typing "/" never opens the slash menu on a locked page.
  await page.keyboard.type('/');
  await expect(page.locator('.obe-slash')).toHaveCount(0);

  // The title is locked too (it's a real <textarea>, an obvious typing leak).
  await expect(page.locator('.ob-page-title')).toHaveAttribute('readonly', /.*/);

  // …but the interactive widget stays live for the reader.
  await expect(root.locator('.obe-kit-slider input[type=range]')).toBeEnabled();

  await takeSnapshot(page, testInfo); // visual: the locked, read-only document

  // Drop the override → the same caller is a writer again (owner/writer unchanged).
  await page.unroute('**/api/instance');
  await page.reload();
  await expect(page.locator('.obe-root')).not.toHaveClass(/obe-readonly/);
  await expect(page.locator('.obe-text-paragraph')).toHaveAttribute('contenteditable', 'true');
});
