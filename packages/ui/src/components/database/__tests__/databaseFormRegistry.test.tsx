import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import {
  KNOWN_DATABASE_VIEW_TYPES,
  type DatabaseProperty,
  type DatabaseView,
} from '@book.dev/sdk';
import {ViewBody} from '../DatabaseView';
import {
  FIELDABLE_VIEW_TYPES,
  GROUPABLE_VIEW_TYPES,
  VIEW_TYPE_HINT_KEY,
  VIEW_TYPE_NEEDS_KEY,
  VIEW_TYPES,
  viewIcon,
  viewTypePatch,
} from '../databaseMenus';
import type {UseDatabase} from '../useDatabase';

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
      visiblePropertyIds: ['p-text'],
      formFields: {},
      formConfig: {acceptingResponses: true},
    });
  });
});

describe('unknown database view guard', () => {
  it('keeps an unknown persisted type out of the table and form renderers', () => {
    const unknown = {
      id: 'v-future',
      name: 'Future',
      type: 'future-layout',
      filters: [],
      sorts: [],
    } as unknown as DatabaseView;

    const {container} = render(
      <ViewBody db={{} as UseDatabase} view={unknown} columns={[]} schema={[]} />,
    );

    expect(screen.getByText('A newer client is required to show this view.')).toBeTruthy();
    expect(container.querySelector('[data-unsupported-database-view="future-layout"]')).toBeTruthy();
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('[data-database-form]')).toBeNull();
  });
});
