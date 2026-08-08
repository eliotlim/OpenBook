import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import type {DatabaseProperty, DatabaseView} from '@book.dev/sdk';
import {ContextMenu, ContextMenuContent, ContextMenuTrigger} from '@/components/ui/context-menu';
import {ColumnMenuItems, popoverColumnComponents, RowMenuItems} from '../databaseMenuItems';
import type {UseDatabase} from '../useDatabase';

// The shared item lists translate their labels — hand them the real (English)
// `t` so assertions read like the UI. Copy link goes through useCopyPageLink.
vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({setPageHint: vi.fn()}),
    useTranslation: () => ({t}),
  };
});
const {copyLink} = vi.hoisted(() => ({copyLink: vi.fn()}));
vi.mock('@/lib/useCopyPageLink', () => ({
  useCopyPageLink: () => copyLink,
}));

afterEach(() => {
  cleanup();
  copyLink.mockClear();
});

const property: DatabaseProperty = {id: 'p1', name: 'Status', type: 'select', options: []};
const view = {id: 'v1', name: 'Table', type: 'table', filters: [], sorts: []} as unknown as DatabaseView;

const makeDb = (): UseDatabase =>
  ({
    hostPageId: 'db-host',
    database: {schema: {properties: [property], views: [view]}},
    activeView: view,
    openRow: vi.fn(),
    openRowIn: vi.fn(),
    addRowBefore: vi.fn().mockResolvedValue(undefined),
    addRowAfter: vi.fn().mockResolvedValue(undefined),
    duplicateRow: vi.fn().mockResolvedValue(undefined),
    deleteRow: vi.fn().mockResolvedValue(undefined),
    saveAsTemplate: vi.fn().mockResolvedValue(undefined),
    updateView: vi.fn().mockResolvedValue(undefined),
    insertProperty: vi.fn().mockResolvedValue('p-new'),
    duplicateProperty: vi.fn().mockResolvedValue(undefined),
    deleteProperty: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UseDatabase;

// ── RowMenuItems: bulk (multi-select) section ────────────────────────────────

function renderRowMenu(db: UseDatabase, bulk?: {count: number; onDuplicate: () => void; onDelete: () => void}): void {
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button data-testid="row">Row</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <RowMenuItems db={db} rowId="row-1" menu="context" bulk={bulk} />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('row'));
}

describe('RowMenuItems (shared row list, TBL-9)', () => {
  it('replaces clicked-row duplicate/delete with the whole-selection pair', () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    const db = makeDb();
    renderRowMenu(db, {count: 3, onDuplicate, onDelete});
    expect(screen.queryByText('Duplicate')).toBeNull();
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.getByText('Delete 3 rows')).toBeTruthy();
    fireEvent.click(screen.getByText('Duplicate 3 rows'));
    expect(onDuplicate).toHaveBeenCalled();
    expect(db.duplicateRow).not.toHaveBeenCalled();
  });

  it('bulk delete acts on the selection, not just the clicked row', () => {
    const onDelete = vi.fn();
    const db = makeDb();
    renderRowMenu(db, {count: 2, onDuplicate: vi.fn(), onDelete});
    fireEvent.click(screen.getByText('Delete 2 rows'));
    expect(onDelete).toHaveBeenCalled();
    expect(db.deleteRow).not.toHaveBeenCalled();
  });

  it('shows no bulk section for a single-row selection', () => {
    renderRowMenu(makeDb(), {count: 1, onDuplicate: vi.fn(), onDelete: vi.fn()});
    expect(screen.queryByText(/rows$/)).toBeNull();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('offers "Save as template" only on the withTemplate (⋯ dropdown) surface', () => {
    renderRowMenu(makeDb());
    expect(screen.queryByText('Save as template')).toBeNull();
  });
});

// ── ColumnMenuItems: one list, two render families ───────────────────────────

function renderColumnMenu(db: UseDatabase, onEditProperty?: () => void): void {
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button data-testid="header">Status</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ColumnMenuItems db={db} view={view} property={property} menu="context" onEditProperty={onEditProperty} />
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('header'));
}

describe('ColumnMenuItems (shared column list, TBL-9)', () => {
  it('offers sort / filter / group / hide / insert / duplicate / delete', () => {
    renderColumnMenu(makeDb(), vi.fn());
    for (const label of [
      'Sort ascending',
      'Sort descending',
      'Filter by Status',
      'Group by Status',
      'Hide in view',
      'Insert left',
      'Insert right',
      'Duplicate property',
      'Edit property…',
      'Delete property',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('sorting writes the sort onto the VIEW (persisted state)', () => {
    const db = makeDb();
    renderColumnMenu(db);
    fireEvent.click(screen.getByText('Sort descending'));
    expect(db.updateView).toHaveBeenCalledWith('v1', {sorts: [{propertyId: 'p1', direction: 'desc'}]});
  });

  it('"Filter by" appends a persisted view condition (valueless default)', () => {
    const db = makeDb();
    renderColumnMenu(db);
    fireEvent.click(screen.getByText('Filter by Status'));
    expect(db.updateView).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        filterRoot: expect.objectContaining({
          filters: [expect.objectContaining({propertyId: 'p1', operator: 'is_not_empty'})],
        }),
      }),
    );
  });

  it('hides the column by writing the view visible-property list', () => {
    const db = makeDb();
    renderColumnMenu(db);
    fireEvent.click(screen.getByText('Hide in view'));
    expect(db.updateView).toHaveBeenCalledWith('v1', {visiblePropertyIds: []});
  });

  it('inserts a property left/right of the anchor, scoped to the view', () => {
    const db = makeDb();
    renderColumnMenu(db);
    fireEvent.click(screen.getByText('Insert left'));
    expect(db.insertProperty).toHaveBeenCalledWith({name: '', type: 'text'}, 'p1', 'left', 'v1');
  });

  it('the same list renders as the property-editor button stack (no drift)', () => {
    const db = makeDb();
    const close = vi.fn();
    render(
      <div>
        <ColumnMenuItems db={db} view={view} property={property} components={popoverColumnComponents(close)} />
      </div>,
    );
    // No Radix menu around it: the items are plain buttons now.
    fireEvent.click(screen.getByText('Insert right'));
    expect(db.insertProperty).toHaveBeenCalledWith({name: '', type: 'text'}, 'p1', 'right', 'v1');
    expect(close).toHaveBeenCalled();
    // "Edit property…" is a context-menu-only item (the popover IS the editor).
    expect(screen.queryByText('Edit property…')).toBeNull();
  });
});
