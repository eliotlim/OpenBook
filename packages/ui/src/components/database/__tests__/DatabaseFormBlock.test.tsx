import * as Y from 'yjs';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {TITLE_PROPERTY_ID, type DataClient, type DatabaseProperty, type DatabaseView, type StoredDatabase} from '@book.dev/sdk';
import {DataProvider} from '@/data';
import {blockToJSON, createDoc, rootBlocks, type BlockMap} from '@/blockeditor/model';
import {getCustomBlock} from '@/blockeditor/registry';
import type {BlockEditorController} from '@/blockeditor/useBlockEditor';
import {setPageLinkBridge, type PageLinkBridge} from '@/lib/pageLinks';
import {
  databaseFormReferenceFromBlock,
  registerDatabaseFormBlock,
} from '../DatabaseFormBlock';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {useTranslation: () => ({t})};
});

afterEach(() => {
  cleanup();
  setPageLinkBridge(null);
});

const email: DatabaseProperty = {id: 'p-email', name: 'Email', type: 'email'};
const formView: DatabaseView = {
  id: 'v-form',
  name: 'Contact form',
  type: 'form',
  filters: [],
  sorts: [],
  visiblePropertyIds: [email.id],
  formFields: {[email.id]: {required: true}},
  formConfig: {acceptingResponses: true, confirmation: {type: 'message', message: 'Received.'}},
};
const database: StoredDatabase = {
  id: 'db-contact',
  pageId: 'page-contact',
  name: 'Contacts',
  schema: {properties: [email], views: [formView]},
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

function client(overrides: Partial<DataClient> = {}): DataClient {
  return {
    getDatabase: vi.fn().mockResolvedValue(database),
    getPageDatabase: vi.fn().mockResolvedValue(database),
    updateDatabase: vi.fn().mockResolvedValue(database),
    createRow: vi.fn().mockResolvedValue({id: 'row-1'}),
    listRows: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as DataClient;
}

function harness(props: Record<string, unknown> = {databaseId: database.id, viewId: formView.id}) {
  registerDatabaseFormBlock();
  const doc = createDoc([{id: 'embedded-form', type: 'dbform', props}]);
  const block: BlockMap = rootBlocks(doc).get(0);
  const editor = {doc, readOnly: false} as unknown as BlockEditorController;
  const Render = getCustomBlock('dbform')!.render;
  return {doc, block, editor, Render};
}

describe('database form block', () => {
  it('registers separately from the legacy form with disambiguated slash copy', () => {
    registerDatabaseFormBlock();
    expect(getCustomBlock('dbform')?.slash).toMatchObject({
      label: 'Database form',
      hint: 'Embed a form view from an existing database',
    });
    expect(getCustomBlock('form')?.type).not.toBe('dbform');
  });

  it('passes the mapped title through as the embedded submission row name', async () => {
    const titledView: DatabaseView = {
      ...formView,
      visiblePropertyIds: [TITLE_PROPERTY_ID, email.id],
      formFields: {
        [TITLE_PROPERTY_ID]: {label: 'Your name', required: true},
        [email.id]: {required: true},
      },
    };
    const titledDatabase = {...database, schema: {...database.schema, views: [titledView]}};
    const data = client({getDatabase: vi.fn().mockResolvedValue(titledDatabase)});
    const {block, editor, Render} = harness();
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    const title = await screen.findByRole('textbox', {name: 'Your name (required)'});
    fireEvent.change(title, {target: {value: 'Ada Lovelace'}});
    fireEvent.blur(title);
    const address = screen.getByRole('textbox', {name: 'Email (required)'});
    fireEvent.change(address, {target: {value: 'ada@example.com'}});
    fireEvent.blur(address);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    await waitFor(() => expect(data.createRow).toHaveBeenCalledWith(database.id, {
      name: 'Ada Lovelace',
      properties: {[email.id]: 'ada@example.com'},
    }));
  });

  it('renders the round-3 redirect confirmation through the shared form renderer', async () => {
    const redirectView: DatabaseView = {
      ...formView,
      formConfig: {
        acceptingResponses: true,
        confirmation: {type: 'redirect', redirectUrl: 'https://example.com/thanks'},
      },
    };
    const redirectDatabase = {...database, schema: {...database.schema, views: [redirectView]}};
    const data = client({getDatabase: vi.fn().mockResolvedValue(redirectDatabase)});
    const {block, editor, Render} = harness();
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    const input = await screen.findByRole('textbox', {name: 'Email (required)'});
    fireEvent.change(input, {target: {value: 'reader@example.com'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    expect((await screen.findByRole('link', {name: 'Continue'})).getAttribute('href'))
      .toBe('https://example.com/thanks');
  });

  it('loads only the referenced schema and submits through authenticated row creation', async () => {
    const data = client();
    const {block, editor, Render} = harness();
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    const input = await screen.findByRole('textbox', {name: 'Email (required)'});
    fireEvent.change(input, {target: {value: 'reader@example.com'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    await waitFor(() => expect(data.createRow).toHaveBeenCalledWith(database.id, {
      name: null,
      properties: {[email.id]: 'reader@example.com'},
    }));
    expect(await screen.findByText('Received.')).toBeTruthy();
    expect(data.getDatabase).toHaveBeenCalledWith(database.id);
    expect(data.listRows).not.toHaveBeenCalled();
    expect(document.querySelector('[data-database-view]')).toBeNull();
  });

  it('honours acceptingResponses=false without creating a row', async () => {
    const closed = {...database, schema: {...database.schema, views: [{...formView, formConfig: {acceptingResponses: false}}]}};
    const data = client({getDatabase: vi.fn().mockResolvedValue(closed)});
    const {block, editor, Render} = harness();
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    expect(await screen.findByText('This form is not accepting responses.')).toBeTruthy();
    expect(data.createRow).not.toHaveBeenCalled();
  });

  it.each([
    ['database', null],
    ['view', {...database, schema: {...database.schema, views: []}}],
    ['form view replaced by a table', {
      ...database,
      schema: {...database.schema, views: [{...formView, type: 'table'}]},
    }],
  ])('shows the deleted-target placeholder for a missing %s', async (_kind, target) => {
    const data = client({getDatabase: vi.fn().mockResolvedValue(target)});
    const {block, editor, Render} = harness();
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    expect(await screen.findByText('This form no longer exists.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('distinguishes an unconfigured read-only block from a deleted form', () => {
    const {block, editor, Render} = harness({});
    render(<DataProvider client={client()}><Render block={block} editor={editor} pageReadOnly /></DataProvider>);

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('No form selected.');
    expect(status.getAttribute('data-database-form-block-unavailable')).toBe('unconfigured');
  });

  it('picks database then form, persists only the reference, and undoes cleanly', async () => {
    const bridge: PageLinkBridge = {
      createSubpage: vi.fn(),
      openPage: vi.fn(),
      label: () => 'Contacts',
      icon: () => 'lucide:Heart',
      searchPages: () => [{id: database.pageId, label: 'Contacts', icon: 'lucide:Heart'}],
      createPage: vi.fn(),
    };
    setPageLinkBridge(bridge);
    const data = client();
    const {doc, block, editor, Render} = harness({});
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local']), captureTimeout: 0});
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    const databaseButton = screen.getByRole('button', {name: /Contacts/});
    expect(databaseButton.querySelector('svg')).toBeTruthy();
    expect(databaseButton.textContent).not.toContain('lucide:Heart');
    fireEvent.click(databaseButton);
    fireEvent.click(await screen.findByRole('button', {name: 'Contact form'}));

    expect(databaseFormReferenceFromBlock(block)).toEqual({databaseId: database.id, viewId: formView.id});
    expect(blockToJSON(block).props).toEqual({databaseId: database.id, viewId: formView.id});
    undo.undo();
    expect(blockToJSON(block).props).toBeUndefined();
    undo.destroy();
  });

  it('splits empty database search states and links no-form results to the database', async () => {
    const openPage = vi.fn();
    const searchPages = vi.fn((query: string) => query
      ? []
      : [{id: database.pageId, label: 'Contacts', icon: '🗃'}]);
    setPageLinkBridge({
      createSubpage: vi.fn(),
      openPage,
      label: () => 'Contacts',
      icon: () => '🗃',
      searchPages,
      createPage: vi.fn(),
    });
    const emptyForms = {...database, schema: {...database.schema, views: []}};
    const data = client({getPageDatabase: vi.fn().mockResolvedValue(emptyForms)});
    const {block, editor, Render} = harness({});
    render(<DataProvider client={data}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    fireEvent.change(screen.getByRole('textbox', {name: 'Search databases…'}), {target: {value: 'missing'}});
    expect(screen.getByText('No matching databases.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', {name: 'Search databases…'}), {target: {value: ''}});
    fireEvent.click(screen.getByRole('button', {name: /Contacts/}));

    expect(await screen.findByText('This database has no form views. Open the database to create one.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Open database'}));
    expect(openPage).toHaveBeenCalledWith(database.pageId, undefined, undefined);
  });

  it('gives an actionable empty state when no databases exist', () => {
    setPageLinkBridge({
      createSubpage: vi.fn(),
      openPage: vi.fn(),
      label: () => 'Untitled',
      icon: () => '🗃',
      searchPages: () => [],
      createPage: vi.fn(),
    });
    const {block, editor, Render} = harness({});
    render(<DataProvider client={client()}><Render block={block} editor={editor} pageReadOnly={false} /></DataProvider>);

    expect(screen.getByText('No databases yet — create one first.')).toBeTruthy();
  });

  it('round-trips the plain reference through block JSON copy/paste', () => {
    const {block} = harness();
    const copied = blockToJSON(block);
    const pasted = createDoc([{type: copied.type, props: copied.props}]);
    expect(blockToJSON(rootBlocks(pasted).get(0)).props).toEqual({databaseId: database.id, viewId: formView.id});
  });
});
