import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DataClient, FormSchema} from '@book.dev/sdk';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {DataProvider} from '@/data';
import {getCustomBlock} from '../registry';
import {FormOriginContext, registerFormBlock} from '../FormBlockView';
import {createDoc, decodeSnapshot, docToJSON, encodeSnapshot, rootBlocks} from '../model';
import {KitLockContext} from '../kit/lock';
import type {BlockEditorController} from '../useBlockEditor';

afterEach(() => cleanup());

const populatedSchema = (): FormSchema => ({
  formId: 'form-contact',
  submissionKey: 'abcdefghijklmnopqrstuv',
  enabled: true,
  databaseId: 'db-contacts',
  fields: [
    {id: 'name', kind: 'text', label: 'Name', required: true},
    {id: 'email', kind: 'email', label: 'Email', required: false},
  ],
  confirmation: {message: 'Received'},
});

function formHarness() {
  const schema = populatedSchema();
  const doc = createDoc([{id: 'form-block', type: 'form', props: {
    formId: schema.formId,
    submissionKey: schema.submissionKey,
    enabled: schema.enabled,
    databaseId: schema.databaseId,
    schema,
  }}]);
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  registerFormBlock();
  return {Render: getCustomBlock('form')!.render, block: rootBlocks(doc).get(0), editor};
}

describe('form block registration and wire shape', () => {
  it('registers an interactive slash item with fresh cryptographic ids', () => {
    registerFormBlock();
    const def = getCustomBlock('form');
    expect(def?.slash?.label).toBe('Form');
    expect(def?.slash?.group).toBe('interactive');

    const first = def!.slash!.make();
    const second = def!.slash!.make();
    expect(first.type).toBe('form');
    expect(first.props?.formId).not.toBe(second.props?.formId);
    expect(first.props?.submissionKey).not.toBe(second.props?.submissionKey);
    // TODO(FORM-1): adopt the SDK generateSubmissionKey (256-bit,
    // packages/sdk/src/forms.ts) once FORM-1 merges.
    expect(first.props?.submissionKey).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(first.props?.schema).toMatchObject({
      formId: first.props?.formId,
      submissionKey: first.props?.submissionKey,
      enabled: true,
      fields: [],
    });
  });

  it('round-trips every FORM-1 gate prop through the CRDT JSON projection', () => {
    const schema = populatedSchema();
    const doc = createDoc([{
      id: 'form-block',
      type: 'form',
      props: {
        formId: schema.formId,
        submissionKey: schema.submissionKey,
        enabled: schema.enabled,
        databaseId: schema.databaseId,
        schema,
      },
    }]);

    const reopened = decodeSnapshot(encodeSnapshot(doc));
    const projected = docToJSON(reopened)[0];
    expect(JSON.parse(JSON.stringify(projected))).toEqual({
      id: 'form-block',
      type: 'form',
      props: {
        formId: 'form-contact',
        submissionKey: 'abcdefghijklmnopqrstuv',
        enabled: true,
        databaseId: 'db-contacts',
        schema,
      },
    });
  });

  it('keeps edit and locked/read-only rendering behind separate boundaries', () => {
    const {Render, block, editor} = formHarness();
    const view = render(<Render block={block} editor={editor} pageReadOnly={false} />);
    expect(view.container.querySelector('[data-form-mode="edit"]')).toBeTruthy();
    expect(screen.getByText('Name')).toBeTruthy();
    expect(screen.getByText('email')).toBeTruthy();
    expect(screen.getByText('Open builder')).toBeTruthy();

    view.rerender(
      <FormOriginContext.Provider value="https://example.test/?page=contact">
        <Render block={block} editor={editor} pageReadOnly />
      </FormOriginContext.Provider>,
    );
    const preview = view.container.querySelector<HTMLElement>('[data-form-mode="readonly"]')!;
    expect(preview).toBeTruthy();
    expect([...preview.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every((el) => el.disabled)).toBe(true);
    expect(preview.querySelector('a')?.href).toBe('https://example.test/?page=contact');

    view.rerender(
      <KitLockContext.Provider value={{locked: true}}>
        <Render block={block} editor={editor} pageReadOnly={false} />
      </KitLockContext.Provider>,
    );
    expect(view.container.querySelector('[data-form-mode="readonly"]')).toBeTruthy();
  });

  it('resolves the bound database name and row count through the data client', async () => {
    const {Render, block, editor} = formHarness();
    const client = {
      getDatabase: vi.fn().mockResolvedValue({id: 'db-contacts', name: 'Contacts'}),
      listRows: vi.fn().mockResolvedValue([{id: 'r1'}, {id: 'r2'}]),
    } as unknown as DataClient;
    render(
      <DataProvider client={client}>
        <Render block={block} editor={editor} pageReadOnly={false} />
      </DataProvider>,
    );
    fireEvent.click(screen.getByRole('button', {name: 'Block settings'}));
    await waitFor(() => expect(screen.getByText('Contacts · 2 rows')).toBeTruthy());
    expect(client.getDatabase).toHaveBeenCalledWith('db-contacts');
    expect(client.listRows).toHaveBeenCalledWith('db-contacts');
  });
});
