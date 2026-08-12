import {expect, test} from './fixtures';
import {SERVER} from './seed';

test.use({freshWorkspace: true});

test('form builder: palette, reorder, database binding, save, and reload persist', {tag: ['@editor', '@database']}, async ({page, request}) => {
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

  // FORM-8 review restricted the picker to a database hosted by the form's OWN
  // page (confused-deputy protection: the anonymous submission route only
  // accepts a self-hosted database) — there is no pre-existing option to pick
  // from another page anymore, so authoring always goes through "Create a new
  // database", which seeds and binds one in a single step.
  await page.locator('.obe-kit-form').hover();
  await page.getByRole('button', {name: 'Block settings'}).click();
  await page.getByRole('button', {name: 'Create a new database'}).click();
  await expect(page.getByText('Form responses · 0 rows')).toBeVisible({timeout: 15_000});
  await page.keyboard.press('Escape');

  let databaseId: string | null = null;
  await expect.poll(async () => {
    const stored = (await (await request.get(`${SERVER}/api/pages/${formPageId}`)).json()) as {
      hostedDatabaseId: string | null;
    };
    databaseId = stored.hostedDatabaseId;
    return databaseId;
  }, {timeout: 15_000}).not.toBeNull();

  await page.getByRole('button', {name: 'Settings for Email'}).click();
  await page.getByRole('combobox', {name: 'Database column'}).click();
  await page.getByRole('option', {name: 'Auto-create a compatible column'}).click();
  await expect(page.getByText(/Will create “Email” \(email\)/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Save database changes'}).click();
  await expect(page.getByText('Database columns saved.')).toBeVisible();

  interface StoredFormField {
    kind: string;
    columnId?: string;
  }
  // Field ids are client-generated UUIDs (not the literal 'email'), so the
  // planned column id is `form_<uuid>` — assert the shape (bound, non-empty),
  // not a specific literal.
  let emailColumnId = '';
  await expect.poll(async () => {
    const stored = (await (await request.get(`${SERVER}/api/pages/${formPageId}`)).json()) as {
      data: {blockdoc?: {blocks?: Array<{props?: {schema?: {fields?: StoredFormField[]}}}>}};
    };
    const fields = stored.data.blockdoc?.blocks?.[0]?.props?.schema?.fields ?? [];
    emailColumnId = fields.find((field) => field.kind === 'email')?.columnId ?? '';
    return emailColumnId;
  }, {timeout: 15_000}).toMatch(/^form_/);
  const storedDatabase = (await (await request.get(`${SERVER}/api/databases/${databaseId}`)).json()) as {
    schema: {properties: Array<{id: string; type: string}>};
  };
  expect(storedDatabase.schema.properties.some((property) => property.id === emailColumnId && property.type === 'email')).toBe(true);

  await page.reload();
  await expect(page.locator('[data-form-field-row]')).toHaveCount(5);
  await expect(page.locator('[data-form-field-row]').nth(0)).toHaveAttribute('data-form-field-kind', 'email');
  await expect(page.locator('[data-form-field-kind="email"]')).toBeVisible();
  await page.locator('.obe-kit-form').hover();
  await page.getByRole('button', {name: 'Block settings'}).click();
  await expect(page.getByText('Form responses · 0 rows')).toBeVisible();
});
