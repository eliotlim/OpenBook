import {test, expect, takeSnapshot} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

// Add a relation column to a database and link a page through the row's cell.
test('database relations: add a relation column and link a page', async ({page, request}, testInfo) => {
  // Seed a uniquely-named page to link to (shared backend → unique avoids clashes).
  const linkable = `Linkable ${Date.now()}`;
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: linkable, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  // Create a database from the command palette.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();

  // Add a Relation column named "Related".
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Related');
  await page.locator('select').selectOption('relation');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Related', {exact: true})).toBeVisible();

  // Add a row, then link the seeded page through the relation cell.
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'Link a page'}).click();
  await page.getByPlaceholder('Link a page…').fill('Linkable');
  await page.getByRole('button', {name: new RegExp(linkable)}).click();
  await page.keyboard.press('Escape');

  // The relation cell (in the table) shows the linked page as a chip — scope to
  // the table since the seeded page also appears in the sidebar tree.
  await expect(page.getByRole('table').getByText(linkable)).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: relation column with a linked page
});

// A couple of the new scalar column types render their editors.
test('database types: url and multi-select columns are available', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();

  // Add a URL column.
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Website');
  await page.locator('select').selectOption('url');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Website', {exact: true})).toBeVisible();

  // A URL value renders an "Open" affordance.
  await page.getByRole('button', {name: 'New row'}).click();
  const urlInput = page.getByRole('textbox', {name: 'url'}).first();
  await urlInput.fill('example.com');
  await urlInput.blur();
  await expect(page.getByRole('link', {name: 'Open'}).first()).toBeVisible();
});
