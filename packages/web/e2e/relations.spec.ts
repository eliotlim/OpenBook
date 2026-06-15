import {test, expect, takeSnapshot, chooseValue, chooseLabel} from './fixtures';

// Relations are database↔database (1:1 / 1:n / n:n) with an optional reverse
// link. A relation column targets another database and links its rows.

async function newDatabase(page: import('@playwright/test').Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
  await page.getByLabel('Page title').fill(title);
  await page.keyboard.press('Tab'); // commit the rename so it reaches the nav list
  // The rename saves debounced; let it flush before we navigate away, so the
  // new database shows (by this name) in the next database's relation picker.
  await expect(page.getByLabel('Page title')).toHaveValue(title);
  await page.waitForTimeout(900);
}

async function addRowNamed(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByRole('button', {name: 'New row'}).click();
  const title = page.getByRole('table').getByPlaceholder('Untitled').first();
  await title.fill(name);
  await title.blur(); // commit (Escape cancels the edit)
  await expect(title).toHaveValue(name);
  await page.waitForTimeout(700); // let the debounced rename persist before we navigate
}

test('database relations: a relation column links rows from a target database', async ({page}, testInfo) => {
  const ts = Date.now();
  const projects = `Projects ${ts}`;
  const projectRow = `Website relaunch ${ts}`;

  // Target database (Projects) with one named row to link to.
  await newDatabase(page, projects);
  await addRowNamed(page, projectRow);

  // Source database (Tasks) with a relation column → Projects (many↔many).
  await newDatabase(page, `Tasks ${ts}`);
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Project');
  await chooseValue(page, page.getByLabel('Property type'), 'relation');
  await chooseLabel(page, page.getByLabel('Related database'), projects);
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Project', {exact: true})).toBeVisible();

  // Link the Projects row through the relation cell — the picker lists target rows.
  await addRowNamed(page, `Ship homepage ${ts}`);
  await page.getByRole('button', {name: 'Link a row'}).click();
  await page.getByPlaceholder('Link a row…').fill('Website');
  await page.getByRole('button', {name: new RegExp(projectRow)}).click();
  await page.keyboard.press('Escape');

  // The linked row shows as a chip (scope to the table — it also appears in the tree).
  await expect(page.getByRole('table').getByText(projectRow)).toBeVisible();

  // Hovering the chip reveals the related row's database card (#8) — a popover
  // preview whose clickable title opens the row.
  await page.getByRole('table').getByText(projectRow).hover();
  await expect(
    page.locator('[data-radix-popper-content-wrapper]').getByRole('button', {name: new RegExp(projectRow)}),
  ).toBeVisible();
  await takeSnapshot(page, testInfo); // visual: a cross-database relation + hover card
});

test('database relations: a two-way link adds a reverse column and mirrors links', async ({page}) => {
  const ts = Date.now();
  const projects = `Proj ${ts}`;
  const projectRow = `Apollo ${ts}`;

  await newDatabase(page, projects);
  await addRowNamed(page, projectRow);
  const projectsUrl = page.url(); // capture so we can return to this database later

  // Source DB with a 1:n relation → Projects, then make it two-way *before* linking
  // (the mirror runs on the link write that follows).
  await newDatabase(page, `Work ${ts}`);
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Project');
  await chooseValue(page, page.getByLabel('Property type'), 'relation');
  await chooseLabel(page, page.getByLabel('Related database'), projects);
  await chooseValue(page, page.getByLabel('Relation cardinality'), '1:n');
  await page.getByRole('button', {name: 'Add property'}).click();

  // Open the column's options and create the reverse link.
  await page.getByRole('columnheader', {name: /Project/}).getByLabel('Property options').click();
  await page.getByRole('button', {name: /two-way/i}).click();
  // The config now reports the two-way pairing (proves the cross-database schema write).
  await expect(page.getByText(/edits sync to the related database/i)).toBeVisible();
  await page.keyboard.press('Escape');

  // Link a source row to the project; the reverse column on Projects should mirror it.
  const workRow = `Build API ${ts}`;
  await addRowNamed(page, workRow);
  await page.getByRole('button', {name: 'Link a row'}).click();
  await page.getByPlaceholder('Link a row…').fill('Apollo');
  await page.getByRole('button', {name: new RegExp(projectRow)}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table').getByText(projectRow)).toBeVisible();

  // Visit the Projects database: a reverse column appeared and the Apollo row
  // now lists the source row that links to it (the cross-database mirror).
  await page.goto(projectsUrl);
  await expect(page.getByLabel('Page title')).toHaveValue(projects);
  await expect(page.getByRole('table').getByText(workRow)).toBeVisible();
});

// A couple of the new scalar column types still render their editors.
test('database types: url and multi-select columns are available', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();

  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByPlaceholder('Property name').fill('Website');
  await chooseValue(page, page.getByLabel('Property type'), 'url');
  await page.getByRole('button', {name: 'Add property'}).click();
  await expect(page.getByText('Website', {exact: true})).toBeVisible();

  await page.getByRole('button', {name: 'New row'}).click();
  const urlInput = page.getByRole('textbox', {name: 'url'}).first();
  await urlInput.fill('example.com');
  await urlInput.blur();
  await expect(page.getByRole('link', {name: 'Open'}).first()).toBeVisible();
});
