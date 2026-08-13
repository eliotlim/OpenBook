import {expect, test, chooseValue} from './fixtures';

test.use({freshWorkspace: true});

async function newDatabase(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await expect(page.locator('[data-home-screen]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('New database');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Add column'})).toBeVisible();

  const renamed = page.waitForResponse(
    (response) => response.request().method() === 'PATCH'
      && /\/api\/pages\/[^/]+$/.test(response.url())
      && response.ok(),
  );
  await page.getByLabel('Page title').fill('Contacts');
  await page.keyboard.press('Tab');
  await renamed;
  return new URL(page.url()).searchParams.get('page')!;
}

test(
  'database form block: pick and submit from a non-database page',
  {tag: ['@database', '@editor', '@manager-verified']},
  async ({page}) => {
    const databasePageId = await newDatabase(page);

    await page.getByRole('button', {name: 'Add view'}).click();
    await page.getByRole('menuitem', {name: 'Form'}).click();
    await expect(page.locator('[data-database-form-builder]')).toBeVisible();

    await page.getByRole('button', {name: 'Add field'}).click();
    await page.getByRole('menuitem', {name: 'New field'}).click();
    await page.getByPlaceholder('Question or field name').fill('Contact email');
    await chooseValue(page, page.getByLabel('Field type'), 'email');
    await page.getByRole('button', {name: 'Create field'}).click();
    await expect(page.locator('[data-form-field-id]').filter({hasText: 'Contact email'})).toBeVisible();

    const before = new URL(page.url()).searchParams.get('page');
    await page.keyboard.press('ControlOrMeta+n');
    await expect
      .poll(() => {
        const id = new URL(page.url()).searchParams.get('page');
        return id && id !== before ? id : null;
      })
      .toBeTruthy();
    await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Add column'})).toHaveCount(0);

    await page.locator('.obe-text').first().click();
    await page.keyboard.type('/form database');
    await expect(page.locator('.obe-slash-label').first()).toHaveText('Form — database');
    await page.keyboard.press('Enter');

    const picker = page.locator('[data-database-form-picker]');
    await expect(picker).toBeVisible();
    await picker.getByRole('button', {name: /Contacts/}).click();
    await picker.getByRole('button', {name: 'Form', exact: true}).click();

    const formBlock = page.locator('[data-block-type="dbform"]');
    await expect(formBlock.locator('[data-database-form-fill]')).toBeVisible();
    await expect(formBlock.getByRole('table')).toHaveCount(0);
    await expect(formBlock.getByRole('button', {name: 'Add view'})).toHaveCount(0);

    const email = formBlock.getByRole('textbox', {name: 'email'});
    await email.fill('embedded@example.com');
    await email.blur();
    await formBlock.getByRole('button', {name: 'Submit', exact: true}).click();
    await expect(formBlock.locator('[data-database-form-confirmation]')).toBeVisible();

    await page.goto(`/?page=${databasePageId}`);
    await page.getByRole('button', {name: 'Table', exact: true}).click();
    await expect(page.getByRole('table').getByLabel('Contact email')).toHaveValue('embedded@example.com');
  },
);
