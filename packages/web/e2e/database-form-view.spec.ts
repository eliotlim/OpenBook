import {expect, test, chooseValue} from './fixtures';

test.use({freshWorkspace: true});

async function newDatabase(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();
}

test(
  'database form view: build, fill, and inspect the created row',
  {tag: ['@database', '@manager-verified']},
  async ({page}) => {
    await newDatabase(page);

    await page.getByRole('button', {name: 'Add view'}).click();
    await page.getByRole('menuitem', {name: 'Form'}).click();
    await expect(page.locator('[data-database-form-builder]')).toBeVisible();

    await page.getByRole('button', {name: 'Add field'}).click();
    await page.getByRole('menuitem', {name: 'New field'}).click();
    await page.getByPlaceholder('Question or field name').fill('Contact email');
    await chooseValue(page, page.getByLabel('Field type'), 'email');
    await page.getByRole('button', {name: 'Create field'}).click();
    await expect(page.locator('[data-form-new-field-dialog]')).toHaveCount(0);
    await expect(page.locator('[data-form-field-id]').filter({hasText: 'Contact email'})).toBeVisible();

    await page.getByRole('button', {name: 'Fill', exact: true}).click();
    const email = page.getByRole('textbox', {name: 'email'});
    await email.fill('reader@example.com');
    await email.blur();
    await page.getByRole('button', {name: 'Submit', exact: true}).click();
    await expect(page.locator('[data-database-form-confirmation]')).toContainText('Thanks');

    await page.getByRole('button', {name: 'Table', exact: true}).click();
    await expect(page.getByRole('table').getByLabel('Contact email')).toHaveValue('reader@example.com');
  },
);
