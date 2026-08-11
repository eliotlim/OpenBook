import {expect, test} from './fixtures';
import {SERVER} from './seed';

test.use({freshWorkspace: true});

test('form builder: palette, reorder, database binding, save, and reload persist', {tag: ['@editor', '@database']}, async ({page, request}) => {
  const databasePageResponse = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Form responses',
      data: {editorjs: {blocks: []}, values: [], names: []},
    },
  });
  const databasePageId = ((await databasePageResponse.json()) as {id: string}).id;
  const databaseResponse = await request.post(`${SERVER}/api/databases`, {
    data: {pageId: databasePageId, name: 'Form responses', schema: {properties: [], views: []}},
  });
  const databaseId = ((await databaseResponse.json()) as {id: string}).id;

  const schema = {
    formId: 'form-e2e-builder',
    fields: [],
    confirmation: {message: 'Thanks'},
    submissionKey: 'abcdefghijklmnopqrstuv',
    enabled: true,
  };
  const formPageResponse = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Builder persistence',
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [{
          id: 'form-block',
          type: 'form',
          props: {
            formId: schema.formId,
            submissionKey: schema.submissionKey,
            enabled: schema.enabled,
            schema,
          },
        }]},
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    },
  });
  const formPageId = ((await formPageResponse.json()) as {id: string}).id;

  await page.goto(`/?page=${formPageId}`);
  await expect(page.locator('[data-form-builder]')).toBeVisible();
  for (const name of ['Short text', 'Email', 'Number', 'Select', 'Files']) {
    await page.getByRole('button', {name: `Add ${name}`}).click();
  }
  const rows = page.locator('[data-form-field-row]');
  await expect(rows).toHaveCount(5);

  const numberRow = page.locator('[data-form-field-kind="number"]');
  const numberBox = (await numberRow.boundingBox())!;
  await page.getByRole('button', {name: 'Drag Short text'}).dragTo(numberRow, {
    targetPosition: {x: numberBox.width / 2, y: numberBox.height - 2},
  });
  await expect(rows.nth(0)).toHaveAttribute('data-form-field-kind', 'email');
  await expect(rows.nth(2)).toHaveAttribute('data-form-field-kind', 'text');

  await page.locator('.obe-kit-form').hover();
  await page.getByRole('button', {name: 'Block settings'}).click();
  await page.getByRole('combobox', {name: 'Submission database'}).click();
  await page.getByRole('option', {name: 'Form responses'}).click();

  await page.getByRole('button', {name: 'Settings for Email'}).click();
  await page.getByRole('combobox', {name: 'Database column'}).click();
  await page.getByRole('option', {name: 'Auto-create a compatible column'}).click();
  await expect(page.getByText(/Will create “Email” \(email\)/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Save database changes'}).click();
  await expect(page.getByText('Database columns saved.')).toBeVisible();

  await expect.poll(async () => {
    const stored = (await (await request.get(`${SERVER}/api/pages/${formPageId}`)).json()) as {data: unknown};
    return JSON.stringify(stored.data);
  }, {timeout: 15_000}).toContain('form_email');
  const storedDatabase = (await (await request.get(`${SERVER}/api/databases/${databaseId}`)).json()) as {
    schema: {properties: Array<{id: string}>};
  };
  expect(storedDatabase.schema.properties.some((property) => property.id === 'form_email')).toBe(true);

  await page.reload();
  await expect(page.locator('[data-form-field-row]')).toHaveCount(5);
  await expect(page.locator('[data-form-field-row]').nth(0)).toHaveAttribute('data-form-field-kind', 'email');
  await expect(page.locator('[data-form-field-kind="email"]')).toBeVisible();
  await page.locator('.obe-kit-form').hover();
  await page.getByRole('button', {name: 'Block settings'}).click();
  await expect(page.getByText('Form responses · 0 rows')).toBeVisible();
});
