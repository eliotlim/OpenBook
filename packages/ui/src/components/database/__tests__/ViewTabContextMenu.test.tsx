import React, {useState} from 'react';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type {DatabaseView, StoredDatabase} from '@book.dev/sdk';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger} from '@/components/ui/context-menu';
import {Toolbar} from '../DatabaseView';
import type {UseDatabase} from '../useDatabase';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({pages: [], pageLabel: () => ''}),
    useTranslation: () => ({t}),
  };
});

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const active = {id: 'view-active', name: 'Active', type: 'table', filters: [], sorts: []} as DatabaseView;
const inactive = {id: 'view-inactive', name: 'Inactive', type: 'list', filters: [], sorts: []} as DatabaseView;

const makeDb = (): UseDatabase =>
  ({
    database: {
      id: 'db-1',
      name: 'Database',
      schema: {views: [active, inactive], properties: []},
    } as unknown as StoredDatabase,
    activeView: active,
    templates: [],
    search: '',
    rows: [],
    visibleRows: [],
    setSearch: vi.fn(),
    setActiveViewId: vi.fn(),
    renameView: vi.fn().mockResolvedValue(undefined),
    duplicateView: vi.fn().mockResolvedValue(undefined),
    deleteView: vi.fn().mockResolvedValue(undefined),
    updateView: vi.fn().mockResolvedValue(undefined),
    reorderView: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UseDatabase;

const Harness: React.FC<{db: UseDatabase}> = ({db}) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Toolbar
            db={db}
            view={active}
            renamingId={renamingId}
            setRenamingId={setRenamingId}
            onAddView={() => {}}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Outer database menu</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

function openInactiveTabMenu(): void {
  fireEvent.contextMenu(screen.getByRole('button', {name: 'Inactive'}));
}

describe('view-tab context menu', () => {
  it('opens the database menu from toolbar whitespace', () => {
    const db = makeDb();
    const {container} = render(<Harness db={db} />);

    fireEvent.contextMenu(container.querySelector('[data-database-toolbar]') as HTMLElement);

    expect(screen.getByText('Outer database menu')).toBeTruthy();
  });

  it('renames the inactive tab rather than the active view and stops the outer database menu', () => {
    const db = makeDb();
    render(<Harness db={db} />);

    openInactiveTabMenu();
    expect(screen.queryByText('Outer database menu')).toBeNull();
    fireEvent.click(screen.getByText('Rename view'));

    const input = screen.getByLabelText('Rename view') as HTMLInputElement;
    fireEvent.change(input, {target: {value: 'Renamed inactive'}});
    fireEvent.blur(input);

    expect(db.renameView).toHaveBeenCalledWith('view-inactive', 'Renamed inactive');
    expect(db.renameView).not.toHaveBeenCalledWith('view-active', expect.anything());
    expect(db.setActiveViewId).not.toHaveBeenCalled();
  });

  it('deletes and duplicates the inactive tab by its own view id', () => {
    const db = makeDb();
    render(<Harness db={db} />);

    openInactiveTabMenu();
    fireEvent.click(screen.getByText('Delete view'));
    expect(db.deleteView).toHaveBeenCalledWith('view-inactive');

    cleanup();
    const db2 = makeDb();
    render(<Harness db={db2} />);
    openInactiveTabMenu();
    fireEvent.click(screen.getByText('Duplicate view'));
    expect(db2.duplicateView).toHaveBeenCalledWith('view-inactive');
  });

  it('changes the inactive tab type and keeps form and delete hidden for the last row-managing view', () => {
    const db = makeDb();
    render(<Harness db={db} />);
    openInactiveTabMenu();

    const subTrigger = screen.getByText('Change type').closest('[role="menuitem"]') as HTMLElement;
    subTrigger.focus();
    fireEvent.keyDown(subTrigger, {key: 'ArrowRight'});
    fireEvent.click(screen.getByText('Board'));
    expect(db.updateView).toHaveBeenCalledWith('view-inactive', {type: 'board'});

    cleanup();
    const onlyDb = makeDb();
    onlyDb.database!.schema.views = [active];
    render(<Harness db={onlyDb} />);
    fireEvent.contextMenu(screen.getByRole('button', {name: 'Active'}));
    expect(screen.queryByText('Delete view')).toBeNull();

    const onlySubTrigger = screen.getByText('Change type').closest('[role="menuitem"]') as HTMLElement;
    onlySubTrigger.focus();
    fireEvent.keyDown(onlySubTrigger, {key: 'ArrowRight'});
    expect(screen.queryByText('Form')).toBeNull();
  });
});
