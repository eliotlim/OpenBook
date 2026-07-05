import {test, expect} from './fixtures';
import {SERVER} from './seed';

/**
 * Export → import round trip (island-first, epic req 4): an Interactive-HTML
 * export carries its `openbook+json` source island, and importing that very
 * file through the Import dialog restores the page losslessly — the kit
 * widgets land as REAL live blocks (not a static conversion) and keep
 * computing in the editor.
 */
test('an exported page re-imports losslessly and stays kit-functional', {tag: ['@export']}, async ({page, request}, testInfo) => {
  // A real page: a slider feeding a live-code formula, plus prose.
  const blockdoc = {
    blocks: [
      {id: 'h1', type: 'heading', text: [{t: 'Round Trip'}], props: {level: 2}},
      {id: 'p1', type: 'paragraph', text: [{t: 'Body text present.'}]},
      {id: 's1', type: 'slider', props: {name: 'price', label: 'Price', value: 50, min: 0, max: 100, step: 1}},
      {id: 'c1', type: 'code', text: [{t: 'price * 2'}], props: {live: true, name: 'doubled', language: 'js'}},
    ],
  };
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Round Trip ${Date.now()}`, data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};

  // Export the page as Interactive HTML (the site export — one island).
  await page.goto(`/?page=${id}`);
  await expect(page.locator('.obe-kit-slider')).toBeVisible();
  await page.getByRole('button', {name: 'Page actions'}).click();
  await page.getByRole('menuitem', {name: 'Export'}).hover();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', {name: 'Interactive HTML'}).click(),
  ]);
  const file = testInfo.outputPath('roundtrip.html');
  await download.saveAs(file);

  // Import the downloaded file through the Import dialog (Home quick action).
  await page.goto('/?page=home');
  await page.getByRole('button', {name: 'Bring your content'}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(file);
  // The island is detected: the preview announces a lossless OpenBook restore.
  await expect(page.getByText('This is an OpenBook export')).toBeVisible();
  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await page.getByRole('button', {name: 'View imported'}).click();

  // The imported page holds the ORIGINAL blocks — prose plus LIVE kit widgets.
  await expect(page.getByText('Body text present.')).toBeVisible();
  const slider = page.getByLabel('price value'); // the slider's range input
  await expect(slider).toBeVisible();
  await expect(slider).toHaveValue('50');
  await expect(page.locator('.obe-code-out')).toContainText('doubled = 100');

  // Kit-functional: moving the slider recomputes the formula in the editor.
  await slider.fill('80');
  await expect(page.locator('.obe-code-out')).toContainText('doubled = 160');
});

/**
 * Foreign HTML (no island) still converts through the legacy DOM path — the
 * island fast-path must not regress ordinary HTML imports.
 */
test('foreign HTML without an island still imports via conversion', {tag: ['@export']}, async ({page}, testInfo) => {
  const foreign = '<html><head><title>Plain Notes</title></head><body><h2>Section</h2><p>Converted paragraph.</p></body></html>';
  const file = testInfo.outputPath('foreign.html');
  const {writeFileSync} = await import('node:fs');
  writeFileSync(file, foreign);

  await page.goto('/?page=home');
  await page.getByRole('button', {name: 'Bring your content'}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('Ready to import')).toBeVisible();
  // No island → no lossless note; the normal conversion preview shows.
  await expect(page.getByText('This is an OpenBook export')).toHaveCount(0);
  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await page.getByRole('button', {name: 'View imported'}).click();
  await expect(page.getByText('Converted paragraph.')).toBeVisible();
});
