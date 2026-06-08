import React from 'react';
import {List, MoreHorizontal, PanelRightOpen, Plus, Table2, Trash2} from 'lucide-react';
import type {DatabaseProperty, DatabaseRow, DatabaseView as DbView} from '@open-book/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {readPageIcon} from '@/lib/pageIcon';
import {pageLinks} from '@/lib/pageLinks';
import {cn} from '@/lib/utils';
import {useDatabase, type UseDatabase} from './useDatabase';
import {cellValue, formatCellValue, PropertyValueCell, SelectChip} from './databaseCells';
import {AddPropertyMenu, FilterMenu, PropertyHeaderMenu, SortMenu} from './databaseMenus';

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

const TableView: React.FC<{db: UseDatabase; properties: DatabaseProperty[]}> = ({db, properties}) => (
  <div className="overflow-x-auto rounded-md border border-border">
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border bg-muted/30 text-left text-xs font-medium text-muted-foreground">
          <th className="min-w-[220px] px-2 py-1.5 font-medium">Name</th>
          {properties.map((property) => (
            <th key={property.id} className="group min-w-[140px] border-l border-border px-2 py-1.5 font-medium">
              <span className="flex items-center justify-between gap-1">
                <span className="truncate">{property.name}</span>
                <PropertyHeaderMenu onDelete={() => void db.deleteProperty(property.id)} />
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
            {properties.map((property) => (
              <td key={property.id} className="border-l border-border/70 align-middle">
                <PropertyValueCell
                  property={property}
                  value={cellValue(row, property)}
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
            <td colSpan={properties.length + 2} className="px-2 py-3 text-center text-sm text-muted-foreground">
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

const ListView: React.FC<{db: UseDatabase; properties: DatabaseProperty[]}> = ({db, properties}) => (
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
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {properties.map((property) => {
              const value = cellValue(row, property);
              if (property.type === 'select') {
                const option = property.options?.find((o) => o.id === value);
                return option ? <SelectChip key={property.id} option={option} /> : null;
              }
              if (property.type === 'multi_select') {
                const ids = Array.isArray(value) ? (value as string[]) : [];
                const opts = (property.options ?? []).filter((o) => ids.includes(o.id));
                return opts.length ? (
                  <span key={property.id} className="flex flex-wrap items-center gap-1">
                    {opts.map((o) => (
                      <SelectChip key={o.id} option={o} />
                    ))}
                  </span>
                ) : null;
              }
              if (property.type === 'relation') {
                const ids = Array.isArray(value) ? (value as string[]) : [];
                if (ids.length === 0) return null;
                return (
                  <span key={property.id} className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {property.name}: {ids.map((id) => pageLinks.label(id)).join(', ')}
                  </span>
                );
              }
              const text = formatCellValue(property, value);
              if (!text) return null;
              return (
                <span key={property.id} className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {property.name}: {text}
                </span>
              );
            })}
          </div>
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

const VIEW_ICON = {table: Table2, list: List} as const;

const Toolbar: React.FC<{db: UseDatabase; view: DbView}> = ({db, view}) => (
  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
    <div className="flex items-center gap-0.5">
      {db.database!.schema.views.map((v) => {
        const Icon = VIEW_ICON[v.type];
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
    </div>
    <div className="flex items-center gap-1">
      <FilterMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
      <SortMenu database={db.database!} view={view} onChange={(patch) => void db.updateView(view.id, patch)} />
      <span className="px-1 text-xs text-muted-foreground/70">
        {db.visibleRows.length} row{db.visibleRows.length === 1 ? '' : 's'}
      </span>
    </div>
  </div>
);

/**
 * The database section rendered beneath a host page's own content. Shows the
 * collection of row pages through the active view (table or list), with live
 * `expr` columns, inline editing, filtering and sorting, and opening a row in
 * the split pane. Renders nothing for ordinary (non-host) pages.
 */
export const DatabaseView: React.FC<{pageId: string; databaseIdHint?: string | null}> = ({pageId, databaseIdHint}) => {
  const db = useDatabase(pageId, databaseIdHint);
  if (!db.database || !db.activeView) return null;

  const properties = db.database.schema.properties;
  const view = db.activeView;

  return (
    <div className="mt-6 border-t border-border pt-5">
      <Toolbar db={db} view={view} />
      {view.type === 'list' ? <ListView db={db} properties={properties} /> : <TableView db={db} properties={properties} />}
    </div>
  );
};

export default DatabaseView;
