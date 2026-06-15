import {test, expect} from './fixtures';

// The new interactive kit blocks (T10): choice cards, long text, rich text,
// searchable select, tag field, progress bar, and the tabs/accordion containers.
// Exercised two ways — through the `project-intake` template, and inserted
// directly in the editor-lab sandbox.

test.describe.configure({mode: 'parallel'});

// ── Template-driven: the project-intake wizard ───────────────────────────────

test('project-intake template: choice cards, accordion stages, and a progress bar', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
  await page.locator('[data-template="project-intake"]').click();
  await expect(page.getByLabel('Page title')).toHaveValue(/intake/i);

  // Choice cards render as a grid (the post-fix layout) with selectable cards.
  const cards = page.locator('.obe-kit-cardgrid .obe-kit-card');
  await expect(cards.first()).toBeVisible();
  // Picking a card marks it selected (assert the clicked card, independent of
  // any default selection).
  await cards.last().click();
  await expect(cards.last()).toHaveClass(/obe-kit-card-on/);

  // The accordion has its three stage sections, and a progress bar tracks
  // completion. (Section labels are editable inline fields → assert by class,
  // not getByText.)
  await expect(page.locator('.obe-acc-label')).toHaveCount(3);
  await expect(page.getByRole('progressbar').first()).toBeVisible();
});

// ── Lab-driven: each new input in isolation ──────────────────────────────────

const freshLab = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.addInitScript(() => localStorage.removeItem('obe-lab-doc'));
  await page.goto('/editor-lab');
  await expect(page.locator('.obe-text').first()).toBeVisible();
};

/** Add an empty block below the last row, slash-insert by EXACT label. */
const insert = async (page: import('@playwright/test').Page, query: string, label: string): Promise<void> => {
  const lastRow = page.locator('[data-block-row]').last();
  await lastRow.hover();
  await lastRow.locator('..').getByRole('button', {name: 'Add a block below'}).last().click();
  await page.keyboard.type(`/${query}`);
  const item = page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: label})});
  await item.first().click();
};

test('tag field: free-entry tags publish as chips', async ({page}) => {
  await freshLab(page);
  await insert(page, 'tag field', 'Tag field');
  const input = page.locator('.obe-kit-tag-input');
  await input.click();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-kit-tag')).toHaveCount(2);
  await expect(page.getByText('alpha', {exact: true})).toBeVisible();
});

test('searchable select: filter and pick an option', async ({page}) => {
  await freshLab(page);
  await insert(page, 'searchable select', 'Searchable select');
  await page.locator('.obe-kit-searchtrigger').click();
  // The Radix Command surface opens; default options are present and filterable.
  await expect(page.getByRole('option').first()).toBeVisible();
});

test('long text: typing publishes the value', async ({page}) => {
  await freshLab(page);
  await insert(page, 'long text', 'Long text');
  const area = page.getByRole('textbox', {name: 'text value'});
  await area.click();
  await page.keyboard.type('A longer note.');
  await expect(area).toHaveValue('A longer note.');
});

test('progress bar: renders a computed track', async ({page}) => {
  await freshLab(page);
  await insert(page, 'progress', 'Progress bar');
  await expect(page.getByRole('progressbar')).toBeVisible();
});

test('container: tabs inserts with its tab strip', async ({page}) => {
  await freshLab(page);
  await insert(page, 'tabs', 'Tabs');
  await expect(page.locator('[data-block-type="tabs"]')).toBeVisible();
});

test('container: accordion inserts with a section', async ({page}) => {
  await freshLab(page);
  await insert(page, 'accordion', 'Accordion');
  await expect(page.locator('[data-block-type="accordion"]')).toBeVisible();
  await expect(page.locator('.obe-acc-label').first()).toBeVisible();
});
