import React from 'react';
import {MoreHorizontal, PanelRightOpen, Plus, Trash2} from 'lucide-react';
import type {DatabaseProperty, DatabaseRow, DatabaseView as DbView} from '@open-book/sdk';
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
import {AddPropertyMenu, AddViewMenu, FilterMenu, PropertyMenu, SortMenu, ViewOptionsMenu, viewIcon} from './databaseMenus';
import {BoardView, CalendarView, GalleryView, RowChips} from './databaseLayouts';
import {BarChartView, PieChartView} from './databaseCharts';

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

/** The title cell: an open-in-split affordance + an inline-editable page name. */
const TitleCell: React.FC<{row: DatabaseRow; db: UseDatabase}> = ({row, db}) => (
  <div className="group/title flex items-center gap-1">
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

const TableView: React.FC<ViewProps> = ({db, columns, schema}) => (
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
      <tbody>
        {db.visibleRows.map((row) => (
          <tr key={row.id} className="group border-b border-border/70 last:border-0 hover:bg-accent/20">
            <td className="px-2 py-0.5 align-middle">
              <div className="flex items-center justify-between gap-1">
                <div className="min-w-0 flex-1">
                  <TitleCell row={row} db={db} />
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
        ))}
        {db.visibleRows.length === 0 && (
          <tr>
            <td colSpan={columns.length + 2} className="px-2 py-3 text-center text-sm text-muted-foreground">
              No rows{db.rows.length > 0 ? ' match the current filters' : ' yet'}.
            </td>
          </tr>
        )}
      </tbody>
    </table>
    <button
      onClick={() => void db.addRow()}
      className="flex w-full items-center gap-1 px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Plus className="h-4 w-4" /> New row
    </button>
  </div>
);

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
    return <TableView db={db} columns={columns} schema={schema} />;
  }
};

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
