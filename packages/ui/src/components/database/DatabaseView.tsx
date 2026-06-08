import React, {useState} from 'react';
import {ChevronRight, GripVertical, MoreHorizontal, PanelRightOpen, Plus, Search, Trash2, X} from 'lucide-react';
import {
  groupRows,
  summarizeColumn,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type SummaryType,
} from '@open-book/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';
import {useDatabase, type UseDatabase} from './useDatabase';
import {cellValue, PropertyValueCell} from './databaseCells';
import {AddPropertyMenu, AddViewMenu, FilterMenu, PropertyMenu, SortMenu, SummaryPicker, ViewOptionsMenu, viewIcon} from './databaseMenus';
import {BoardView, CalendarView, GalleryView, RowChips} from './databaseLayouts';
import {BarChartView, PieChartView} from './databaseCharts';
import {SWATCH_HEX} from './databaseColors';

const exprValueOf = (row: DatabaseRow, property: DatabaseProperty): unknown =>
  row.exports[property.cellName ?? property.name];

/** Per-row overflow menu: open in split, delete. */
const RowMenu: React.FC<{onOpen: () => void; onDelete: () => void}> = ({onOpen, onDelete}) => (
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
      <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

/** The title cell: a drag handle, an open-in-split affordance + inline-editable name. */
const TitleCell: React.FC<{row: DatabaseRow; db: UseDatabase; dragHandle?: React.ReactNode}> = ({row, db, dragHandle}) => (
  <div className="group/title flex items-center gap-1">
    {dragHandle}
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
    <IconButton
      size="sm"
      onClick={() => db.openRow(row.id)}
      className="text-muted-foreground/60 opacity-0 transition group-hover/title:opacity-100"
      aria-label="Open row"
      title="Open in split"
    >
      <PanelRightOpen className="h-3.5 w-3.5" />
    </IconButton>
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

/** One table row, optionally drag-reorderable. */
const DataRow: React.FC<ViewProps & {row: DatabaseRow; drag: DragApi}> = ({db, columns, schema, row, drag}) => {
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
      <td className="px-2 py-0.5 align-middle">
        <div className="flex items-center justify-between gap-1">
          <div className="min-w-0 flex-1">
            <TitleCell row={row} db={db} dragHandle={handle} />
          </div>
          <RowMenu onOpen={() => db.openRow(row.id)} onDelete={() => void db.deleteRow(row.id)} />
        </div>
      </td>
      {columns.map((property) => (
        <td key={property.id} className="border-l border-border/70 align-middle">
          <PropertyValueCell
            property={property}
            value={cellValue(row, property, schema)}
            exprValue={exprValueOf(row, property)}
            onChange={(value) => void db.setRowProperty(row.id, property.id, value)}
            onAddOption={(label) => db.addSelectOption(property.id, label)}
          />
        </td>
      ))}
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

const TableView: React.FC<ViewProps & {view: DbView}> = ({db, columns, schema, view}) => {
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groupProp = view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  // Manual drag-reorder is only well-defined over the full, unfiltered, unsorted,
  // ungrouped list (otherwise "where does it land?" is ambiguous).
  const canReorder =
    !groupProp && (view.sorts?.length ?? 0) === 0 && (view.filters?.length ?? 0) === 0 && !db.search.trim();

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

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups = groupProp ? groupRows(db.visibleRows, groupProp, schema) : null;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-xs font-medium text-muted-foreground">
            <th className="min-w-[220px] px-2 py-1.5 font-medium">Name</th>
            {columns.map((property, i) => (
              <th key={property.id} className="group min-w-[140px] border-l border-border px-2 py-1.5 font-medium">
                <span className="flex items-center justify-between gap-1">
                  <span className="truncate">{property.name}</span>
                  <PropertyMenu property={property} db={db} index={i} count={columns.length} />
                </span>
              </th>
            ))}
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
                  group.rows.map((row) => <DataRow key={row.id} db={db} columns={columns} schema={schema} row={row} drag={drag} />)}
                {!isCollapsed && <NewRowRow colSpan={colSpan} onClick={() => void db.addRow(initial)} label="New" />}
              </tbody>
            );
          })
        ) : (
          <tbody>
            {db.visibleRows.map((row) => (
              <DataRow key={row.id} db={db} columns={columns} schema={schema} row={row} drag={drag} />
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
            <td className="align-middle">
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
  );
};

const ListView: React.FC<ViewProps> = ({db, columns}) => (
  <div className="overflow-hidden rounded-md border border-border">
    {db.visibleRows.map((row) => (
      <div
        key={row.id}
        className="group flex cursor-pointer items-center justify-between gap-2 border-b border-border/70 px-3 py-2 last:border-0 hover:bg-accent/30"
        onClick={() => db.openRow(row.id)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-base leading-none">{readPageIcon(row.id)}</span>
          <span className="shrink-0 truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</span>
          <RowChips row={row} properties={columns} labelled />
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <RowMenu onOpen={() => db.openRow(row.id)} onDelete={() => void db.deleteRow(row.id)} />
        </div>
      </div>
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

/** Render the active view's body for its layout type. */
const ViewBody: React.FC<{db: UseDatabase; view: DbView; columns: DatabaseProperty[]; schema: DatabaseProperty[]}> = ({
  db,
  view,
  columns,
  schema,
}) => {
  switch (view.type) {
  case 'list':
    return <ListView db={db} columns={columns} schema={schema} />;
  case 'gallery':
    return <GalleryView db={db} properties={columns} />;
  case 'board':
    return <BoardView db={db} view={view} properties={schema} />;
  case 'calendar':
    return <CalendarView db={db} view={view} properties={schema} />;
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

const Toolbar: React.FC<{db: UseDatabase; view: DbView}> = ({db, view}) => (
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
    <div className="flex items-center gap-0.5">
      {db.database!.schema.views.map((v) => {
        const Icon = viewIcon(v.type);
        const active = v.id === view.id;
        return (
          <button
            key={v.id}
            onClick={() => db.setActiveViewId(v.id)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-sm transition-colors',
              active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {v.name}
          </button>
        );
      })}
      <AddViewMenu onAdd={(type) => void db.addView(type)} />
    </div>
    <div className="flex items-center gap-1">
      <SearchBox db={db} />
      <FilterMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
      <SortMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
      <ViewOptionsMenu db={db} view={view} />
      <span className="px-1 text-xs text-muted-foreground/70">
        {db.visibleRows.length} row{db.visibleRows.length === 1 ? '' : 's'}
      </span>
    </div>
  </div>
);

/**
 * The database section: a collection of row pages presented through the active
 * view (table, board, gallery, calendar, list, or a bar/pie chart), with live
 * `expr` + `formula` columns, inline editing, filtering, sorting, configurable
 * views, and add/remove/edit of properties. Used both beneath a host page's own
 * content (a full-page database) and embedded inline via the database block.
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
      <ViewBody db={db} view={view} columns={columns} schema={schema} />
    </div>
  );
};

export default DatabaseView;
