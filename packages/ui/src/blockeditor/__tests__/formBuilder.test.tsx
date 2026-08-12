import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DataClient, FormSchema, StoredDatabase} from '@book.dev/sdk';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {DataProvider} from '@/data';
import {ConfirmProvider} from '@/providers/ConfirmProvider';
import {
  createPlannedFormColumns,
  FormEditView,
  FormSettings,
  formPatternIssue,
  storedFormSchema,
} from '../FormBuilder';
import {createDoc, rootBlocks} from '../model';
import type {BlockEditorController} from '../useBlockEditor';

afterEach(() => cleanup());

const schemaFixture = (): FormSchema => ({
  formId: 'form-builder',
  submissionKey: 'abcdefghijklmnopqrstuv',
  enabled: true,
  fields: [
    {id: 'name', kind: 'text', label: 'Name', required: false},
    {id: 'email', kind: 'email', label: 'Email', required: false},
    {id: 'choice', kind: 'select', label: 'Choice', required: false, options: []},
  ],
  confirmation: {message: 'Thanks'},
});

function harness(schema = schemaFixture()) {
  const doc = createDoc([{id: 'form-block', type: 'form', props: {
    formId: schema.formId,
    submissionKey: schema.submissionKey,
    enabled: schema.enabled,
    databaseId: schema.databaseId,
    schema,
  }}]);
  const block = rootBlocks(doc).get(0);
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  return {block, editor, schema, read: () => storedFormSchema(block)!};
}

describe('form builder canvas', () => {
  it('adds and removes every field through accessible palette/row controls', () => {
    const {block, editor, schema, read} = harness();
    render(<FormEditView schema={schema} block={block} editor={editor} />);

    fireEvent.click(screen.getByRole('button', {name: 'Add Files'}));
    expect(read().fields.map((field) => field.kind)).toEqual(['text', 'email', 'select', 'files']);
    fireEvent.click(screen.getByRole('button', {name: 'Actions for Files'}));
    fireEvent.click(screen.getByRole('button', {name: 'Remove field'}));
    expect(read().fields.map((field) => field.kind)).toEqual(['text', 'email', 'select']);
  });

  it('reorders with an HTML5 drag and the focused-row keyboard alternative', () => {
    const {block, editor, schema, read} = harness();
    const view = render(<FormEditView schema={schema} block={block} editor={editor} />);
    const firstGrip = screen.getByRole('button', {name: 'Drag Name'});
    const target = view.container.querySelector<HTMLElement>('[data-form-field-row="email"]')!;
    target.getBoundingClientRect = vi.fn(() => ({top: 0, height: 100} as DOMRect));

    fireEvent.dragStart(firstGrip);
    fireEvent.dragOver(target, {clientY: 90});
    fireEvent.drop(target, {clientY: 90});
    expect(read().fields.map((field) => field.id)).toEqual(['email', 'name', 'choice']);

    const choice = view.container.querySelector<HTMLElement>('[data-form-field-row="choice"]')!;
    fireEvent.keyDown(choice, {key: 'ArrowUp', altKey: true});
    expect(read().fields.map((field) => field.id)).toEqual(['email', 'choice', 'name']);
  });

  it('round-trips field settings, validation, options, and honeypot state', () => {
    const {block, editor, schema, read} = harness();
    render(<FormEditView schema={schema} block={block} editor={editor} />);

    fireEvent.click(screen.getByRole('button', {name: 'Settings for Name'}));
    const nameSettings = screen.getByText('Settings for Name').closest<HTMLElement>('[data-form-field-settings]')!;
    fireEvent.change(within(nameSettings).getByLabelText('Label'), {target: {value: 'Full name'}});
    fireEvent.change(within(nameSettings).getByLabelText('Placeholder'), {target: {value: 'Ada Lovelace'}});
    fireEvent.click(within(nameSettings).getByLabelText('Required'));
    fireEvent.change(within(nameSettings).getByLabelText('Minimum length'), {target: {value: '2'}});
    fireEvent.change(within(nameSettings).getByLabelText('Maximum length'), {target: {value: '80'}});
    fireEvent.change(within(nameSettings).getByLabelText(/Pattern/), {target: {value: '(a+)+'}});
    expect(within(nameSettings).getByRole('alert').textContent).toContain('too complex');
    fireEvent.change(within(nameSettings).getByLabelText(/Pattern/), {target: {value: '^[A-Za-z ]+$'}});
    fireEvent.click(within(nameSettings).getByText('Advanced'));
    fireEvent.click(within(nameSettings).getByLabelText('Honeypot field'));

    expect(read().fields[0]).toMatchObject({
      label: 'Full name',
      placeholder: 'Ada Lovelace',
      required: true,
      honeypot: true,
      validation: {minLength: 2, maxLength: 80, pattern: '^[A-Za-z ]+$'},
    });

    fireEvent.click(screen.getByRole('button', {name: 'Settings for Choice'}));
    const choiceSettings = screen.getByText('Settings for Choice').closest<HTMLElement>('[data-form-field-settings]')!;
    fireEvent.click(within(choiceSettings).getByRole('button', {name: /Add option/}));
    fireEvent.change(within(choiceSettings).getByLabelText('Option label 1'), {target: {value: 'First option'}});
    fireEvent.change(within(choiceSettings).getByLabelText('Option ID 1'), {target: {value: 'first'}});
    expect(read().fields[2].options).toEqual([{id: 'first', label: 'First option'}]);
  });

  it('surfaces the same unsafe pattern classes as the SDK validator screen', () => {
    expect(formPatternIssue('^ok+$')).toBeNull();
    expect(formPatternIssue('[')).toBe('invalid');
    expect(formPatternIssue('(a+)+')).toBe('unsafe');
    expect(formPatternIssue('x'.repeat(257))).toBe('too_long');
  });
});

describe('form database binding and gates', () => {
  const database = (): StoredDatabase => ({
    id: 'db-contact',
    pageId: 'page-contact',
    name: 'Contacts',
    schema: {
      properties: [{id: 'email_address', name: 'Email address', type: 'email'}],
      views: [],
    },
    createdAt: '',
    updatedAt: '',
  });

  it('binds a compatible column, previews the SDK auto-plan, and applies it with updateDatabase', async () => {
    const schema = {...schemaFixture(), databaseId: 'db-contact'};
    const {block, editor, read} = harness(schema);
    const db = database();
    const client = {
      getDatabase: vi.fn().mockResolvedValue(db),
      updateDatabase: vi.fn().mockImplementation(async (_id, patch) => ({...db, schema: patch.schema})),
    } as unknown as DataClient;
    render(
      <DataProvider client={client}>
        <FormEditView schema={schema} block={block} editor={editor} />
      </DataProvider>,
    );
    await waitFor(() => expect(client.getDatabase).toHaveBeenCalledWith('db-contact'));

    fireEvent.click(screen.getByRole('button', {name: 'Settings for Email'}));
    fireEvent.click(screen.getByRole('combobox', {name: 'Database column'}));
    fireEvent.click(screen.getByRole('option', {name: 'Email address'}));
    expect(read().fields[1].columnId).toBe('email_address');

    fireEvent.click(screen.getByRole('combobox', {name: 'Database column'}));
    fireEvent.click(screen.getByRole('option', {name: 'Auto-create a compatible column'}));
    expect(await screen.findByText(/Will create “Email” \(email\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Save database changes'}));

    await waitFor(() => expect(client.updateDatabase).toHaveBeenCalledTimes(1));
    expect(client.updateDatabase).toHaveBeenCalledWith('db-contact', expect.objectContaining({
      schema: expect.objectContaining({
        properties: expect.arrayContaining([expect.objectContaining({id: 'form_email', type: 'email'})]),
      }),
    }));
    expect(read().fields[1].columnId).toBe('form_email');
  });

  it('applies only selected plan entries in the pure save wiring', async () => {
    const schema = {...schemaFixture(), databaseId: 'db-contact'};
    const db = database();
    const client = {
      getDatabase: vi.fn().mockResolvedValue(db),
      updateDatabase: vi.fn().mockImplementation(async (_id, patch) => ({...db, schema: patch.schema})),
    };
    const result = await createPlannedFormColumns(client, schema, db, new Set(['name']));
    expect(result.schema.fields[0].columnId).toBe('form_name');
    expect(result.schema.fields[1].columnId).toBeUndefined();
    expect(client.updateDatabase).toHaveBeenCalledWith('db-contact', expect.anything());
  });

  it('regenerates the submission key only after the in-app confirmation', async () => {
    const {block, editor, schema, read} = harness();
    render(
      <ConfirmProvider>
        <FormSettings schema={schema} block={block} editor={editor} />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', {name: 'Regenerate key'}));
    expect(screen.getByText(/current public link and existing embeds stop accepting submissions/)).toBeTruthy();
    expect(read().submissionKey).toBe('abcdefghijklmnopqrstuv');
    const regenerateButtons = screen.getAllByRole('button', {name: 'Regenerate key'});
    fireEvent.click(regenerateButtons[regenerateButtons.length - 1]);
    await waitFor(() => expect(read().submissionKey).not.toBe('abcdefghijklmnopqrstuv'));
    expect(read().submissionKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips submit, confirmation, and enabled form settings', () => {
    const {block, editor, schema, read} = harness();
    const content = (next: FormSchema) => (
      <ConfirmProvider>
        <FormSettings schema={next} block={block} editor={editor} />
      </ConfirmProvider>
    );
    const view = render(content(schema));

    fireEvent.change(screen.getByLabelText('Submit button label'), {target: {value: 'Send response'}});
    view.rerender(content(read()));
    fireEvent.click(screen.getByRole('combobox', {name: 'After submission'}));
    fireEvent.click(screen.getByRole('option', {name: 'Redirect to a URL'}));
    view.rerender(content(read()));
    fireEvent.change(screen.getByLabelText('Redirect URL'), {target: {value: 'https://example.test/thanks'}});
    view.rerender(content(read()));
    fireEvent.click(screen.getByLabelText('Accept submissions'));

    expect(read()).toMatchObject({
      submitLabel: 'Send response',
      confirmation: {redirectUrl: 'https://example.test/thanks'},
      enabled: false,
    });
  });
});
