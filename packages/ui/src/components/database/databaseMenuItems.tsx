import React from 'react';
import {
  AppWindow,
  ArrowDownAZ,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpAZ,
  Copy,
  ExternalLink,
  EyeOff,
  Filter as FilterIcon,
  Link2,
  PanelRightOpen,
  Pencil,
  Plus,
  Rows3,
  Save,
  Trash2,
} from 'lucide-react';
import {
  shortId,
  type DatabaseFilter,
  type DatabaseProperty,
  type DatabaseView as DbView,
  type FilterOperator,
} from '@book.dev/sdk';
import {MENU_COMPONENTS, type MenuComponentSet} from '@/components/ui/menu-components';
import {useCopyPageLink} from '@/lib/useCopyPageLink';
import {useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import type {UseDatabase} from './useDatabase';

/**
 * The single source of the database grid's row and column actions, in the
 * {@link PageMenuItems} mould: one canonical item list per scope, rendered
 * through whichever Radix menu family (right-click context menu vs. the `⋯`
 * click dropdown) — or, for the column list, the property editor popover's
 * button stack — its host provides. Keeping the lists here means the dropdown,
 * the context menu, and the popover can never drift apart (TBL-9).
 */

const destructiveClass = 'text-destructive hover:text-destructive focus:text-destructive';

/** Append a leaf condition to a view's filter tree (clearing the legacy flat list). */
export function addQuickFilter(db: UseDatabase, view: DbView, propertyId: string, operator: FilterOperator, value: unknown): void {
  const root = view.filterRoot ?? {id: 'root', conjunction: 'and' as const, filters: view.filters ?? []};
  const condition: DatabaseFilter = {id: shortId('filter'), propertyId, operator, value};
  void db.updateView(view.id, {filterRoot: {...root, filters: [...root.filters, condition]}, filters: []});
}

/** The header "Filter by <property>" default: a deterministic, valueless condition
 *  that takes effect at once and stays editable via the filter chips / menu. */
export function addColumnFilter(db: UseDatabase, view: DbView, property: DatabaseProperty): void {
  addQuickFilter(db, view, property.id, property.type === 'checkbox' ? 'is_checked' : 'is_not_empty', undefined);
}

/**
 * Multi-select bulk scope for a row menu: shown when the row the menu opened on
 * is part of a 2+ selection, so a right-click acts on the whole selection.
 */
export interface RowMenuBulk {
  count: number;
  onDuplicate: () => void;
  onDelete: () => void;
}

/**
 * A database row's actions — open targets, copy link, insert above/below,
 * duplicate, (save as template,) and delete. A multi-select replaces the
 * clicked-row duplicate/delete pair with count-labelled bulk actions. Rendered
 * by the table's cell context menu, the card/list
 * right-click menu ({@link RowContextMenu}), and the row `⋯` dropdown
 * ({@link RowMenu}) — the same list drives all three.
 */
export const RowMenuItems: React.FC<{
  db: UseDatabase;
  rowId: string;
  /** Which Radix family renders the items (default: the right-click menu). */
  menu?: 'context' | 'dropdown';
  /** Offer "Save as template" (the `⋯` dropdown does; the compact card menu doesn't). */
  withTemplate?: boolean;
  /** Bulk ops replacing duplicate/delete when this row is inside a 2+ row selection. */
  bulk?: RowMenuBulk | null;
}> = ({db, rowId, menu = 'context', withTemplate, bulk}) => {
  const {t} = useTranslation();
  const copyLink = useCopyPageLink();
  const C = MENU_COMPONENTS[menu];
  const scopedActions = bulk && bulk.count > 1
    ? {
      duplicate: bulk.onDuplicate,
      duplicateLabel: t('database.rowMenu.bulkDuplicate', {count: bulk.count}),
      delete: bulk.onDelete,
      deleteLabel: t('database.rowMenu.bulkDelete', {count: bulk.count}),
    }
    : {
      duplicate: () => void db.duplicateRow(rowId),
      duplicateLabel: t('database.rowMenu.duplicate'),
      delete: () => void db.deleteRow(rowId),
      deleteLabel: t('database.rowMenu.delete'),
    };
  return (
    <>
      <C.Item onSelect={() => db.openRow(rowId)}>
        <PanelRightOpen className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.open')}
      </C.Item>
      <C.Separator />
      <C.Item onSelect={() => db.openRowIn(rowId, 'tab')}>
        <ExternalLink className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.openTab')}
      </C.Item>
      <C.Item onSelect={() => db.openRowIn(rowId, 'window')}>
        <AppWindow className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.openWindow')}
      </C.Item>
      <C.Separator />
      {/* Anchor at the host database page, not the row-as-standalone-page, so
          the link reopens the row IN CONTEXT (scrolled to + highlighted). */}
      <C.Item onSelect={() => copyLink(db.hostPageId, {row: rowId})}>
        <Link2 className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.copyLink')}
      </C.Item>
      <C.Item onSelect={() => void db.addRowBefore(rowId)}>
        <Plus className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.insertAbove')}
      </C.Item>
      <C.Item onSelect={() => void db.addRowAfter(rowId)}>
        <Plus className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.insertBelow')}
      </C.Item>
      <C.Item onSelect={scopedActions.duplicate}>
        <Copy className="mr-2 h-3.5 w-3.5" /> {scopedActions.duplicateLabel}
      </C.Item>
      {withTemplate && (
        <C.Item onSelect={() => void db.saveAsTemplate(rowId)}>
          <Save className="mr-2 h-3.5 w-3.5" /> {t('database.rowMenu.saveTemplate')}
        </C.Item>
      )}
      <C.Separator />
      <C.Item onSelect={scopedActions.delete} className={destructiveClass}>
        <Trash2 className="mr-2 h-3.5 w-3.5" /> {scopedActions.deleteLabel}
      </C.Item>
    </>
  );
};

/** The subset of {@link MenuComponentSet} the column list renders through (it
 *  has no subs/checkboxes, so a plain button stack can host it too). */
export type ColumnMenuComponents = Pick<MenuComponentSet, 'Item' | 'Separator'>;

const popoverButtonClass =
  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground';

/**
 * A {@link ColumnMenuComponents} set rendering the items as a compact button
 * stack for the property editor popover (which is a Popover form, not a Radix
 * menu). `onAfter` runs after any action so the host can close itself.
 */
export function popoverColumnComponents(onAfter: () => void): ColumnMenuComponents {
  const Item: React.FC<{onSelect?: () => void; className?: string; children?: React.ReactNode}> = ({onSelect, className, children}) => (
    <button
      type="button"
      onClick={() => {
        onSelect?.();
        onAfter();
      }}
      className={cn(popoverButtonClass, className)}
    >
      {children}
    </button>
  );
  const Separator: React.FC = () => <div className="my-1 border-t border-border" />;
  return {Item, Separator};
}

/**
 * A database column's actions — sort, filter by, group by, hide, insert
 * left/right, duplicate, edit, delete. Rendered by the header's right-click
 * {@link ColumnContextMenu} and, as the button stack, by the header `⋯`
 * property editor ({@link PropertyMenu}) — the same list drives both.
 *
 * Sorts/filters/grouping/hidden columns live on the VIEW (persisted through
 * {@link UseDatabase.updateView}); property shape edits live on the schema.
 */
export const ColumnMenuItems: React.FC<{
  db: UseDatabase;
  view: DbView;
  property: DatabaseProperty;
  menu?: 'context' | 'dropdown';
  /** Override the render family (the editor popover's button stack). */
  components?: ColumnMenuComponents;
  /** When set, appends "Edit property…" (the context menu path into the full editor). */
  onEditProperty?: () => void;
}> = ({db, view, property, menu = 'context', components, onEditProperty}) => {
  const {t} = useTranslation();
  const C = components ?? MENU_COMPONENTS[menu];
  const hide = (): void => {
    const all = (db.database?.schema.properties ?? []).map((p) => p.id);
    const current = view.visiblePropertyIds?.length ? view.visiblePropertyIds : all;
    void db.updateView(view.id, {visiblePropertyIds: current.filter((id) => id !== property.id)});
  };
  return (
    <>
      <C.Item onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'asc'}]})}>
        <ArrowDownAZ className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.sortAsc')}
      </C.Item>
      <C.Item onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'desc'}]})}>
        <ArrowUpAZ className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.sortDesc')}
      </C.Item>
      <C.Item onSelect={() => addColumnFilter(db, view, property)}>
        <FilterIcon className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.filterBy', {name: property.name})}
      </C.Item>
      {view.groupByPropertyId === property.id ? (
        <C.Item onSelect={() => void db.updateView(view.id, {groupByPropertyId: undefined})}>
          <Rows3 className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.ungroup')}
        </C.Item>
      ) : (
        <C.Item onSelect={() => void db.updateView(view.id, {groupByPropertyId: property.id})}>
          <Rows3 className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.groupBy', {name: property.name})}
        </C.Item>
      )}
      <C.Separator />
      <C.Item onSelect={hide}>
        <EyeOff className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.hide')}
      </C.Item>
      <C.Item onSelect={() => void db.insertProperty({name: '', type: 'text'}, property.id, 'left', view.id)}>
        <ArrowLeftToLine className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.insertLeft')}
      </C.Item>
      <C.Item onSelect={() => void db.insertProperty({name: '', type: 'text'}, property.id, 'right', view.id)}>
        <ArrowRightToLine className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.insertRight')}
      </C.Item>
      <C.Item onSelect={() => void db.duplicateProperty(property.id)}>
        <Copy className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.duplicate')}
      </C.Item>
      <C.Separator />
      {onEditProperty && (
        <C.Item onSelect={onEditProperty}>
          <Pencil className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.edit')}
        </C.Item>
      )}
      <C.Item onSelect={() => void db.deleteProperty(property.id)} className={destructiveClass}>
        <Trash2 className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.delete')}
      </C.Item>
    </>
  );
};
