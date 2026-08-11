import React, {useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowDownAZ, ArrowUp, ArrowUpAZ, CalendarClock, ChevronDown, ChevronRight, Copy, Download, Filter as FilterIcon, GripVertical, MoreHorizontal, PanelRightOpen, Pencil, Plus, Rows3, Save, Search, Trash2, Upload, X} from 'lucide-react';
import {
  buildRowTree,
  dateStart,
  flattenRowTree,
  groupRowsBy,
  PARENT_GROUP_ID,
  summarizeColumn,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type DatabaseViewType,
  type FilterOperator,
  type SummaryType,
} from '@book.dev/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {IconButton} from '@/components/ui/icon-button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Switch} from '@/components/ui/switch';
import {Label} from '@/components/ui/label';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {showToast} from '@/components/ui/toast';
import {MENU_DESTRUCTIVE_CLASS, MENU_WIDTH_MD, MENU_WIDTH_SM} from '@/components/ui/menu-components';
import {readPageIcon} from '@/lib/pageIcon';
import {useNavigation, useTranslation} from '@/providers';
import {PageIcon} from '@/components/PageIcon';
import {cn} from '@/lib/utils';
import {downloadText, safeFilename} from '@/lib/download';
import {useDatabase, type UseDatabase} from './useDatabase';
import {addQuickFilter, ColumnMenuItems, RowMenuItems, type RowMenuBulk} from './databaseMenuItems';
import {cellValue, PropertyValueCell, rowsToCsv} from './databaseCells';
import {AddPropertyMenu, AddViewMenu, FieldsMenu, FilterChips, FilterMenu, GroupChips, GroupMenu, importCsvFile, MetricsBar, PropertyMenu, SortChips, SortMenu, SummaryPicker, ViewOptionsMenu, viewIcon, VIEW_TYPES} from './databaseMenus';
import type {PropertyMenuHandle} from './databaseMenus';
import {
  BoardView,
  CalendarView,
  GalleryView,
  groupCollapsed,
  GroupContextMenu,
  groupGlyph,
  groupHeading,
  rowColor,
  RowChips,
  RowContextMenu,
  setAllGroupsCollapsed,
  useRelationGroupTitles,
} from './databaseLayouts';
import {BarChartView, PieChartView} from './databaseCharts';
import {TimelineView} from './databaseTimeline';
import {MapView} from './databaseMap';
import {GraphView} from './databaseGraph';
import {dotStyle} from './databaseColors';

const exprValueOf = (row: DatabaseRow, property: DatabaseProperty): unknown =>
  row.exports[property.cellName ?? property.name];

/** Per-row `⋯` overflow menu: the shared row item list ({@link RowMenuItems})
 *  rendered through the dropdown family — the same items as the right-click
 *  menus, so the two surfaces can't drift (TBL-9). */
const RowMenu: React.FC<{db: UseDatabase; rowId: string; bulk?: RowMenuBulk | null}> = ({db, rowId, bulk}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <IconButton
        size="sm"
        className="text-muted-foreground/60 opacity-0 transition group-hover:opacity-100"
        aria-label="Row actions"
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52">
      <RowMenuItems db={db} rowId={rowId} menu="dropdown" withTemplate bulk={bulk} />
    </DropdownMenuContent>
  </DropdownMenu>
);

/** Sub-item (nested-row) info for a title cell: indent, expand toggle, add. */
interface RowTreeInfo {
  depth: number;
  hasChildren: boolean;
  /** True when *any* row in the table is expandable — only then do leaf rows
   *  reserve chevron width, so a flat database doesn't indent every name. */
  anyExpandable: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onAddSub: () => void;
}

/** The title cell: indent + expand toggle (sub-items), drag handle, icon + name.
 *  Row actions (add-sub / open / menu) live in {@link DataRow}'s hover overlay so
 *  they don't steal width from the name. */
const TitleCell: React.FC<{row: DatabaseRow; db: UseDatabase; dragHandle?: React.ReactNode; tree?: RowTreeInfo}> = ({
  row,
  db,
  dragHandle,
  tree,
}) => (
  <div className="flex items-center gap-1" style={tree ? {paddingLeft: tree.depth * 16} : undefined}>
    {dragHandle}
    {tree?.hasChildren ? (
      <button
        onClick={tree.onToggle}
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition hover:bg-hover hover:text-foreground"
        aria-label={tree.collapsed ? 'Expand sub-items' : 'Collapse sub-items'}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !tree.collapsed && 'rotate-90')} />
      </button>
    ) : (
      tree?.anyExpandable && <span className="w-4 shrink-0" />
    )}
    <PageIcon value={readPageIcon(row.id)} className="shrink-0 text-sm leading-none" />
    <input
      defaultValue={row.name ?? ''}
      key={`${row.id}:${row.name ?? ''}`}
      data-row-title={row.id}
      onBlur={(e) => {
        if ((e.target.value || '') !== (row.name ?? '')) void db.renameRow(row.id, e.target.value);
      }}
      onKeyDown={(e) => {
        // Enter commits the title (rename happens on blur), like a form field.
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder="Untitled"
      className="w-full bg-transparent text-sm outline-hidden placeholder:text-placeholder-foreground"
    />
  </div>
);

/** `columns` are the displayed properties; `schema` is the full set (formula resolution). */
interface ViewProps {
  db: UseDatabase;
  columns: DatabaseProperty[];
  schema: DatabaseProperty[];
}

interface DragApi {
  canReorder: boolean;
  dragRow: string | null;
  overRow: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

/** One table row, optionally drag-reorderable and/or a sub-item tree node. */
/** A one-click "filter by this value" condition for a cell, or null if the
 *  property type isn't sensibly filterable by an exact value. */
function quickFilter(property: DatabaseProperty, value: unknown): {operator: FilterOperator; value?: unknown; label: string} | null {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (property.type === 'checkbox') return value ? {operator: 'is_checked', label: 'is checked'} : {operator: 'is_unchecked', label: 'is unchecked'};
  if (empty) return {operator: 'is_empty', label: 'is empty'};
  switch (property.type) {
  case 'select':
  case 'status': {
    const opt = property.options?.find((o) => o.id === value);
    return {operator: 'equals', value, label: `is ${opt?.label ?? String(value)}`};
  }
  case 'multi_select': {
    const first = Array.isArray(value) ? (value[0] as string) : undefined;
    if (!first) return null;
    const opt = property.options?.find((o) => o.id === first);
    return {operator: 'contains', value: first, label: `has ${opt?.label ?? first}`};
  }
  case 'number':
    return {operator: 'equals', value, label: `is ${String(value)}`};
  case 'text':
  case 'url':
  case 'email':
  case 'phone':
    return {operator: 'equals', value, label: `is "${String(value)}"`};
  case 'date': {
    const s = dateStart(value);
    return s ? {operator: 'equals', value: s, label: `is ${s}`} : null;
  }
  default:
    return null;
  }
}

/** Relative date filter presets offered on a date cell's context menu. */
const DATE_FILTER_PRESETS: {operator: FilterOperator; label: string}[] = [
  {operator: 'is_today', label: 'Today'},
  {operator: 'is_this_week', label: 'This week'},
  {operator: 'is_this_month', label: 'This month'},
  {operator: 'is_past_week', label: 'Past week'},
  {operator: 'is_next_week', label: 'Next week'},
];

/**
 * Right-click any row cell for quick actions: filter the view by the cell's value,
 * sort by its column, or act on the row (open / insert / duplicate / delete —
 * the shared {@link RowMenuItems} list). `property` is omitted for the title
 * cell (row actions only). When the row is inside a 2+ selection, `bulk`
 * appends the whole-selection duplicate/delete pair.
 */
const CellContextMenu: React.FC<{
  db: UseDatabase;
  view?: DbView | null;
  row: DatabaseRow;
  property?: DatabaseProperty;
  value?: unknown;
  bulk?: RowMenuBulk | null;
  children: React.ReactNode;
}> = ({db, view, row, property, value, bulk, children}) => {
  const {t} = useTranslation();
  const filter = property && view ? quickFilter(property, value) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Block + w-full so cell content (e.g. a number's flex-1 progress bar)
            fills the cell rather than collapsing to content width. */}
        <div className="min-h-[1.75rem] w-full [&>*]:w-full">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH_MD}>
        {property && view && filter && (
          <ContextMenuItem onSelect={() => addQuickFilter(db, view, property.id, filter.operator, filter.value)}>
            <FilterIcon className="mr-2 h-3.5 w-3.5" /> Filter: {property.name} {filter.label}
          </ContextMenuItem>
        )}
        {property && view && property.type === 'date' && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FilterIcon className="mr-2 h-3.5 w-3.5" /> Filter by date
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className={MENU_WIDTH_SM}>
              {DATE_FILTER_PRESETS.map((preset) => (
                <ContextMenuItem key={preset.operator} onSelect={() => addQuickFilter(db, view, property.id, preset.operator, undefined)}>
                  {preset.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {property && view && (
          <>
            <ContextMenuItem onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'asc'}]})}>
              <ArrowDownAZ className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.sortAsc')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'desc'}]})}>
              <ArrowUpAZ className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.sortDesc')}
            </ContextMenuItem>
            {view.groupByPropertyId === property.id ? (
              <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: undefined})}>
                <Rows3 className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.ungroup')}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: property.id})}>
                <Rows3 className="mr-2 h-3.5 w-3.5" /> {t('database.columnMenu.groupBy', {name: property.name})}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <RowMenuItems db={db} rowId={row.id} menu="context" bulk={bulk} />
      </ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * Right-click a column header for quick column actions — sort, group by, hide,
 * duplicate, delete — plus an "Edit property…" item that opens the full
 * PropertyMenu editor (name, type, options, format) at the pointer, the same
 * form reachable from the header's `⋯` click.
 */
const ColumnContextMenu: React.FC<{
  db: UseDatabase;
  view: DbView;
  property: DatabaseProperty;
  /** Opens the full PropertyMenu editor anchored at the right-click point. */
  onEditProperty: (pt: {clientX: number; clientY: number}) => void;
  children: React.ReactNode;
}> = ({db, view, property, onEditProperty, children}) => {
  // The right-click point, captured so "Edit property…" can anchor the full
  // editor where the user clicked (parity with the `⋯` button position).
  const pointer = useRef({clientX: 0, clientY: 0});
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(e) => {
          pointer.current = {clientX: e.clientX, clientY: e.clientY};
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH_MD}>
        <ColumnMenuItems
          db={db}
          view={view}
          property={property}
          menu="context"
          onEditProperty={() => {
            // Defer a tick so the ContextMenu's dismiss doesn't race the
            // PropertyMenu Popover open (both react to the same interaction).
            const pt = pointer.current;
            setTimeout(() => onEditProperty(pt), 0);
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
};

const DataRow: React.FC<ViewProps & {row: DatabaseRow; drag: DragApi; tree?: RowTreeInfo; selection?: {selected: boolean; onToggle: () => void}; bulk?: RowMenuBulk | null}> = ({db, columns, row, drag, tree, selection, bulk}) => {
  // Colour rules resolve against the rollup rows/properties so a rule on a
  // cross-database rollup matches the value the cells display.
  const accent = db.activeView ? rowColor(row, db.activeView, db.rollupProperties, db.rollupRows) : undefined;
  const hasDependency = columns.some((c) => c.type === 'dependency');
  const rowOptions = hasDependency
    ? db.rows.filter((r) => r.id !== row.id).map((r) => ({id: r.id, label: r.name?.trim() || 'Untitled', icon: readPageIcon(r.id)}))
    : undefined;
  const handle = drag.canReorder ? (
    <span
      draggable
      onDragStart={() => drag.start(row.id)}
      onDragEnd={drag.end}
      className="cursor-grab text-muted-foreground/30 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
      aria-label="Drag to reorder"
      title="Drag to reorder"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  ) : null;

  return (
    <tr
      // Marks the row for a copied row link's scroll-to (the table doesn't wrap
      // rows in RowContextMenu, so the anchor attribute lives here directly).
      data-row-anchor={row.id}
      onDragOver={(e) => {
        if (drag.canReorder && drag.dragRow) {
          e.preventDefault();
          drag.over(row.id);
        }
      }}
      onDrop={() => drag.drop(row.id)}
      className={cn(
        'group border-b border-border/70 transition-[background-color] last:border-0 hover:bg-hover',
        drag.dragRow === row.id && 'opacity-40',
        drag.overRow === row.id && drag.dragRow !== row.id && 'border-t-2 border-t-brand/60',
      )}
    >
      <td
        style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
        className={cn(
          'sticky left-0 z-10 border-r border-border px-2 py-0.5 align-middle',
          selection?.selected ? 'bg-accent/40' : 'bg-card',
        )}
      >
        {/* The title cell right-clicks into the same row menu as every other
            cell (no property section — there's no title quick-filter). */}
        <CellContextMenu db={db} view={db.activeView} row={row} bulk={bulk}>
          <div className="relative flex items-center">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {selection && (
                <input
                  type="checkbox"
                  checked={selection.selected}
                  onChange={selection.onToggle}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary transition-opacity',
                    !selection.selected && 'opacity-0 group-hover:opacity-100',
                  )}
                  aria-label="Select row"
                />
              )}
              <div className="min-w-0 flex-1">
                <TitleCell row={row} db={db} dragHandle={handle} tree={tree} />
              </div>
            </div>
            {/* Row actions float over the cell's tail on hover instead of
                reserving permanent width — the name keeps the full column.
                (Centered via inset-y + items-center, not translate: the desktop
                WKWebView doesn't apply Tailwind v4's `translate` property.) */}
            <div className="absolute inset-y-0 right-0 z-10 flex items-center gap-0.5 rounded-md bg-card pl-0.5 opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {tree && (
                <IconButton
                  size="sm"
                  onClick={tree.onAddSub}
                  className="text-muted-foreground/60"
                  aria-label="Add sub-item"
                  title="Add sub-item"
                >
                  <Plus className="h-3.5 w-3.5" />
                </IconButton>
              )}
              <IconButton
                size="sm"
                onClick={() => db.openRow(row.id)}
                className="text-muted-foreground/60"
                aria-label="Open row"
                title="Open in split"
              >
                <PanelRightOpen className="h-3.5 w-3.5" />
              </IconButton>
              <RowMenu db={db} rowId={row.id} bulk={bulk} />
            </div>
          </div>
        </CellContextMenu>
      </td>
      {columns.map((property) => {
        // A cross-database rollup is unknowable until its foreign rows load —
        // show the empty placeholder instead of flashing a wrong 0/—.
        const value = db.pendingRollups.has(property.id) ? undefined : cellValue(row, property, db.rollupProperties, db.rollupRows);
        return (
          <td key={property.id} className="border-l border-border/70 align-middle">
            <CellContextMenu db={db} view={db.activeView} row={row} property={property} value={value} bulk={bulk}>
              <PropertyValueCell
                property={property}
                value={value}
                exprValue={exprValueOf(row, property)}
                onChange={(next) => void db.setRowProperty(row.id, property.id, next)}
                onAddOption={(label) => db.addSelectOption(property.id, label)}
                rowOptions={rowOptions}
              />
            </CellContextMenu>
          </td>
        );
      })}
      <td className="border-l border-border/70" />
    </tr>
  );
};

/** Focus a (possibly not-yet-rendered) row's title input, retrying briefly. */
export function focusRowTitle(rowId: string, attempt = 0): void {
  // The row may land asynchronously (create → refetch), so this retries — but
  // it must never STEAL focus: if the user has since moved into another field
  // or an open popover (e.g. the dependency picker, which closes on focus
  // loss), give up instead of yanking the caret away.
  const active = document.activeElement;
  const userMovedOn =
    active instanceof HTMLElement &&
    (active.isContentEditable ||
      active.tagName === 'INPUT' ||
      active.tagName === 'TEXTAREA' ||
      active.closest('[data-radix-popper-content-wrapper]') !== null);
  if (userMovedOn) return;
  const el = document.querySelector<HTMLInputElement>(`[data-row-title="${rowId}"]`);
  if (el) {
    el.focus();
    return;
  }
  if (attempt < 10) setTimeout(() => focusRowTitle(rowId, attempt + 1), 50);
}

const NewRowRow: React.FC<{colSpan: number; onClick: () => void; label?: string}> = ({colSpan, onClick, label}) => (
  <tr>
    <td colSpan={colSpan} className="p-0">
      <button
        onClick={onClick}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <Plus className="h-4 w-4" /> {label ?? 'New row'}
      </button>
    </td>
  </tr>
);

/**
 * A per-group calculation row: applies the view's column summary config (the
 * same one the table footer uses) to just this group's rows, so a grouped table
 * shows each group's own sum/average/count.
 */
const GroupSummaryRow: React.FC<{
  db: UseDatabase;
  columns: DatabaseProperty[];
  rows: DatabaseRow[];
  summaryOf: (key: string) => SummaryType;
}> = ({db, columns, rows, summaryOf}) => (
  // Summaries resolve against the rollup rows/properties (cross-database
  // rollups fold real foreign rows), same as the cells above them.
  <tr className="bg-muted/10 text-xs text-muted-foreground/80">
    <td className="px-2 py-1 align-middle tabular-nums">
      {summarizeColumn(rows, TITLE_PROPERTY_ID, summaryOf(TITLE_PROPERTY_ID), db.rollupProperties, db.rollupRows)}
    </td>
    {columns.map((property) => (
      <td key={property.id} className="border-l border-border/60 px-2 py-1 align-middle tabular-nums">
        {summarizeColumn(rows, property, summaryOf(property.id), db.rollupProperties, db.rollupRows)}
      </td>
    ))}
    <td className="border-l border-border/60" />
  </tr>
);

const TableView: React.FC<ViewProps & {view: DbView}> = ({db, columns, schema, view}) => {
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  // Right-clicking a column header opens its quick-actions ColumnContextMenu;
  // the trailing "Edit property…" item opens that column's PropertyMenu at the
  // pointer (parity with its `⋯` click) — one imperative handle per column.
  const propertyMenuRefs = useRef(new Map<string, PropertyMenuHandle | null>());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // True once the table is horizontally scrolled (drives the frozen-column shadow).
  const [hScrolled, setHScrolled] = useState(false);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const visibleIds = db.visibleRows.map((r) => r.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleIds));
  const bulkDelete = () => {
    selected.forEach((id) => void db.deleteRow(id));
    setSelected(new Set());
  };
  const bulkDuplicate = () => {
    selected.forEach((id) => void db.duplicateRow(id));
    setSelected(new Set());
  };
  const bulkSet = (propertyId: string, value: unknown) => {
    selected.forEach((id) => void db.setRowProperty(id, propertyId, value));
    setSelected(new Set());
  };
  // The first select/status column, offered as a one-shot bulk edit.
  const bulkSetProps = schema.filter((p) => p.type === 'select' || p.type === 'status');
  const selectionOf = (id: string) => ({selected: selected.has(id), onToggle: () => toggleSelect(id)});
  // Right-clicking (or ⋯-ing) a row that's part of a 2+ selection offers the
  // whole-selection duplicate/delete pair alongside the single-row actions.
  const bulkFor = (id: string): RowMenuBulk | null =>
    selected.size > 1 && selected.has(id) ? {count: selected.size, onDuplicate: bulkDuplicate, onDelete: bulkDelete} : null;

  const groupByParent = view.groupByPropertyId === PARENT_GROUP_ID;
  const groupProp = !groupByParent && view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  useRelationGroupTitles(groupProp);
  const hasSubItems = db.visibleRows.some((r) => r.parentId);
  // Manual drag-reorder is only well-defined over the full, unfiltered, unsorted,
  // ungrouped, flat list (otherwise "where does it land?" is ambiguous).
  const canReorder =
    !groupProp &&
    !groupByParent &&
    !hasSubItems &&
    (view.sorts?.length ?? 0) === 0 &&
    (view.filters?.length ?? 0) === 0 &&
    !view.filterRoot &&
    !db.search.trim();

  const drag: DragApi = {
    canReorder,
    dragRow,
    overRow,
    start: setDragRow,
    over: setOverRow,
    end: () => {
      setDragRow(null);
      setOverRow(null);
    },
    drop: (targetId) => {
      if (dragRow && dragRow !== targetId) {
        const ids = db.visibleRows.map((r) => r.id);
        const from = ids.indexOf(dragRow);
        if (from >= 0) {
          ids.splice(from, 1);
          const to = ids.indexOf(targetId);
          ids.splice(to < 0 ? ids.length : to, 0, dragRow);
          void db.reorderRows(ids);
        }
      }
      setDragRow(null);
      setOverRow(null);
    },
  };

  const colSpan = columns.length + 2;
  const setSummary = (key: string, type: SummaryType) =>
    void db.updateView(view.id, {summaries: {...(view.summaries ?? {}), [key]: type}});
  const summaryOf = (key: string): SummaryType => view.summaries?.[key] ?? 'none';
  // Whether any column has a calculation configured (drives the per-group footer).
  const hasSummaries = Object.values(view.summaries ?? {}).some((t) => t && t !== 'none');

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleRow = (id: string) =>
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const collapseEmpty = view.collapseEmptyGroups ?? true;
  const groups = groupProp || groupByParent ? groupRowsBy(db.visibleRows, view.groupByPropertyId, schema) : null;
  const allCollapsed = !!groups && groups.length > 0 && groups.every((g) => groupCollapsed(g, collapsed, collapseEmpty));
  // Flat (ungrouped) view arranges rows into a sub-item tree.
  const treeRows = flattenRowTree(buildRowTree(db.visibleRows), collapsedRows);
  const anyExpandable = treeRows.some((n) => n.children.length > 0);
  const treeInfo = (node: (typeof treeRows)[number]): RowTreeInfo => ({
    depth: node.depth,
    hasChildren: node.children.length > 0,
    anyExpandable,
    collapsed: collapsedRows.has(node.row.id),
    onToggle: () => toggleRow(node.row.id),
    onAddSub: () => void db.addSubItem(node.row.id),
  });

  return (
    <div>
      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-accent/30 px-3 py-1.5 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          {bulkSetProps.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
                  Set property <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                {bulkSetProps.map((prop) => (
                  <DropdownMenuSub key={prop.id}>
                    <DropdownMenuSubTrigger className="gap-2">{prop.name}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-44">
                      {(prop.options ?? []).map((o) => (
                        <DropdownMenuItem key={o.id} onClick={() => bulkSet(prop.id, o.id)} className="gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(o.color)} />
                          {o.label}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onClick={() => bulkSet(prop.id, null)} className="text-muted-foreground">
                        Clear value
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button onClick={bulkDuplicate} className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </button>
          <button onClick={bulkDelete} className="flex items-center gap-1 text-destructive transition-colors hover:text-destructive/80">
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
          <button onClick={() => setSelected(new Set())} className="text-muted-foreground transition-colors hover:text-foreground">
            Clear
          </button>
        </div>
      )}
      {groups && groups.length > 0 && (
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setCollapsed(setAllGroupsCollapsed(groups, !allCollapsed, collapseEmpty))}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !allCollapsed && 'rotate-90')} />
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      )}
      {/* `ob-table-scrolled` makes the frozen Name column cast an edge shadow
          while columns slide beneath it (see index.css). */}
      <div
        className={cn('overflow-x-auto rounded-md border border-border', hScrolled && 'ob-table-scrolled')}
        onScroll={(e) => setHScrolled(e.currentTarget.scrollLeft > 0)}
      >
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-xs font-medium text-muted-foreground">
              <th className="sticky left-0 z-20 min-w-[220px] border-r border-border bg-card px-2 py-1.5 font-medium">
                <span className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 cursor-pointer accent-primary"
                    aria-label="Select all rows"
                  />
                  Name
                </span>
              </th>
              {columns.map((property, i) => {
                const sortDir = view.sorts?.find((s) => s.propertyId === property.id)?.direction;
                return (
                  <th
                    key={property.id}
                    draggable
                    data-sort={sortDir ?? ''}
                    onDragStart={() => setDragCol(property.id)}
                    onDragEnd={() => {
                      setDragCol(null);
                      setOverCol(null);
                    }}
                    onDragOver={(e) => {
                      if (dragCol && dragCol !== property.id) {
                        e.preventDefault();
                        setOverCol(property.id);
                      }
                    }}
                    onDrop={() => {
                      if (dragCol && dragCol !== property.id) void db.reorderProperty(dragCol, property.id);
                      setDragCol(null);
                      setOverCol(null);
                    }}
                    className={cn(
                      'group min-w-[140px] cursor-grab border-l border-border px-2 py-1.5 font-medium active:cursor-grabbing',
                      dragCol === property.id && 'opacity-40',
                      overCol === property.id && dragCol !== property.id && 'border-l-2 border-l-brand/60',
                    )}
                  >
                    <ColumnContextMenu
                      db={db}
                      view={view}
                      property={property}
                      onEditProperty={(pt) => propertyMenuRefs.current.get(property.id)?.openAtPointer(pt)}
                    >
                      <span className="flex items-center justify-between gap-1">
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate">{property.name}</span>
                          {sortDir === 'asc' && <ArrowUp className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                          {sortDir === 'desc' && <ArrowDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                        </span>
                        <PropertyMenu
                          ref={(handle) => {
                            if (handle) propertyMenuRefs.current.set(property.id, handle);
                            else propertyMenuRefs.current.delete(property.id);
                          }}
                          property={property}
                          db={db}
                          index={i}
                          count={columns.length}
                        />
                      </span>
                    </ColumnContextMenu>
                  </th>
                );
              })}
              <th className="w-10 border-l border-border">
                <AddPropertyMenu onAdd={(input) => void db.addProperty(input)} />
              </th>
            </tr>
          </thead>

          {groups ? (
            groups.map((group) => {
              const isCollapsed = groupCollapsed(group, collapsed, collapseEmpty);
              const glyph = groupGlyph(group, groupProp, groupByParent);
              const isRealGroup = group.key !== '__none__' && group.key !== '__all__';
              const initial =
                groupProp && isRealGroup && (groupProp.type === 'select' || groupProp.type === 'status')
                  ? {[groupProp.id]: group.key}
                  : groupProp?.type === 'relation' && isRealGroup
                    ? {[groupProp.id]: [group.key]}
                    : undefined;
              // In a parent-grouped table, "New" inside a group creates a sub-item.
              const addInGroup = (): Promise<string | undefined> =>
                groupByParent && group.key !== '__none__' ? db.addSubItem(group.key) : db.addRow(initial);
              return (
                <tbody key={group.key} className="border-b border-border">
                  <tr className="bg-muted/20">
                    <td colSpan={colSpan} className="px-2 py-1">
                      <GroupContextMenu
                        db={db}
                        group={group}
                        prop={groupProp}
                        groupByParent={groupByParent}
                        collapsed={isCollapsed}
                        onToggle={() => toggleGroup(group.key)}
                        onCollapseAll={() => setCollapsed(setAllGroupsCollapsed(groups, true, collapseEmpty))}
                        onExpandAll={() => setCollapsed(setAllGroupsCollapsed(groups, false, collapseEmpty))}
                      >
                        <button onClick={() => toggleGroup(group.key)} className="flex items-center gap-1.5 text-xs font-medium">
                          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                          {group.color && (
                            <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(group.color)} />
                          )}
                          {glyph && <span className="text-sm leading-none">{glyph}</span>}
                          <span>{groupHeading(group, groupProp)}</span>
                          <span className="text-muted-foreground/60">{group.rows.length}</span>
                        </button>
                      </GroupContextMenu>
                    </td>
                  </tr>
                  {!isCollapsed &&
                  group.rows.map((row) => (
                    <DataRow key={row.id} db={db} columns={columns} schema={schema} row={row} drag={drag} selection={selectionOf(row.id)} bulk={bulkFor(row.id)} />
                  ))}
                  {!isCollapsed && (
                    <NewRowRow
                      colSpan={colSpan}
                      label="New"
                      onClick={() =>
                        void addInGroup().then((id) => id && focusRowTitle(id))
                      }
                    />
                  )}
                  {!isCollapsed && hasSummaries && (
                    <GroupSummaryRow db={db} columns={columns} rows={group.rows} summaryOf={summaryOf} />
                  )}
                </tbody>
              );
            })
          ) : (
            <tbody>
              {treeRows.map((node) => (
                <DataRow key={node.row.id} db={db} columns={columns} schema={schema} row={node.row} drag={drag} tree={treeInfo(node)} selection={selectionOf(node.row.id)} bulk={bulkFor(node.row.id)} />
              ))}
              {db.visibleRows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-2 py-3 text-center text-sm text-muted-foreground">
                  No rows{db.rows.length > 0 ? ' match the current view' : ' yet'}.
                  </td>
                </tr>
              )}
              {/* A fresh row drops the caret straight into its title. */}
              <NewRowRow colSpan={colSpan} onClick={() => void db.addRow().then((id) => id && focusRowTitle(id))} />
            </tbody>
          )}

          <tfoot>
            <tr className="border-t border-border bg-muted/10 text-xs">
              <td className="sticky left-0 z-10 border-r border-border bg-card align-middle">
                <SummaryPicker
                  current={summaryOf(TITLE_PROPERTY_ID)}
                  display={summarizeColumn(db.visibleRows, TITLE_PROPERTY_ID, summaryOf(TITLE_PROPERTY_ID), db.rollupProperties, db.rollupRows)}
                  onChange={(t) => setSummary(TITLE_PROPERTY_ID, t)}
                />
              </td>
              {columns.map((property) => (
                <td key={property.id} className="border-l border-border/60 align-middle">
                  <SummaryPicker
                    current={summaryOf(property.id)}
                    display={summarizeColumn(db.visibleRows, property, summaryOf(property.id), db.rollupProperties, db.rollupRows)}
                    onChange={(t) => setSummary(property.id, t)}
                  />
                </td>
              ))}
              <td className="border-l border-border/60" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};

/** One list-view row: icon, title, property chips, and the row menu. */
const ListRow: React.FC<{db: UseDatabase; columns: DatabaseProperty[]; row: DatabaseRow}> = ({db, columns, row}) => {
  const accent = db.activeView ? rowColor(row, db.activeView, db.rollupProperties, db.rollupRows) : undefined;
  return (
    <RowContextMenu db={db} rowId={row.id}>
      <div
        style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
        className="group flex cursor-pointer items-center justify-between gap-2 border-b border-border/70 px-3 py-2 last:border-0 hover:bg-hover"
        onClick={() => db.openRow(row.id)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PageIcon value={readPageIcon(row.id)} className="shrink-0 text-base leading-none" />
          <span className="shrink-0 truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</span>
          <RowChips row={row} properties={columns} rows={db.rollupRows} resolveProperties={db.rollupProperties} pending={db.pendingRollups} labelled />
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <RowMenu db={db} rowId={row.id} />
        </div>
      </div>
    </RowContextMenu>
  );
};

const ListView: React.FC<ViewProps & {view: DbView}> = ({db, columns, schema, view}) => {
  const groupByParent = view.groupByPropertyId === PARENT_GROUP_ID;
  const groupProp = !groupByParent && view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  const collapseEmpty = view.collapseEmptyGroups ?? true;
  useRelationGroupTitles(groupProp);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (groupProp || groupByParent) {
    const groups = groupRowsBy(db.visibleRows, view.groupByPropertyId, schema);
    return (
      <div className="space-y-3">
        {groups.map((group) => {
          const isCollapsed = groupCollapsed(group, collapsed, collapseEmpty);
          const glyph = groupGlyph(group, groupProp, groupByParent);
          return (
            <div key={group.key} className="overflow-hidden rounded-md border border-border">
              <GroupContextMenu
                db={db}
                group={group}
                prop={groupProp}
                groupByParent={groupByParent}
                collapsed={isCollapsed}
                onToggle={() => toggle(group.key)}
                onCollapseAll={() => setCollapsed(setAllGroupsCollapsed(groups, true, collapseEmpty))}
                onExpandAll={() => setCollapsed(setAllGroupsCollapsed(groups, false, collapseEmpty))}
              >
                <button onClick={() => toggle(group.key)} className="flex w-full items-center gap-1.5 bg-muted/20 px-3 py-1.5 text-xs font-medium">
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                  {group.color && (
                    <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(group.color)} />
                  )}
                  {glyph && <span className="text-sm leading-none">{glyph}</span>}
                  <span>{groupHeading(group, groupProp)}</span>
                  <span className="text-muted-foreground/60">{group.rows.length}</span>
                </button>
              </GroupContextMenu>
              {!isCollapsed && group.rows.map((row) => <ListRow key={row.id} db={db} columns={columns} row={row} />)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      {db.visibleRows.map((row) => (
        <ListRow key={row.id} db={db} columns={columns} row={row} />
      ))}
      {db.visibleRows.length === 0 && (
        <div className="px-3 py-3 text-center text-sm text-muted-foreground">
          No rows{db.rows.length > 0 ? ' match the current filters' : ' yet'}.
        </div>
      )}
      <button
        onClick={() => void db.addRow()}
        className="flex w-full items-center gap-1 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <Plus className="h-4 w-4" /> New row
      </button>
    </div>
  );
};

/** Render the active view's body for its layout type. */
const ViewBody: React.FC<{db: UseDatabase; view: DbView; columns: DatabaseProperty[]; schema: DatabaseProperty[]}> = ({
  db,
  view,
  columns,
  schema,
}) => {
  // The dense date layouts only show property chips once the user opts in (picks
  // properties); the card layouts show the visible set by default.
  const explicitCols = view.visiblePropertyIds && view.visiblePropertyIds.length > 0 ? columns : [];
  switch (view.type) {
  case 'list':
    return <ListView db={db} columns={columns} schema={schema} view={view} />;
  case 'gallery':
    return <GalleryView db={db} view={view} properties={columns} />;
  case 'board':
    return <BoardView db={db} view={view} properties={schema} cardProperties={columns} />;
  case 'calendar':
    return <CalendarView db={db} view={view} properties={schema} cardProperties={explicitCols} />;
  case 'timeline':
    return <TimelineView db={db} view={view} properties={schema} cardProperties={explicitCols} />;
  case 'map':
    return <MapView db={db} view={view} properties={schema} cardProperties={explicitCols} />;
  case 'graph':
    return <GraphView db={db} view={view} properties={schema} />;
  case 'bar':
    return <BarChartView db={db} view={view} properties={schema} />;
  case 'pie':
    return <PieChartView db={db} view={view} properties={schema} />;
  default:
    return <TableView db={db} view={view} columns={columns} schema={schema} />;
  }
};

/** Quick-search box: filters the active view's rows across every column. */
const SearchBox: React.FC<{db: UseDatabase}> = ({db}) => (
  <div className="flex items-center gap-1 rounded border border-transparent px-1.5 text-muted-foreground focus-within:border-border">
    <Search className="h-3.5 w-3.5 shrink-0" />
    <input
      value={db.search}
      onChange={(e) => db.setSearch(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') db.setSearch('');
      }}
      placeholder="Search"
      className="w-24 bg-transparent py-1 text-xs outline-hidden placeholder:text-placeholder-foreground focus:w-36"
      aria-label="Search rows"
    />
    {db.search && (
      <button onClick={() => db.setSearch('')} className="shrink-0 transition-colors hover:text-foreground" aria-label="Clear search">
        <X className="h-3 w-3" />
      </button>
    )}
  </div>
);

/**
 * A split "New ▾" control offering the database's row templates. Only rendered
 * when at least one template exists; the primary button still creates a blank
 * row, and the caret lists templates (and lets you delete them).
 */
const NewRowMenu: React.FC<{db: UseDatabase}> = ({db}) => {
  if (db.templates.length === 0) return null;
  return (
    <div className="flex items-center overflow-hidden rounded-md border border-border">
      <button
        onClick={() => void db.addRow()}
        className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> New
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="border-l border-border px-1 py-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-label="New from template"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => void db.addRow()}>
            <Plus className="mr-2 h-4 w-4" /> Blank row
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {db.templates.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onClick={() => void db.addRowFromTemplate(t.id)}
              className="group/tmpl justify-between gap-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Save className="h-4 w-4 shrink-0" />
                <span className="truncate">{t.name}</span>
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void db.deleteTemplate(t.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="shrink-0 text-muted-foreground/60 opacity-0 transition hover:text-destructive group-hover/tmpl:opacity-100"
                aria-label={`Delete template ${t.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const Toolbar: React.FC<{
  db: UseDatabase;
  view: DbView;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  onAddView: (type: DatabaseViewType) => void;
}> = ({
  db,
  view,
  renamingId,
  setRenamingId,
  onAddView,
}) => {
  const [dragView, setDragView] = useState<string | null>(null);
  const [overView, setOverView] = useState<string | null>(null);
  return (
    <div
      className="mb-2 flex items-center gap-2 overflow-x-auto max-sm:ob-edge-fade-x max-sm:pr-5 sm:flex-wrap sm:justify-between sm:overflow-visible"
      data-database-toolbar
    >
      {/* Below `sm`, both clusters stay on one horizontally scrollable line so
          the toolbar stays compact instead of wrapping into three rows (62px).
          Wider layouts retain the existing wrapping. */}
      <div className="flex shrink-0 items-center gap-0.5 sm:shrink sm:flex-wrap">
        {db.database!.schema.views.map((v) => {
          const Icon = viewIcon(v.type);
          const active = v.id === view.id;
          if (renamingId === v.id) {
            return (
              <input
                key={v.id}
                autoFocus
                defaultValue={v.name}
                onBlur={(e) => {
                  void db.renameView(v.id, e.target.value);
                  setRenamingId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  else if (e.key === 'Escape') setRenamingId(null);
                }}
                className="w-24 rounded bg-accent px-2 py-1 text-sm outline-hidden"
                aria-label="Rename view"
              />
            );
          }
          return (
            <button
              key={v.id}
              data-view-tab={v.id}
              draggable
              onDoubleClick={() => setRenamingId(v.id)}
              onDragStart={() => setDragView(v.id)}
              onDragEnd={() => {
                setDragView(null);
                setOverView(null);
              }}
              onDragOver={(e) => {
                if (dragView && dragView !== v.id) {
                  e.preventDefault();
                  setOverView(v.id);
                }
              }}
              onDrop={() => {
                if (dragView && dragView !== v.id) void db.reorderView(dragView, v.id);
                setDragView(null);
                setOverView(null);
              }}
              onClick={() => db.setActiveViewId(v.id)}
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-sm transition-colors',
                active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                dragView === v.id && 'opacity-40',
                overView === v.id && dragView !== v.id && 'ring-1 ring-brand/50',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {v.name}
            </button>
          );
        })}
        <AddViewMenu onAdd={onAddView} />
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:shrink sm:flex-wrap">
        <NewRowMenu db={db} />
        <SearchBox db={db} />
        <FilterMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
        <SortMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
        <GroupMenu db={db} view={view} />
        <FieldsMenu db={db} view={view} />
        <ViewOptionsMenu db={db} view={view} />
        <span className="px-1 text-xs text-muted-foreground/70">
          {db.visibleRows.length === db.rows.length
            ? `${db.visibleRows.length} row${db.visibleRows.length === 1 ? '' : 's'}`
            : `${db.visibleRows.length} of ${db.rows.length}`}
        </span>
      </div>
    </div>
  );
};

/**
 * The database section: a collection of row pages presented through the active
 * view (table, board, gallery, calendar, timeline, dependency graph, list, or a
 * bar/pie chart), with live `expr` + `formula` columns, dependencies,
 * drag-to-reschedule timelines, manual row ordering, inline editing, filtering,
 * sorting, search, configurable views, and add/remove/edit of properties. Used
 * both beneath a host page's own content (a full-page database) and embedded
 * inline via the database block.
 */
/**
 * Right-click actions for the database *as a whole* — view operations and a new
 * row — so the database chrome (toolbar, empty space, the section itself) opens
 * a database menu ("Rename view") instead of falling through to the page menu
 * ("Rename page"). Cell/column/row right-clicks still hit their own nested menus.
 */
const DatabaseContextMenu: React.FC<{
  db: UseDatabase;
  onRenameView: () => void;
  onConfigureExpiry: () => void;
  onAddView: (type: DatabaseViewType) => void;
  children: React.ReactNode;
}> = ({db, onRenameView, onConfigureExpiry, onAddView, children}) => {
  const view = db.activeView!;
  const canDeleteView = (db.database?.schema.views.length ?? 0) > 1;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH_MD}>
        <ContextMenuLabel className="text-xs font-medium text-muted-foreground">{view.name}</ContextMenuLabel>
        <ContextMenuItem onSelect={onRenameView}>
          <Pencil className="mr-2 h-4 w-4" />
          Rename view
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void db.duplicateView(view.id)}>
          <Copy className="mr-2 h-4 w-4" />
          Duplicate view
        </ContextMenuItem>
        {canDeleteView && (
          <ContextMenuItem className={MENU_DESTRUCTIVE_CLASS} onSelect={() => void db.deleteView(view.id)}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete view
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Plus className="mr-2 h-4 w-4" />
            Add view
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className={MENU_WIDTH_SM}>
            {VIEW_TYPES.map(({value, label, Icon}) => (
              <ContextMenuItem key={value} onSelect={() => onAddView(value)}>
                <Icon className="mr-2 h-4 w-4" />
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void db.addRow()}>
          <Rows3 className="mr-2 h-4 w-4" />
          New row
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* CSV lives here (data-level, whole-database actions) rather than in
            the per-view View options popover. Export honours the active view's
            filters/sorts/search (visibleRows), matching what's on screen —
            including cross-database rollups, which resolve against the same
            rollup rows/properties the cells display. */}
        <ContextMenuItem
          onSelect={() =>
            downloadText(
              `${safeFilename(view.name, 'database')}.csv`,
              rowsToCsv(db.visibleRows, db.database!.schema.properties, db.rollupProperties, db.rollupRows),
              'text/csv',
            )
          }
        >
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => importCsvFile(db.importCsv)}>
          <Upload className="mr-2 h-4 w-4" />
          Import CSV
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onConfigureExpiry}>
          <CalendarClock className="mr-2 h-4 w-4" />
          Auto-expiry…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * DB-level auto-expiry (TTL) settings: toggle it on, choose how old a row must be
 * (in days) and which timestamp its age is measured from (created / last-edited /
 * one of the database's own date columns) before it is moved to the trash. The
 * expired rows are soft-deleted (restorable), never hard-removed. Disabled by
 * default. Persists via {@link UseDatabase.saveSchema} → `updateDatabase`.
 */
const AutoExpiryForm: React.FC<{db: UseDatabase; onClose: () => void}> = ({db, onClose}) => {
  const {t} = useTranslation();
  const schema = db.database!.schema;
  const current = schema.autoExpiry;
  // Only `date` columns get their own basis option. A `created_time` column would
  // resolve to the row's created time (see resolveAutoExpiry) — identical to the
  // built-in "Created time" option below — so we suppress it to avoid a duplicate.
  const dateProps = schema.properties.filter((p) => p.type === 'date');
  const [enabled, setEnabled] = useState(!!current?.enabled);
  const [days, setDays] = useState(current?.days != null && current.days >= 1 ? String(current.days) : '30');
  const [basis, setBasis] = useState<string>(current?.basis ?? 'created');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    const parsedDays = Math.max(1, Math.floor(Number(days)) || 1);
    try {
      await db.saveSchema({...schema, autoExpiry: {enabled, days: parsedDays, basis}});
      onClose();
    } catch {
      // Keep the dialog open + usable; never strand it with both buttons disabled.
      showToast({message: t('database.autoExpiry.saveError')});
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Auto-expiry</DialogTitle>
        <DialogDescription>
          Automatically move rows in this database older than the chosen age to the trash, where they
          stay restorable until the trash is emptied. Applies to the whole database, not just this
          view. Checked about once an hour. Off by default.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auto-expiry-enabled">Enable auto-expiry</Label>
          <Switch
            id="auto-expiry-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Enable auto-expiry"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auto-expiry-days">Expire rows older than (days)</Label>
          <Input
            id="auto-expiry-days"
            inputSize="sm"
            type="number"
            min={1}
            step={1}
            value={days}
            disabled={!enabled}
            onChange={(e) => setDays(e.target.value)}
            aria-label="Expire rows older than, in days"
            className="w-24"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auto-expiry-basis">Measure age from</Label>
          <Select
            id="auto-expiry-basis"
            value={basis}
            disabled={!enabled}
            onChange={(e) => setBasis(e.target.value)}
            aria-label="Measure age from"
            wrapperClassName="w-48"
          >
            <option value="created">Created time</option>
            <option value="lastEdited">Last edited</option>
            {dateProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
};

const AutoExpiryDialog: React.FC<{db: UseDatabase; open: boolean; onOpenChange: (open: boolean) => void}> = ({
  db,
  open,
  onOpenChange,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      {/* Keyed so the form re-seeds from the persisted schema every time it opens. */}
      {open && <AutoExpiryForm key={db.database?.id ?? 'db'} db={db} onClose={() => onOpenChange(false)} />}
    </DialogContent>
  </Dialog>
);

/**
 * Honour a one-shot `?row=`/`?group=` deep link: once this database's host page
 * is the primary page and its rows have loaded, scroll the targeted row/group
 * header into view and briefly highlight it, then consume the anchor so it fires
 * exactly once. Only the page-level database (not an inline embed, and only when
 * it owns the primary page) claims the anchor — the link addressed THIS page.
 *
 * Best-effort: a row filtered out of the active view, or a group header for a
 * grouping the view no longer uses, simply won't be found — the anchor is cleared
 * anyway (after a few frames' grace for async layout) so it never re-fires.
 */
function useDatabaseAnchor(
  pageId: string,
  inline: boolean | undefined,
  loading: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
): void {
  const {rowAnchor, groupAnchor, clearRowAnchor, clearGroupAnchor, primaryPageId} = useNavigation();
  useEffect(() => {
    if (inline || pageId !== primaryPageId || loading) return;
    const target = rowAnchor
      ? {attr: 'data-row-anchor', value: rowAnchor, clear: clearRowAnchor}
      : groupAnchor
        ? {attr: 'data-group-anchor', value: groupAnchor, clear: clearGroupAnchor}
        : null;
    if (!target) return;
    // Escape the value for an attribute-equals selector (row ids are safe, but a
    // group key can be an arbitrary cell value — including newlines or other chars
    // that a hand-rolled quote/backslash escape would leave CSS-invalid, throwing
    // SyntaxError in the rAF loop and leaving the anchor stuck). CSS.escape covers
    // the full grammar; fall back to a manual escape where it's unavailable.
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(target.value)
        : target.value.replace(/["\\]/g, '\\$&');
    const selector = `[${target.attr}="${escaped}"]`;
    let tries = 0;
    let raf = 0;
    let timer = 0;
    const attempt = (): void => {
      // Scope to this pane's subtree so a database open in both split panes
      // resolves to *this* copy, not whichever the global query hits first.
      const root: ParentNode = containerRef.current ?? document;
      let el: Element | null;
      try {
        el = root.querySelector(selector);
      } catch {
        // A selector we still couldn't make valid: clear so it doesn't re-fire.
        target.clear();
        return;
      }
      if (el) {
        const reduce =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'center'});
        el.classList.add('ob-anchor-flash');
        timer = window.setTimeout(() => el.classList.remove('ob-anchor-flash'), 1800);
        target.clear();
        return;
      }
      // Give async layouts (board columns, timeline bands) a few frames to render
      // before giving up; then clear so a missing target doesn't re-fire forever.
      if (++tries > 20) {
        target.clear();
        return;
      }
      raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [rowAnchor, groupAnchor, clearRowAnchor, clearGroupAnchor, pageId, primaryPageId, inline, loading, containerRef]);
}

export const DatabaseView: React.FC<{pageId: string; databaseIdHint?: string | null; inline?: boolean}> = ({
  pageId,
  databaseIdHint,
  inline,
}) => {
  // A page-level database (the `?page='d host, not an inline embed) mirrors its
  // active view into the URL (`?view=`); the hook further gates on this being
  // the primary pane, so a split-pane database never fights for the param.
  const db = useDatabase(pageId, databaseIdHint, {syncViewToUrl: !inline});
  const anchorRootRef = useRef<HTMLDivElement>(null);
  useDatabaseAnchor(pageId, inline, db.loading, anchorRootRef);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const [expiryOpen, setExpiryOpen] = useState(false);
  // Add a view. When its layout still needs a property picked (fresh DB with no
  // date/location/dependency/group-by column), the in-body ViewSetupCard offers
  // the one-click fix — no need to pop View options open over it.
  const addView = (type: DatabaseViewType): void => {
    void db.addView(type);
  };
  if (!db.database || !db.activeView) return null;

  const schema = db.database.schema.properties;
  const view = db.activeView;
  // Table/list honour the view's chosen+ordered columns; other layouts show all.
  const visibleIds = view.visiblePropertyIds;
  const columns =
    visibleIds && visibleIds.length > 0
      ? (visibleIds.map((id) => schema.find((p) => p.id === id)).filter(Boolean) as DatabaseProperty[])
      : schema;

  return (
    <>
      {/* Portaled — kept OUTSIDE the context-menu trigger, whose `asChild` demands
          a single child (a second child throws React.Children.only). */}
      <AutoExpiryDialog db={db} open={expiryOpen} onOpenChange={setExpiryOpen} />
      <DatabaseContextMenu
        db={db}
        onRenameView={() => setRenamingViewId(view.id)}
        onConfigureExpiry={() => setExpiryOpen(true)}
        onAddView={addView}
      >
        <div
          ref={anchorRootRef}
          className={cn(inline ? 'rounded-lg border border-border p-3' : 'mt-6 border-t border-border pt-5')}
        >
          {inline && (
            <input
              defaultValue={db.database.name ?? ''}
              onBlur={(e) => e.target.value !== (db.database?.name ?? '') && void db.renameDatabase(e.target.value)}
              placeholder="Untitled database"
              className="mb-2 w-full bg-transparent text-base font-semibold outline-hidden placeholder:text-placeholder-foreground"
            />
          )}
          <Toolbar
            db={db}
            view={view}
            renamingId={renamingViewId}
            setRenamingId={setRenamingViewId}
            onAddView={addView}
          />
          <div className="flex flex-wrap items-center gap-x-3">
            <FilterChips db={db} view={view} />
            <SortChips db={db} view={view} />
            <GroupChips db={db} view={view} />
          </div>
          <MetricsBar db={db} view={view} />
          <ViewBody db={db} view={view} columns={columns} schema={schema} />
        </div>
      </DatabaseContextMenu>
    </>
  );
};

export default DatabaseView;
