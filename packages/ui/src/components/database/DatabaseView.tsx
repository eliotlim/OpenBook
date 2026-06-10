import React, {useState} from 'react';
import {ArrowDown, ArrowDownAZ, ArrowUp, ArrowUpAZ, ChevronDown, ChevronRight, Copy, EyeOff, Filter as FilterIcon, GripVertical, MoreHorizontal, PanelRightOpen, Plus, Rows3, Save, Search, Trash2, X} from 'lucide-react';
import {
  buildRowTree,
  dateStart,
  flattenRowTree,
  groupRows,
  shortId,
  summarizeColumn,
  TITLE_PROPERTY_ID,
  type DatabaseFilter,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type FilterOperator,
  type SummaryType,
} from '@open-book/sdk';
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
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {IconButton} from '@/components/ui/icon-button';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';
import {useDatabase, type UseDatabase} from './useDatabase';
import {cellValue, PropertyValueCell} from './databaseCells';
import {AddPropertyMenu, AddViewMenu, FilterChips, FilterMenu, MetricsBar, PropertyMenu, SortChips, SortMenu, SummaryPicker, ViewOptionsMenu, viewIcon} from './databaseMenus';
import {BoardView, CalendarView, GalleryView, rowColor, RowChips, RowContextMenu} from './databaseLayouts';
import {BarChartView, PieChartView} from './databaseCharts';
import {TimelineView} from './databaseTimeline';
import {GraphView} from './databaseGraph';
import {SWATCH_HEX} from './databaseColors';

const exprValueOf = (row: DatabaseRow, property: DatabaseProperty): unknown =>
  row.exports[property.cellName ?? property.name];

/** Per-row overflow menu: open in split, insert below, duplicate, delete. */
const RowMenu: React.FC<{
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSaveTemplate: () => void;
  onInsertBelow?: () => void;
  onInsertAbove?: () => void;
}> = ({onOpen, onDuplicate, onDelete, onSaveTemplate, onInsertBelow, onInsertAbove}) => (
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
    <DropdownMenuContent align="end" className="w-44">
      <DropdownMenuItem onClick={onOpen}>
        <PanelRightOpen className="mr-2 h-4 w-4" />
        Open in split
      </DropdownMenuItem>
      {onInsertAbove && (
        <DropdownMenuItem onClick={onInsertAbove}>
          <Plus className="mr-2 h-4 w-4" />
          Insert above
        </DropdownMenuItem>
      )}
      {onInsertBelow && (
        <DropdownMenuItem onClick={onInsertBelow}>
          <Plus className="mr-2 h-4 w-4" />
          Insert below
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={onDuplicate}>
        <Copy className="mr-2 h-4 w-4" />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onSaveTemplate}>
        <Save className="mr-2 h-4 w-4" />
        Save as template
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </DropdownMenuItem>
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
        className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition hover:bg-accent hover:text-foreground"
        aria-label={tree.collapsed ? 'Expand sub-items' : 'Collapse sub-items'}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !tree.collapsed && 'rotate-90')} />
      </button>
    ) : (
      tree?.anyExpandable && <span className="w-4 shrink-0" />
    )}
    <span className="shrink-0 text-sm leading-none">{readPageIcon(row.id)}</span>
    <input
      defaultValue={row.name ?? ''}
      key={`${row.id}:${row.name ?? ''}`}
      onBlur={(e) => {
        if ((e.target.value || '') !== (row.name ?? '')) void db.renameRow(row.id, e.target.value);
      }}
      placeholder="Untitled"
      className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground/40"
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

/** Append a leaf condition to the active view's filter tree (clearing the legacy flat list). */
function addQuickFilter(db: UseDatabase, view: DbView, propertyId: string, operator: FilterOperator, value: unknown): void {
  const root = view.filterRoot ?? {id: 'root', conjunction: 'and' as const, filters: view.filters ?? []};
  const condition: DatabaseFilter = {id: shortId('filter'), propertyId, operator, value};
  void db.updateView(view.id, {filterRoot: {...root, filters: [...root.filters, condition]}, filters: []});
}

/**
 * Right-click any row cell for quick actions: filter the view by the cell's value,
 * sort by its column, or act on the row (open / insert / duplicate / delete).
 * `property` is omitted for the title cell (row actions only).
 */
const CellContextMenu: React.FC<{
  db: UseDatabase;
  view?: DbView | null;
  row: DatabaseRow;
  property?: DatabaseProperty;
  value?: unknown;
  children: React.ReactNode;
}> = ({db, view, row, property, value, children}) => {
  const filter = property && view ? quickFilter(property, value) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Block + w-full so cell content (e.g. a number's flex-1 progress bar)
            fills the cell rather than collapsing to content width. */}
        <div className="min-h-[1.75rem] w-full [&>*]:w-full">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
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
            <ContextMenuSubContent className="w-44">
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
              <ArrowDownAZ className="mr-2 h-3.5 w-3.5" /> Sort ascending
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'desc'}]})}>
              <ArrowUpAZ className="mr-2 h-3.5 w-3.5" /> Sort descending
            </ContextMenuItem>
            {view.groupByPropertyId === property.id ? (
              <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: undefined})}>
                <Rows3 className="mr-2 h-3.5 w-3.5" /> Ungroup
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: property.id})}>
                <Rows3 className="mr-2 h-3.5 w-3.5" /> Group by {property.name}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => db.openRow(row.id)}>
          <PanelRightOpen className="mr-2 h-3.5 w-3.5" /> Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void db.addRowAfter(row.id)}>
          <Plus className="mr-2 h-3.5 w-3.5" /> Insert below
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void db.duplicateRow(row.id)}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void db.deleteRow(row.id)} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/**
 * Right-click a column header for quick column actions — sort, group by, hide,
 * duplicate, delete — without opening the property "⋯" menu (which stays for
 * detailed editing: name, type, options, format).
 */
const ColumnContextMenu: React.FC<{db: UseDatabase; view: DbView; property: DatabaseProperty; children: React.ReactNode}> = ({db, view, property, children}) => {
  const hide = (): void => {
    const all = db.database!.schema.properties.map((p) => p.id);
    const current = view.visiblePropertyIds?.length ? view.visiblePropertyIds : all;
    void db.updateView(view.id, {visiblePropertyIds: current.filter((id) => id !== property.id)});
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'asc'}]})}>
          <ArrowDownAZ className="mr-2 h-3.5 w-3.5" /> Sort ascending
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void db.updateView(view.id, {sorts: [{propertyId: property.id, direction: 'desc'}]})}>
          <ArrowUpAZ className="mr-2 h-3.5 w-3.5" /> Sort descending
        </ContextMenuItem>
        {view.groupByPropertyId === property.id ? (
          <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: undefined})}>
            <Rows3 className="mr-2 h-3.5 w-3.5" /> Ungroup
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => void db.updateView(view.id, {groupByPropertyId: property.id})}>
            <Rows3 className="mr-2 h-3.5 w-3.5" /> Group by {property.name}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={hide}>
          <EyeOff className="mr-2 h-3.5 w-3.5" /> Hide in view
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void db.duplicateProperty(property.id)}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void db.deleteProperty(property.id)} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const DataRow: React.FC<ViewProps & {row: DatabaseRow; drag: DragApi; tree?: RowTreeInfo; selection?: {selected: boolean; onToggle: () => void}}> = ({db, columns, schema, row, drag, tree, selection}) => {
  const accent = db.activeView ? rowColor(row, db.activeView, schema, db.rows) : undefined;
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
      onDragOver={(e) => {
        if (drag.canReorder && drag.dragRow) {
          e.preventDefault();
          drag.over(row.id);
        }
      }}
      onDrop={() => drag.drop(row.id)}
      className={cn(
        'group border-b border-border/70 last:border-0 hover:bg-accent/20',
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
            <RowMenu
              onOpen={() => db.openRow(row.id)}
              onInsertAbove={() => void db.addRowBefore(row.id)}
              onInsertBelow={() => void db.addRowAfter(row.id)}
              onDuplicate={() => void db.duplicateRow(row.id)}
              onSaveTemplate={() => void db.saveAsTemplate(row.id)}
              onDelete={() => void db.deleteRow(row.id)}
            />
          </div>
        </div>
      </td>
      {columns.map((property) => {
        const value = cellValue(row, property, schema, db.rows);
        return (
          <td key={property.id} className="border-l border-border/70 align-middle">
            <CellContextMenu db={db} view={db.activeView} row={row} property={property} value={value}>
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

const NewRowRow: React.FC<{colSpan: number; onClick: () => void; label?: string}> = ({colSpan, onClick, label}) => (
  <tr>
    <td colSpan={colSpan} className="p-0">
      <button
        onClick={onClick}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
  columns: DatabaseProperty[];
  schema: DatabaseProperty[];
  rows: DatabaseRow[];
  summaryOf: (key: string) => SummaryType;
}> = ({columns, schema, rows, summaryOf}) => (
  <tr className="bg-muted/10 text-xs text-muted-foreground/80">
    <td className="px-2 py-1 align-middle tabular-nums">
      {summarizeColumn(rows, TITLE_PROPERTY_ID, summaryOf(TITLE_PROPERTY_ID), schema)}
    </td>
    {columns.map((property) => (
      <td key={property.id} className="border-l border-border/60 px-2 py-1 align-middle tabular-nums">
        {summarizeColumn(rows, property, summaryOf(property.id), schema)}
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

  const groupProp = view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  const hasSubItems = db.visibleRows.some((r) => r.parentId);
  // Manual drag-reorder is only well-defined over the full, unfiltered, unsorted,
  // ungrouped, flat list (otherwise "where does it land?" is ambiguous).
  const canReorder =
    !groupProp &&
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

  const allGroups = groupProp ? groupRows(db.visibleRows, groupProp, schema) : null;
  const groups = allGroups && view.hideEmptyGroups ? allGroups.filter((g) => g.rows.length > 0) : allGroups;
  const allCollapsed = !!groups && groups.length > 0 && groups.every((g) => collapsed.has(g.key));
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
                          <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[o.color ?? 'gray'] ?? SWATCH_HEX.gray}} />
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
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)))}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                    <ColumnContextMenu db={db} view={view} property={property}>
                      <span className="flex items-center justify-between gap-1">
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate">{property.name}</span>
                          {sortDir === 'asc' && <ArrowUp className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                          {sortDir === 'desc' && <ArrowDown className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
                        </span>
                        <PropertyMenu property={property} db={db} index={i} count={columns.length} />
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
              const isCollapsed = collapsed.has(group.key);
              const initial =
              groupProp?.type === 'select' && group.key !== '__none__' && group.key !== '__all__'
                ? {[groupProp.id]: group.key}
                : undefined;
              return (
                <tbody key={group.key} className="border-b border-border">
                  <tr className="bg-muted/20">
                    <td colSpan={colSpan} className="px-2 py-1">
                      <button onClick={() => toggleGroup(group.key)} className="flex items-center gap-1.5 text-xs font-medium">
                        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                        {group.color && (
                          <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
                        )}
                        <span>{group.label}</span>
                        <span className="text-muted-foreground/60">{group.rows.length}</span>
                      </button>
                    </td>
                  </tr>
                  {!isCollapsed &&
                  group.rows.map((row) => (
                    <DataRow key={row.id} db={db} columns={columns} schema={schema} row={row} drag={drag} selection={selectionOf(row.id)} />
                  ))}
                  {!isCollapsed && <NewRowRow colSpan={colSpan} onClick={() => void db.addRow(initial)} label="New" />}
                  {!isCollapsed && hasSummaries && (
                    <GroupSummaryRow columns={columns} schema={schema} rows={group.rows} summaryOf={summaryOf} />
                  )}
                </tbody>
              );
            })
          ) : (
            <tbody>
              {treeRows.map((node) => (
                <DataRow key={node.row.id} db={db} columns={columns} schema={schema} row={node.row} drag={drag} tree={treeInfo(node)} selection={selectionOf(node.row.id)} />
              ))}
              {db.visibleRows.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-2 py-3 text-center text-sm text-muted-foreground">
                  No rows{db.rows.length > 0 ? ' match the current view' : ' yet'}.
                  </td>
                </tr>
              )}
              <NewRowRow colSpan={colSpan} onClick={() => void db.addRow()} />
            </tbody>
          )}

          <tfoot>
            <tr className="border-t border-border bg-muted/10 text-xs">
              <td className="sticky left-0 z-10 border-r border-border bg-card align-middle">
                <SummaryPicker
                  current={summaryOf(TITLE_PROPERTY_ID)}
                  display={summarizeColumn(db.visibleRows, TITLE_PROPERTY_ID, summaryOf(TITLE_PROPERTY_ID), schema)}
                  onChange={(t) => setSummary(TITLE_PROPERTY_ID, t)}
                />
              </td>
              {columns.map((property) => (
                <td key={property.id} className="border-l border-border/60 align-middle">
                  <SummaryPicker
                    current={summaryOf(property.id)}
                    display={summarizeColumn(db.visibleRows, property, summaryOf(property.id), schema)}
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
  const accent = db.activeView ? rowColor(row, db.activeView, db.database?.schema.properties ?? [], db.rows) : undefined;
  return (
    <RowContextMenu db={db} rowId={row.id}>
      <div
        style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
        className="group flex cursor-pointer items-center justify-between gap-2 border-b border-border/70 px-3 py-2 last:border-0 hover:bg-accent/30"
        onClick={() => db.openRow(row.id)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-base leading-none">{readPageIcon(row.id)}</span>
          <span className="shrink-0 truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</span>
          <RowChips row={row} properties={columns} rows={db.rows} labelled />
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <RowMenu
            onOpen={() => db.openRow(row.id)}
            onDuplicate={() => void db.duplicateRow(row.id)}
            onSaveTemplate={() => void db.saveAsTemplate(row.id)}
            onDelete={() => void db.deleteRow(row.id)}
          />
        </div>
      </div>
    </RowContextMenu>
  );
};

const ListView: React.FC<ViewProps & {view: DbView}> = ({db, columns, schema, view}) => {
  const groupProp = view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (groupProp) {
    const all = groupRows(db.visibleRows, groupProp, schema);
    const groups = view.hideEmptyGroups ? all.filter((g) => g.rows.length > 0) : all;
    return (
      <div className="space-y-3">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.key);
          return (
            <div key={group.key} className="overflow-hidden rounded-md border border-border">
              <button onClick={() => toggle(group.key)} className="flex w-full items-center gap-1.5 bg-muted/20 px-3 py-1.5 text-xs font-medium">
                <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')} />
                {group.color && (
                  <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
                )}
                <span>{group.label}</span>
                <span className="text-muted-foreground/60">{group.rows.length}</span>
              </button>
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
        className="flex w-full items-center gap-1 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
      placeholder="Search"
      className="w-24 bg-transparent py-1 text-xs outline-hidden placeholder:text-muted-foreground/60 focus:w-36"
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
        className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> New
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="border-l border-border px-1 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

const Toolbar: React.FC<{db: UseDatabase; view: DbView}> = ({db, view}) => {
  const [dragView, setDragView] = useState<string | null>(null);
  const [overView, setOverView] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      {/* Both clusters wrap so the toolbar degrades to stacked rows on narrow
          screens instead of clipping the trailing controls. */}
      <div className="flex flex-wrap items-center gap-0.5">
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
                active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                dragView === v.id && 'opacity-40',
                overView === v.id && dragView !== v.id && 'ring-1 ring-brand/50',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {v.name}
            </button>
          );
        })}
        <AddViewMenu onAdd={(type) => void db.addView(type)} />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <NewRowMenu db={db} />
        <SearchBox db={db} />
        <FilterMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
        <SortMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
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
export const DatabaseView: React.FC<{pageId: string; databaseIdHint?: string | null; inline?: boolean}> = ({
  pageId,
  databaseIdHint,
  inline,
}) => {
  const db = useDatabase(pageId, databaseIdHint);
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
    <div className={cn(inline ? 'rounded-lg border border-border p-3' : 'mt-6 border-t border-border pt-5')}>
      {inline && (
        <input
          defaultValue={db.database.name ?? ''}
          onBlur={(e) => e.target.value !== (db.database?.name ?? '') && void db.renameDatabase(e.target.value)}
          placeholder="Untitled database"
          className="mb-2 w-full bg-transparent text-base font-semibold outline-hidden placeholder:text-muted-foreground/40"
        />
      )}
      <Toolbar db={db} view={view} />
      <div className="flex flex-wrap items-center gap-x-3">
        <FilterChips db={db} view={view} />
        <SortChips db={db} view={view} />
      </div>
      <MetricsBar db={db} view={view} />
      <ViewBody db={db} view={view} columns={columns} schema={schema} />
    </div>
  );
};

export default DatabaseView;
