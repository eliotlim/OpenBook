import {test, expect, takeSnapshot} from './fixtures';
import {useClassicEditor} from './seed';

// This spec drives the classic EditorJS editor — still fully supported, but no
// longer the default — so pin it before the app boots (see seed.ts).
test.beforeEach(async ({page}) => {
  await useClassicEditor(page);
});


// The template gallery: ready-made pages (documents and databases with sample
// rows) created client-side. These tests drive it exactly as a user would —
// open the gallery from the sidebar, pick a card, land on the created page.

async function hydrated(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
}

async function openGallery(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
}

test('gallery: lists every template with names and descriptions', async ({page}, testInfo) => {
  await hydrated(page);
  await openGallery(page);

  for (const name of ['Task tracker', 'Product roadmap', 'Reading list', 'Meeting notes', 'Weekly planner']) {
    await expect(page.getByRole('button', {name: new RegExp(name)})).toBeVisible();
  }
  await takeSnapshot(page, testInfo); // visual: the template gallery

  // Escape closes without creating anything.
  await page.keyboard.press('Escape');
  await expect(page.getByText('Start with a template')).toBeHidden();
});

test('task tracker template: creates a database page with views and sample rows', async ({page}) => {
  await hydrated(page);
  await openGallery(page);
  await page.locator('[data-template="tasks"]').click();

  // Lands on the created page: title, both views, schema columns, sample rows.
  await expect(page.getByLabel('Page title')).toHaveValue(/^Task tracker/);
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Board', exact: true})).toBeVisible();
  await expect(page.getByRole('columnheader', {name: /Priority/})).toBeVisible();
  await expect(page.getByRole('columnheader', {name: /Due/})).toBeVisible();
  const titles = page.getByRole('table').getByPlaceholder('Untitled');
  await expect(titles).toHaveCount(4);

  // The board view groups by status with the seeded columns.
  await page.getByRole('button', {name: 'Board', exact: true}).click();
  await expect(page.getByText('In progress', {exact: true})).toBeVisible();
  await expect(page.locator('[data-col-key]').filter({hasText: 'Todo'}).first()).toBeVisible();
});

test('roadmap template: opens on the timeline with ranged bars', async ({page}) => {
  await hydrated(page);
  await openGallery(page);
  await page.locator('[data-template="roadmap"]').click();

  await expect(page.getByLabel('Page title')).toHaveValue(/^Product roadmap/);
  // The first view is the timeline; the seeded initiatives render as bars.
  await expect(page.getByTitle(/drag to reschedule/).first()).toBeVisible();
  await expect(page.getByRole('button', {name: 'Timeline', exact: true})).toBeVisible();
});

test('meeting notes template: a document with agenda, notes, and action items', async ({page}) => {
  await hydrated(page);
  await openGallery(page);
  await page.locator('[data-template="meeting-notes"]').click();

  await expect(page.getByLabel('Page title')).toHaveValue(/^Meeting notes/);
  for (const heading of ['Agenda', 'Notes', 'Action items']) {
    await expect(page.locator('.ce-header', {hasText: heading})).toBeVisible();
  }
  // The agenda checklist seeded its items.
  await expect(page.getByText('Review last week’s action items')).toBeVisible();
  // The table of contents picked up the headings.
  await expect(page.locator('.block-toc__link', {hasText: 'Agenda'})).toBeVisible();
});

test('instantiating a template twice suffixes the page and row names (names are unique)', async ({page}) => {
  // A database template is the hard case: its sample-row pages share the
  // workspace-unique name space too, so both runs must fully materialize.
  await hydrated(page);
  await openGallery(page);
  await page.locator('[data-template="tasks"]').click();
  await expect(page.getByLabel('Page title')).toHaveValue(/^Task tracker/);
  const first = await page.getByLabel('Page title').inputValue();
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(4);

  await openGallery(page);
  await page.locator('[data-template="tasks"]').click();
  await expect(page.getByLabel('Page title')).not.toHaveValue(first);
  await expect(page.getByLabel('Page title')).toHaveValue(/^Task tracker \d+$/);
  // The second copy carries all four sample rows despite the name collisions.
  await expect(page.getByRole('table').getByPlaceholder('Untitled')).toHaveCount(4);
});
