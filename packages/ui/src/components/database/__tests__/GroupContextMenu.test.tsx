import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import type {DatabaseProperty, RowGroup} from '@book.dev/sdk';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {GroupContextMenu} from '../databaseLayouts';
import type {UseDatabase} from '../useDatabase';

// GroupContextMenu resolves page-group renames through the navigation provider;
// stub it (a hoisted spy so the page-rename test can assert on it) so the
// component can mount without the full provider tree.
const {renamePage} = vi.hoisted(() => ({renamePage: vi.fn()}));
vi.mock('@/providers', () => ({
  useNavigation: () => ({renamePage}),
}));
// The group menu copies a group link through useCopyPageLink — mock it (a hoisted
// spy) so the copy-link test can assert the host page + group key it was handed,
// and so the hook's provider dependencies don't need the full tree.
const {copyLink} = vi.hoisted(() => ({copyLink: vi.fn()}));
vi.mock('@/lib/useCopyPageLink', () => ({
  useCopyPageLink: () => copyLink,
}));

afterEach(() => {
  cleanup();
  renamePage.mockClear();
  copyLink.mockClear();
});

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
const pageGroup: RowGroup = {key: 'page-123', label: 'Linked page', color: undefined, rows: []};

const makeDb = (): UseDatabase =>
  ({hostPageId: 'db-host', updateProperty: vi.fn().mockResolvedValue(undefined)}) as unknown as UseDatabase;

interface MenuOverrides {
  prop?: DatabaseProperty | undefined;
  groupByParent?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onCollapseAll?: () => void;
  onExpandAll?: () => void;
}

function renderMenu(group: RowGroup, db: UseDatabase, overrides: MenuOverrides = {}): void {
  render(
    <GroupContextMenu
      db={db}
      group={group}
      prop={'prop' in overrides ? overrides.prop : prop}
      groupByParent={overrides.groupByParent ?? false}
      collapsed={overrides.collapsed ?? false}
      onToggle={overrides.onToggle ?? (() => {})}
      onCollapseAll={overrides.onCollapseAll ?? (() => {})}
      onExpandAll={overrides.onExpandAll ?? (() => {})}
    >
      <button data-testid="hdr">{group.label}</button>
    </GroupContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('hdr'));
}

describe('GroupContextMenu', () => {
  it('opens the group menu — not the surrounding DB menu — on a group-header right-click', () => {
    // Nest the group menu inside a stub database-level ContextMenu (mimicking
    // DatabaseContextMenu). Right-clicking the header must open the GROUP menu and
    // NOT the outer "Rename view" one — exercising the trigger's stopPropagation.
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="db-surface">
            <GroupContextMenu
              db={makeDb()}
              group={optionGroup}
              prop={prop}
              groupByParent={false}
              collapsed={false}
              onToggle={() => {}}
              onCollapseAll={() => {}}
              onExpandAll={() => {}}
            >
              <button data-testid="hdr">{optionGroup.label}</button>
            </GroupContextMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename view</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('hdr'));
    expect(screen.getByText('Rename group')).toBeTruthy();
    expect(screen.getByText('Change colour')).toBeTruthy();
    // The outer DB menu's item must not have opened.
    expect(screen.queryByText('Rename view')).toBeNull();
  });

  it('shows the full group action set', () => {
    renderMenu(optionGroup, makeDb());
    expect(screen.getByText('Rename group')).toBeTruthy();
    expect(screen.getByText('Change colour')).toBeTruthy();
    expect(screen.getByText('Collapse all')).toBeTruthy();
    expect(screen.getByText('Expand all')).toBeTruthy();
    expect(screen.getByText('Delete group')).toBeTruthy();
    expect(screen.queryByText('Rename view')).toBeNull();
  });

  it('deletes an option group by removing its option from the property', () => {
    const db = makeDb();
    renderMenu(optionGroup, db);
    fireEvent.click(screen.getByText('Delete group'));
    expect(db.updateProperty).toHaveBeenCalledWith('status', {options: [prop.options![1]]});
  });

  it('patches the option colour, leaving the other options intact', () => {
    const db = makeDb();
    renderMenu(optionGroup, db);
    // Open the colour submenu (SubContent only mounts once open) via keyboard.
    const subTrigger = screen.getByText('Change colour').closest('[role="menuitem"]') as HTMLElement;
    subTrigger.focus();
    fireEvent.keyDown(subTrigger, {key: 'ArrowRight'});
    fireEvent.click(screen.getByLabelText('orange'));
    expect(db.updateProperty).toHaveBeenCalledWith('status', {
      options: [{id: 'opt1', label: 'Todo', color: 'orange'}, prop.options![1]],
    });
  });

  it('renames a page/relation group by renaming the linked page', () => {
    // A parent-item / relation group's key is a page id; renaming it reaches the
    // linked page app-wide via the navigation provider, not the property options.
    const db = makeDb();
    renderMenu(pageGroup, db, {prop: undefined, groupByParent: true});
    // The action reads "Rename page" for a page group.
    fireEvent.click(screen.getByText('Rename page'));
    const input = screen.getByLabelText('Rename group') as HTMLInputElement;
    fireEvent.change(input, {target: {value: 'Renamed page'}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(renamePage).toHaveBeenCalledWith('page-123', 'Renamed page');
    expect(db.updateProperty).not.toHaveBeenCalled();
  });

  it('guards an option-group rename against a blank name', () => {
    const db = makeDb();
    renderMenu(optionGroup, db);
    fireEvent.click(screen.getByText('Rename group'));
    const input = screen.getByLabelText('Rename group') as HTMLInputElement;
    // Blank commit is a no-op — the option is never patched.
    fireEvent.change(input, {target: {value: '   '}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(db.updateProperty).not.toHaveBeenCalled();
  });

  it('commits an option-group rename by patching the option label', () => {
    const db = makeDb();
    renderMenu(optionGroup, db);
    fireEvent.click(screen.getByText('Rename group'));
    const input = screen.getByLabelText('Rename group') as HTMLInputElement;
    fireEvent.change(input, {target: {value: 'In progress'}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(db.updateProperty).toHaveBeenCalledWith('status', {
      options: [{id: 'opt1', label: 'In progress', color: 'blue'}, prop.options![1]],
    });
  });

  it('fires the collapse-all callback', () => {
    const onCollapseAll = vi.fn();
    renderMenu(optionGroup, makeDb(), {onCollapseAll});
    fireEvent.click(screen.getByText('Collapse all'));
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });

  it('fires the expand-all callback', () => {
    const onExpandAll = vi.fn();
    renderMenu(optionGroup, makeDb(), {onExpandAll});
    fireEvent.click(screen.getByText('Expand all'));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });

  it('disables rename / delete for the "No value" sentinel group', () => {
    renderMenu(sentinelGroup, makeDb());
    expect(screen.getByText('Rename group').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    // A sentinel group is not an editable option, so Delete is not offered at all.
    expect(screen.queryByText('Delete group')).toBeNull();
  });

  it('does not offer copy link on the group header (COPYLINK-AUDIT: dropped as noise)', () => {
    // Copy link now lives only on the page cluster + contextual row menus; a
    // link to a swimlane/section was niche noise. The ?group= deep-link anchor
    // is still honoured on load — it just is not surfaced from this menu.
    renderMenu(optionGroup, makeDb());
    expect(screen.queryByText('Copy link')).toBeNull();
    expect(copyLink).not.toHaveBeenCalled();
  });

  it('marks the group header with data-group-anchor so a ?group= link can scroll to it', () => {
    // The scroll-to target lands on the wrapped header via asChild (Radix Slot).
    renderMenu(optionGroup, makeDb());
    expect(screen.getByTestId('hdr').getAttribute('data-group-anchor')).toBe('opt1');
  });
});
