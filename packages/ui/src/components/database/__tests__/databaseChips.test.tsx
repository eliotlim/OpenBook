import React, {useState} from 'react';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import type {DatabaseFilter, DatabaseProperty, DatabaseView, StoredDatabase} from '@book.dev/sdk';
import {FilterChips, FilterMenu, GroupChips, SortChips} from '../databaseMenus';
import type {UseDatabase} from '../useDatabase';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({pages: [], pageLabel: () => ''}),
    useTranslation: () => ({t}),
  };
});

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!('ResizeObserver' in globalThis)) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const properties: DatabaseProperty[] = [
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'todo', label: 'Todo', color: 'blue'},
      {id: 'done', label: 'Done', color: 'green'},
    ],
  },
  {id: 'due', name: 'Due', type: 'date'},
];

const filter: DatabaseFilter = {id: 'filter-1', propertyId: 'status', operator: 'equals', value: 'todo'};
const filterView = {
  id: 'view-1',
  name: 'Table',
  type: 'table',
  filters: [],
  sorts: [],
  filterRoot: {id: 'root', conjunction: 'and', filters: [filter]},
} as DatabaseView;
const sortView = {
  ...filterView,
  filterRoot: undefined,
  sorts: [
    {propertyId: 'status', direction: 'asc'},
    {propertyId: 'due', direction: 'desc'},
  ],
} as DatabaseView;
const groupView = {...filterView, filterRoot: undefined, groupByPropertyId: 'status'} as DatabaseView;

const makeDb = (view: DatabaseView): UseDatabase =>
  ({
    database: {
      id: 'db-1',
      name: 'Database',
      schema: {views: [view], properties},
    } as unknown as StoredDatabase,
    updateView: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UseDatabase;

const EditableFilter: React.FC<{db: UseDatabase}> = ({db}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FilterMenu
        database={db.database!}
        view={filterView}
        onChange={(patch) => void db.updateView(filterView.id, patch)}
        open={open}
        onOpenChange={setOpen}
      />
      <FilterChips db={db} view={filterView} onEdit={() => setOpen(true)} />
    </>
  );
};

describe('database filter/sort/group chip context menus', () => {
  it('opens the existing filter editor popover from Edit…', async () => {
    const db = makeDb(filterView);
    render(<EditableFilter db={db} />);

    fireEvent.contextMenu(screen.getByTitle('Status is Todo'));
    fireEvent.click(screen.getByText('Edit…'));

    await waitFor(() => expect(screen.getByLabelText('Remove condition')).toBeTruthy());
  });

  it('removes the right-clicked filter without marking the action destructive', () => {
    const db = makeDb(filterView);
    render(<FilterChips db={db} view={filterView} onEdit={() => {}} />);

    fireEvent.contextMenu(screen.getByTitle('Status is Todo'));
    const remove = screen.getByText('Remove').closest('[role="menuitem"]') as HTMLElement;
    expect(remove.className).not.toContain('text-destructive');
    fireEvent.click(remove);

    expect(db.updateView).toHaveBeenCalledWith('view-1', {
      filterRoot: {id: 'root', conjunction: 'and', filters: []},
      filters: [],
    });
  });

  it('moves a sort up and down while disabling the unavailable edge direction', () => {
    const db = makeDb(sortView);
    render(<SortChips db={db} view={sortView} onEdit={() => {}} />);

    fireEvent.contextMenu(screen.getByText('Due'));
    expect(screen.getByText('Move down').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByText('Move up'));
    expect(db.updateView).toHaveBeenCalledWith('view-1', {
      sorts: [
        {propertyId: 'due', direction: 'desc'},
        {propertyId: 'status', direction: 'asc'},
      ],
    });

    cleanup();
    const db2 = makeDb(sortView);
    render(<SortChips db={db2} view={sortView} onEdit={() => {}} />);
    fireEvent.contextMenu(screen.getByText('Status'));
    expect(screen.getByText('Move up').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByText('Move down'));
    expect(db2.updateView).toHaveBeenCalledWith('view-1', {
      sorts: [
        {propertyId: 'due', direction: 'desc'},
        {propertyId: 'status', direction: 'asc'},
      ],
    });
  });

  it('removes grouping and exposes Edit… on the grouping chip', () => {
    const db = makeDb(groupView);
    const onEdit = vi.fn();
    render(<GroupChips db={db} view={groupView} onEdit={onEdit} />);

    fireEvent.contextMenu(screen.getByTitle('Status'));
    expect(screen.getByText('Edit…')).toBeTruthy();
    fireEvent.click(screen.getByText('Remove'));
    expect(db.updateView).toHaveBeenCalledWith('view-1', {
      groupByPropertyId: undefined,
      subGroupByPropertyId: undefined,
    });
  });
});
