import React, {useState} from 'react';
import {ChevronLeft, ChevronRight, PanelRightOpen, Plus} from 'lucide-react';
import {groupRows, type DatabaseProperty, type DatabaseRow, type DatabaseView as DbView} from '@open-book/sdk';
import {cn} from '@/lib/utils';
import {readPageIcon} from '@/lib/pageIcon';
import {pageLinks} from '@/lib/pageLinks';
import type {UseDatabase} from './useDatabase';
import {cellValue, formatCellValue, SelectChip} from './databaseCells';
import {SWATCH_HEX} from './databaseColors';

/**
 * Compact, read-only chips summarising a row's property values. Shared by the
 * list, gallery, and board layouts so a row reads the same wherever it appears.
 */
export const RowChips: React.FC<{row: DatabaseRow; properties: DatabaseProperty[]; labelled?: boolean}> = ({
  row,
  properties,
  labelled,
}) => (
  <div className="flex min-w-0 flex-wrap items-center gap-1">
    {properties.map((property) => {
      const value = cellValue(row, property, properties);
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
            {ids.map((id) => pageLinks.label(id)).join(', ')}
          </span>
        );
      }
      const text = formatCellValue(property, value);
      if (!text) return null;
      return (
        <span key={property.id} className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {labelled ? `${property.name}: ${text}` : text}
        </span>
      );
    })}
  </div>
);

const NewRowButton: React.FC<{onClick: () => void; label?: string; className?: string}> = ({onClick, label, className}) => (
  <button
    onClick={onClick}
    className={cn(
      'flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground',
      className,
    )}
  >
    <Plus className="h-4 w-4" /> {label ?? 'New'}
  </button>
);

/** Gallery: a responsive grid of cards, one per row. */
export const GalleryView: React.FC<{db: UseDatabase; properties: DatabaseProperty[]}> = ({db, properties}) => (
  <div>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
      {db.visibleRows.map((row) => (
        <button
          key={row.id}
          onClick={() => db.openRow(row.id)}
          className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent/30"
        >
          <div className="flex h-16 items-center justify-center rounded-md bg-muted/40 text-3xl">{readPageIcon(row.id)}</div>
          <div className="truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</div>
          <RowChips row={row} properties={properties} />
        </button>
      ))}
    </div>
    {db.visibleRows.length === 0 && (
      <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
        No rows{db.rows.length > 0 ? ' match the current filters' : ' yet'}.
      </div>
    )}
    <NewRowButton onClick={() => void db.addRow()} label="New card" className="mt-3" />
  </div>
);

/**
 * Board (kanban): columns from the view's group-by property. Cards drag between
 * columns to change their group value (when grouping on a `select`). A per-column
 * "+ New" creates a row already set to that column.
 */
export const BoardView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  const groupProp = properties.find((p) => p.id === view.groupByPropertyId);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const groups = groupRows(db.visibleRows, groupProp, properties);
  const canMove = groupProp?.type === 'select';
  // Properties shown on a card exclude the grouping one (it's the column itself).
  const cardProps = properties.filter((p) => p.id !== groupProp?.id);

  const drop = (key: string): void => {
    if (!dragRow || !groupProp || !canMove) return;
    const value = key === '__none__' ? null : key;
    void db.setRowProperty(dragRow, groupProp.id, value);
    setDragRow(null);
    setOverKey(null);
  };

  const newInColumn = (key: string): void => {
    const initial = canMove && key !== '__none__' && key !== '__all__' ? {[groupProp!.id]: key} : undefined;
    void db.addRow(initial);
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groups.map((group) => (
        <div
          key={group.key}
          onDragOver={(e) => {
            if (canMove) {
              e.preventDefault();
              setOverKey(group.key);
            }
          }}
          onDrop={() => drop(group.key)}
          className={cn(
            'flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2 transition-colors',
            overKey === group.key && 'bg-accent/50 ring-1 ring-brand/40',
          )}
        >
          <div className="flex items-center gap-1.5 px-1 text-xs font-medium">
            {group.color && (
              <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
            )}
            <span className="truncate">{group.label}</span>
            <span className="text-muted-foreground/60">{group.rows.length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {group.rows.map((row) => (
              <div
                key={row.id}
                draggable={canMove}
                onDragStart={() => setDragRow(row.id)}
                onDragEnd={() => setDragRow(null)}
                onClick={() => db.openRow(row.id)}
                className={cn(
                  'group cursor-pointer rounded-md border border-border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-foreground/20',
                  dragRow === row.id && 'opacity-50',
                )}
              >
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="shrink-0 text-sm leading-none">{readPageIcon(row.id)}</span>
                  <span className="truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</span>
                  <PanelRightOpen className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition group-hover:text-muted-foreground/60" />
                </div>
                <RowChips row={row} properties={cardProps} />
              </div>
            ))}
          </div>
          <NewRowButton onClick={() => newInColumn(group.key)} label="New" className="px-1 py-1" />
        </div>
      ))}
    </div>
  );
};

// ── Calendar ──────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Normalise a cell value to a local `YYYY-MM-DD` day key, or null if undated. */
const dayKey = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  // `date` properties are already `YYYY-MM-DD`; timestamps are full ISO strings.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const ymd = (y: number, m: number, d: number): string =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Calendar: rows laid out on a month grid by a date property. */
export const CalendarView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  const dateProp = properties.find((p) => p.id === view.datePropertyId);
  const today = new Date();
  const [cursor, setCursor] = useState({year: today.getFullYear(), month: today.getMonth()});

  if (!dateProp) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        Choose a date property in the view options to lay rows out on a calendar.
      </div>
    );
  }

  // Bucket rows by their day key.
  const byDay = new Map<string, DatabaseRow[]>();
  for (const row of db.visibleRows) {
    const key = dayKey(cellValue(row, dateProp, properties));
    if (!key) continue;
    const list = byDay.get(key) ?? [];
    list.push(row);
    byDay.set(key, list);
  }

  const first = new Date(cursor.year, cursor.month, 1);
  const startOffset = first.getDay();
  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startOffset; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const shift = (delta: number): void => {
    const m = cursor.month + delta;
    setCursor({year: cursor.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12});
  };

  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-medium">
          {MONTHS[cursor.month]} {cursor.year}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setCursor({year: today.getFullYear(), month: today.getMonth()})} className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            Today
          </button>
          <button onClick={() => shift(-1)} className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={() => shift(1)} className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 border-b border-border bg-muted/20 text-center text-[11px] font-medium text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          const key = day ? ymd(cursor.year, cursor.month, day) : null;
          const rows = key ? byDay.get(key) ?? [] : [];
          return (
            <div
              key={i}
              className={cn(
                'min-h-[88px] border-b border-r border-border/60 p-1 last:border-r-0 [&:nth-child(7n)]:border-r-0',
                !day && 'bg-muted/10',
              )}
            >
              {day && (
                <div className={cn('mb-1 text-right text-xs', key === todayKey ? 'font-semibold text-brand' : 'text-muted-foreground/70')}>
                  {day}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    onClick={() => db.openRow(row.id)}
                    className="flex items-center gap-1 truncate rounded bg-brand/10 px-1 py-0.5 text-left text-[11px] text-foreground/80 transition-colors hover:bg-brand/20"
                    title={row.name ?? 'Untitled'}
                  >
                    <span className="shrink-0 leading-none">{readPageIcon(row.id)}</span>
                    <span className="truncate">{row.name?.trim() || 'Untitled'}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
