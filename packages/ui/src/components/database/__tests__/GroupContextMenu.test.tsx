import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import type {DatabaseProperty, RowGroup} from '@book.dev/sdk';
import {GroupContextMenu} from '../databaseLayouts';
import type {UseDatabase} from '../useDatabase';

// GroupContextMenu resolves page-group renames through the navigation provider;
// stub it so the component can mount without the full provider tree.
vi.mock('@/providers', () => ({
  useNavigation: () => ({renamePage: vi.fn()}),
}));

afterEach(() => cleanup());

const prop: DatabaseProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    {id: 'opt1', label: 'Todo', color: 'blue'},
    {id: 'opt2', label: 'Done', color: 'green'},
  ],
};

const optionGroup: RowGroup = {key: 'opt1', label: 'Todo', color: 'blue', rows: []};
const sentinelGroup: RowGroup = {key: '__none__', label: 'No value', color: undefined, rows: []};

const makeDb = (): UseDatabase =>
  ({updateProperty: vi.fn().mockResolvedValue(undefined)}) as unknown as UseDatabase;

function renderMenu(group: RowGroup, db: UseDatabase): void {
  render(
    <GroupContextMenu
      db={db}
      group={group}
      prop={prop}
      groupByParent={false}
      collapsed={false}
      onToggle={() => {}}
      onCollapseAll={() => {}}
      onExpandAll={() => {}}
    >
      <button data-testid="hdr">{group.label}</button>
    </GroupContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('hdr'));
}

describe('GroupContextMenu', () => {
  it('opens a group menu (not the DB menu) on right-click of a group header', () => {
    renderMenu(optionGroup, makeDb());
    expect(screen.getByText('Rename group')).toBeTruthy();
    expect(screen.getByText('Change colour')).toBeTruthy();
    expect(screen.getByText('Collapse all')).toBeTruthy();
    expect(screen.getByText('Expand all')).toBeTruthy();
    expect(screen.getByText('Delete group')).toBeTruthy();
    // The DB-level "Rename view" must NOT be part of this menu.
    expect(screen.queryByText('Rename view')).toBeNull();
  });

  it('deletes an option group by removing its option from the property', () => {
    const db = makeDb();
    renderMenu(optionGroup, db);
    fireEvent.click(screen.getByText('Delete group'));
    expect(db.updateProperty).toHaveBeenCalledWith('status', {options: [prop.options![1]]});
  });

  it('disables rename / delete for the "No value" sentinel group', () => {
    renderMenu(sentinelGroup, makeDb());
    expect(screen.getByText('Rename group').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    // A sentinel group is not an editable option, so Delete is not offered at all.
    expect(screen.queryByText('Delete group')).toBeNull();
  });
});
