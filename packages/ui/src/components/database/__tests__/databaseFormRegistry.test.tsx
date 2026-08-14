import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {
  KNOWN_DATABASE_VIEW_TYPES,
  TITLE_PROPERTY_ID,
  type DataClient,
  type DatabaseProperty,
  type StoredDatabase,
  type DatabaseView,
} from '@book.dev/sdk';
import {ViewBody} from '../DatabaseView';
import {
  FIELDABLE_VIEW_TYPES,
  GROUPABLE_VIEW_TYPES,
  VIEW_TYPE_HINT_KEY,
  VIEW_TYPE_NEEDS_KEY,
  VIEW_TYPES,
  ViewOptionsMenu,
  viewIcon,
  viewTypePatch,
} from '../databaseMenus';
import type {UseDatabase} from '../useDatabase';
import {DataProvider} from '@/data';
import {I18nProvider} from '@/providers';

afterEach(cleanup);

describe('form view registry', () => {
  it('covers every known view type and keeps forms out of row-layout registries', () => {
    expect(VIEW_TYPES.map(({value}) => value).sort()).toEqual([...KNOWN_DATABASE_VIEW_TYPES].sort());
    expect(Object.keys(VIEW_TYPE_HINT_KEY).sort()).toEqual([...KNOWN_DATABASE_VIEW_TYPES].sort());
    expect(VIEW_TYPES.find(({value}) => value === 'form')?.label).toBe('Form');
    expect(viewIcon('form')).not.toBe(viewIcon('table'));
    expect(VIEW_TYPE_NEEDS_KEY.form).toBe('database.addView.needs.form');
    expect(GROUPABLE_VIEW_TYPES.has('form')).toBe(false);
    expect(FIELDABLE_VIEW_TYPES.has('form')).toBe(false);
  });

  it('initializes explicit writable fields and fail-closed response config when changing to form', () => {
    const properties: DatabaseProperty[] = [
      {id: 'p-text', name: 'Name', type: 'text'},
      {id: 'p-relation', name: 'Related', type: 'relation'},
      {id: 'sys_private', name: 'Reserved', type: 'text'},
    ];
    const table = {id: 'v-table', name: 'Table', type: 'table', filters: [], sorts: []} as DatabaseView;

    expect(viewTypePatch('form', table, properties)).toEqual({
      type: 'form',
      visiblePropertyIds: [TITLE_PROPERTY_ID, 'p-text'],
      formFields: {},
      formConfig: {acceptingResponses: true},
    });

    const incompleteForm = {...table, type: 'form'} as DatabaseView;
    expect(viewTypePatch('form', incompleteForm, properties)).toEqual({
      type: 'form',
      visiblePropertyIds: [TITLE_PROPERTY_ID, 'p-text'],
      formFields: {},
      formConfig: {acceptingResponses: true},
    });

    const formerForm = {
      ...table,
      type: 'table',
      visiblePropertyIds: ['p-text'],
      formFields: {'p-text': {required: true}},
      formConfig: {acceptingResponses: false, closedMessage: 'Paused'},
    } as DatabaseView;
    expect(viewTypePatch('form', formerForm, properties)).toEqual({type: 'form'});
  });

  it('disables the form layout tile when switching would strand a forms-only database', () => {
    const onlyTable = {id: 'v-table', name: 'Table', type: 'table', filters: [], sorts: []} as DatabaseView;
    const db = {
      database: {
        id: 'db-1',
        name: 'Database',
        schema: {properties: [], views: [onlyTable]},
      } as unknown as StoredDatabase,
      updateView: vi.fn().mockResolvedValue(undefined),
    } as unknown as UseDatabase;

    render(<I18nProvider><ViewOptionsMenu db={db} view={onlyTable} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', {name: 'View options'}));

    expect((screen.getByTitle('Form') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTitle('Form'));
    expect(db.updateView).not.toHaveBeenCalled();
  });
});

describe('unknown database view guard', () => {
  it('keeps x_future out of the table grid while form renders the real form view', () => {
    const unknown = {
      id: 'v-future',
      name: 'Future',
      type: 'x_future',
      filters: [],
      sorts: [],
    } as unknown as DatabaseView;

    const unknownRender = render(
      <DataProvider client={{} as DataClient}>
        <ViewBody db={{} as UseDatabase} view={unknown} columns={[]} schema={[]} />
      </DataProvider>,
    );

    expect(screen.getByText('A newer client is required to show this view.')).toBeTruthy();
    expect(unknownRender.container.querySelector('[data-unsupported-database-view="x_future"]')).toBeTruthy();
    expect(unknownRender.container.querySelector('table')).toBeNull();
    unknownRender.unmount();

    const form = {
      id: 'v-form',
      name: 'Form',
      type: 'form',
      filters: [],
      sorts: [],
      visiblePropertyIds: [],
      formFields: {},
      formConfig: {acceptingResponses: false},
    } as DatabaseView;
    const formRender = render(
      <DataProvider client={{} as DataClient}>
        <I18nProvider>
          <ViewBody db={{} as UseDatabase} view={form} columns={[]} schema={[]} canEdit={false} />
        </I18nProvider>
      </DataProvider>,
    );
    expect(formRender.container.querySelector('[data-database-form]')).toBeTruthy();
    expect(formRender.container.querySelector('[data-unsupported-database-view]')).toBeNull();
    expect(formRender.container.querySelector('table')).toBeNull();
  });
});
