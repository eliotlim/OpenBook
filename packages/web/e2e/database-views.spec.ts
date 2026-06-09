import {test, expect, takeSnapshot} from '@chromatic-com/playwright';
import type {APIRequestContext} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';

async function newPage(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name, data: {editorjs: {blocks: []}, values: [], names: []}},
  });
  return ((await res.json()) as {id: string}).id;
}

/** Create a fresh database via the command palette and wait for its view. */
async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

// A formula column computes from another property (here the row title) — the
// headline "simple expression formula" feature, end to end.
test('database formula: a formula column computes from other properties', async ({page}, testInfo) => {
  await newDatabase(page);

  // Add a formula column that greets the row's title.
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Greeting');
  await page.locator('select').first().selectOption('formula');
  await page.locator('textarea').fill('concat("Hi ", Name)');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Greeting', {exact: true})).toBeVisible();

  // Add a row and name it; the formula cell recomputes to "Hi World".
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('World');
  await title.blur();

  await expect(page.getByRole('table').getByText('Hi World')).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: a computed formula column
});

// The view switcher offers the new layouts and they render without error.
test('database views: board, gallery, and bar chart layouts render', async ({page}, testInfo) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();

  // Board view (in the default schema) shows kanban columns from the Status select.
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: kanban board

  // Add a Gallery view from the add-view menu.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Gallery'}).click();
  await expect(page.getByRole('button', {name: 'New card'})).toBeVisible();

  // Add a Bar chart view; with a grouped property it draws a bar per group.
  await page.getByRole('button', {name: 'Add view'}).click();
  await page.getByRole('menuitem', {name: 'Bar chart'}).click();
  await expect(page.getByText('No value', {exact: true})).toBeVisible();
});

// A table column footer can summarise its values (here, a row count).
test('database summaries: a column footer calculation renders', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  await page.getByRole('button', {name: 'New row'}).click();

  // Set the Name column footer summary to "Count all" → shows the row count.
  await page.locator('tfoot button').first().click();
  await page.getByRole('menuitem', {name: 'Count all'}).click();
  await expect(page.locator('tfoot').getByText('2', {exact: true})).toBeVisible();
});

// The quick-search box filters the active view's rows.
test('database quick search: filters rows by text', async ({page}) => {
  await newDatabase(page);
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill('Findme');
  await title.blur();

  // A non-matching query empties the view.
  await page.getByRole('textbox', {name: 'Search rows'}).fill('zzz');
  await expect(page.getByText('No rows match the current view')).toBeVisible();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(0);

  // A matching query brings the row back.
  await page.getByRole('textbox', {name: 'Search rows'}).fill('Find');
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(1);
});

// An inline database block embeds a full database view inside a document.
test('inline database block: embeds a database view in a page', async ({page, request}) => {
  const id = await newPage(request, `Inline DB Host ${Date.now()}`);
  await page.goto(`/?page=${id}`);
  await page.locator('.ce-block').first().waitFor({state: 'visible'});
  await page.locator('.ce-paragraph').first().click();

  // Insert the inline database block from the slash menu.
  await page.keyboard.type('/Inline database');
  await expect(page.locator('.ce-popover--opened .ce-popover-item--focused')).toBeVisible();
  await page.keyboard.press('Enter');

  // The block shows a chooser; pick "New database" to mint one inline.
  await page.locator('.block-database').getByText('New database').click();

  // The host portals the new database's view in — its toolbar ("Add column")
  // appears inline (child creation is async).
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible({timeout: 15000});
});
