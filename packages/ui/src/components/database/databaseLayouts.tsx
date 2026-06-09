import React, {useState} from 'react';
import {ChevronLeft, ChevronRight, Copy, PanelRightOpen, Plus, Trash2} from 'lucide-react';
import {
  dateEnd,
  dateStart,
  firstImageUrl,
  groupRows,
  parseDay,
  rowMatchesCondition,
  summarizeColumn,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type SummaryType,
} from '@open-book/sdk';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
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
export const RowChips: React.FC<{row: DatabaseRow; properties: DatabaseProperty[]; rows?: DatabaseRow[]; labelled?: boolean}> = ({
  row,
  properties,
  rows,
  labelled,
}) => (
  <div className="flex min-w-0 flex-wrap items-center gap-1">
    {properties.map((property) => {
      const value = cellValue(row, property, properties, rows);
      if (property.type === 'select' || property.type === 'status') {
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

/** The card-edge tint for a row from a `select`/`status` colour property, or undefined. */
export function cardAccent(row: DatabaseRow, colorProperty: DatabaseProperty | undefined): string | undefined {
  if (!colorProperty || (colorProperty.type !== 'select' && colorProperty.type !== 'status')) return undefined;
  const optId = row.properties[colorProperty.id];
  const color = colorProperty.options?.find((o) => o.id === optId)?.color;
  return color ? SWATCH_HEX[color] ?? undefined : undefined;
}

/**
 * The row/card edge tint for a row under a view's conditional formatting: the
 * first matching {@link ColorRule}'s colour, else the `cardColorPropertyId`
 * select-option colour. The single source of row colouring across every layout.
 */
export function rowColor(row: DatabaseRow, view: DbView, properties: DatabaseProperty[], rows?: DatabaseRow[]): string | undefined {
  for (const rule of view.colorRules ?? []) {
    if (rowMatchesCondition(row, rule, properties, rows)) return SWATCH_HEX[rule.color] ?? rule.color;
  }
  return view.cardColorPropertyId ? cardAccent(row, properties.find((p) => p.id === view.cardColorPropertyId)) : undefined;
}

/**
 * Right-click any card (board / gallery) for the same quick row actions as the
 * table — open, insert below, duplicate, delete — without opening the row first.
 */
export const RowContextMenu: React.FC<{db: UseDatabase; rowId: string; children: React.ReactNode}> = ({db, rowId, children}) => (
  <ContextMenu>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent className="w-48">
      <ContextMenuItem onSelect={() => db.openRow(rowId)}>
        <PanelRightOpen className="mr-2 h-3.5 w-3.5" /> Open
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void db.addRowAfter(rowId)}>
        <Plus className="mr-2 h-3.5 w-3.5" /> Insert below
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void db.duplicateRow(rowId)}>
        <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void db.deleteRow(rowId)} className="text-destructive focus:text-destructive">
        <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
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

// Full class strings (not interpolated) so Tailwind keeps them at build time.
const GALLERY_GRID = {
  small: 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]',
  medium: 'grid-cols-[repeat(auto-fill,minmax(210px,1fr))]',
  large: 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]',
} as const;
const GALLERY_COVER = {small: 'h-20', medium: 'h-28', large: 'h-44'} as const;

/** Gallery: a responsive grid of cards, one per row, with optional cover images.
 *  When the view names a `groupByPropertyId`, cards split into titled sections. */
export const GalleryView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const size = view.cardSize ?? 'medium';
  const schema = db.database?.schema.properties ?? properties;
  const groupProp = view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;

  const card = (row: DatabaseRow): React.ReactNode => {
    const cover = view.coverPropertyId ? firstImageUrl(row.properties[view.coverPropertyId]) : null;
    const accent = rowColor(row, view, schema, db.rows);
    return (
      <RowContextMenu key={row.id} db={db} rowId={row.id}>
        <button
          onClick={() => db.openRow(row.id)}
          style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
          className="group flex flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/20 hover:bg-accent/30"
        >
          {cover ? (
            <img src={cover} alt="" className={cn('w-full object-cover', GALLERY_COVER[size])} />
          ) : (
            <div className="flex h-16 items-center justify-center bg-muted/40 text-3xl">{readPageIcon(row.id)}</div>
          )}
          <div className="flex flex-col gap-2 px-3 pb-3">
            <div className="truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</div>
            <RowChips row={row} properties={properties} rows={db.rows} />
          </div>
        </button>
      </RowContextMenu>
    );
  };
  const grid = (rows: DatabaseRow[]): React.ReactNode => <div className={cn('grid gap-3', GALLERY_GRID[size])}>{rows.map(card)}</div>;

  if (groupProp) {
    const all = groupRows(db.visibleRows, groupProp, schema);
    const groups = view.hideEmptyGroups ? all.filter((g) => g.rows.length > 0) : all;
    return (
      <div className="space-y-5">
        {groups.map((group) => (
          <section key={group.key} data-group={group.key}>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              {group.color && <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />}
              <span>{group.label}</span>
              <span className="text-muted-foreground/60">{group.rows.length}</span>
            </div>
            {grid(group.rows)}
          </section>
        ))}
        <NewRowButton onClick={() => void db.addRow()} label="New card" className="mt-3" />
      </div>
    );
  }

  return (
    <div>
      {grid(db.visibleRows)}
      {db.visibleRows.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
        No rows{db.rows.length > 0 ? ' match the current filters' : ' yet'}.
        </div>
      )}
      <NewRowButton onClick={() => void db.addRow()} label="New card" className="mt-3" />
    </div>
  );
};

const fieldClass = 'w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-hidden';
const BOARD_CALCS: {value: SummaryType; label: string}[] = [
  {value: 'count_all', label: 'Count'},
  {value: 'count_values', label: 'Count values'},
  {value: 'count_unique', label: 'Count unique'},
  {value: 'sum', label: 'Sum'},
  {value: 'avg', label: 'Average'},
  {value: 'min', label: 'Min'},
  {value: 'max', label: 'Max'},
  {value: 'range', label: 'Range'},
  {value: 'median', label: 'Median'},
];

/** A board column's footer calculation: shows the value, click to pick property + calc
 *  (shared by every column via the view's `boardSummary`). */
const BoardColumnFooter: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]; rows: DatabaseRow[]}> = ({db, view, properties, rows}) => {
  const numeric = properties.find((p) => p.type === 'number' || p.type === 'rollup' || p.type === 'formula' || p.type === 'expr');
  const summary = view.boardSummary ?? (numeric ? {propertyId: numeric.id, type: 'sum' as SummaryType} : {propertyId: TITLE_PROPERTY_ID, type: 'count_all' as SummaryType});
  const prop = summary.propertyId === TITLE_PROPERTY_ID ? TITLE_PROPERTY_ID : properties.find((p) => p.id === summary.propertyId);
  if (!prop) return null;
  const value = summarizeColumn(rows, prop, summary.type, properties);
  const calc = BOARD_CALCS.find((c) => c.value === summary.type)?.label ?? summary.type;
  const label = summary.propertyId === TITLE_PROPERTY_ID ? 'Count' : `${calc} · ${(prop as DatabaseProperty).name}`;
  const update = (patch: Partial<typeof summary>): void => void db.updateView(view.id, {boardSummary: {...summary, ...patch}});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex w-full items-center justify-between gap-1 border-t border-border/50 px-1 pt-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground">
          <span className="truncate">{label}</span>
          <span className="font-medium tabular-nums text-foreground/70">{value || '—'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 space-y-2 p-2.5">
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Property</span>
          <select value={summary.propertyId} onChange={(e) => update({propertyId: e.target.value})} className={cn(fieldClass, 'mt-1')}>
            <option value={TITLE_PROPERTY_ID}>Rows (count)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Calculate</span>
          <select value={summary.type} onChange={(e) => update({type: e.target.value as SummaryType})} className={cn(fieldClass, 'mt-1')}>
            {BOARD_CALCS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </PopoverContent>
    </Popover>
  );
};

/**
 * Board (kanban): columns from the view's group-by property. Cards drag between
 * columns to change their group value (when grouping on a `select`). A per-column
 * "+ New" creates a row already set to that column.
 */
export const BoardView: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  /** The view's visible property set, shown as card chips (defaults to all). */
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, cardProperties}) => {
  const groupProp = properties.find((p) => p.id === view.groupByPropertyId);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  const toggleCol = (key: string): void =>
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allGroups = groupRows(db.visibleRows, groupProp, properties);
  const groups = view.hideEmptyGroups ? allGroups.filter((g) => g.rows.length > 0) : allGroups;
  const canMove = groupProp?.type === 'select' || groupProp?.type === 'status';
  // Columns backed by a real option (not the trailing "No value") can be reordered.
  const isOption = (key: string): boolean => canMove && key !== '__none__' && key !== '__all__';
  // Properties shown on a card exclude the grouping one (it's the column itself).
  const cardProps = (cardProperties ?? properties).filter((p) => p.id !== groupProp?.id);

  const drop = (key: string): void => {
    if (!dragRow || !groupProp || !canMove) return;
    const value = key === '__none__' ? null : key;
    void db.setRowProperty(dragRow, groupProp.id, value);
    setDragRow(null);
    setOverKey(null);
  };

  // Drop a column header on another → reorder the group property's options.
  const reorderColumn = (fromKey: string, toKey: string): void => {
    if (!groupProp || !canMove) return;
    const opts = [...(groupProp.options ?? [])];
    const from = opts.findIndex((o) => o.id === fromKey);
    const to = opts.findIndex((o) => o.id === toKey);
    if (from >= 0 && to >= 0 && from !== to) {
      const [moved] = opts.splice(from, 1);
      opts.splice(to, 0, moved);
      void db.updateProperty(groupProp.id, {options: opts});
    }
    setDragCol(null);
    setOverKey(null);
  };

  const newInColumn = (key: string): void => {
    const initial = canMove && key !== '__none__' && key !== '__all__' ? {[groupProp!.id]: key} : undefined;
    void db.addRow(initial);
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groups.map((group) => {
        const isCollapsed = collapsedCols.has(group.key);
        return (
          <div
            key={group.key}
            onDragOver={(e) => {
              if ((dragRow && canMove) || (dragCol && isOption(group.key))) {
                e.preventDefault();
                setOverKey(group.key);
              }
            }}
            onDrop={() => (dragCol ? reorderColumn(dragCol, group.key) : drop(group.key))}
            className={cn(
              'flex shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2 transition-colors',
              isCollapsed ? 'w-11 items-center' : 'w-64',
              overKey === group.key && 'bg-accent/50 ring-1 ring-brand/40',
            )}
          >
            {isCollapsed ? (
              <button
                data-col-key={group.key}
                onClick={() => toggleCol(group.key)}
                aria-label={`Expand ${group.label} column`}
                className="flex flex-1 flex-col items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                {group.color && (
                  <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
                )}
                <span className="text-muted-foreground/60">{group.rows.length}</span>
                <span className="truncate [writing-mode:vertical-rl]">{group.label}</span>
              </button>
            ) : (
              <>
                <div
                  data-col-key={group.key}
                  draggable={isOption(group.key)}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setDragCol(group.key);
                  }}
                  onDragEnd={() => {
                    setDragCol(null);
                    setOverKey(null);
                  }}
                  className={cn(
                    'flex items-center gap-1.5 px-1 text-xs font-medium',
                    isOption(group.key) && 'cursor-grab active:cursor-grabbing',
                  )}
                >
                  {group.color && (
                    <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
                  )}
                  <span className="truncate">{group.label}</span>
                  <span className="text-muted-foreground/60">{group.rows.length}</span>
                  <button
                    onClick={() => toggleCol(group.key)}
                    aria-label={`Collapse ${group.label} column`}
                    className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {group.rows.map((row) => {
                    const accent = rowColor(row, view, properties, db.rows);
                    return (
                      <RowContextMenu key={row.id} db={db} rowId={row.id}>
                        <div
                          draggable={canMove}
                          onDragStart={() => setDragRow(row.id)}
                          onDragEnd={() => setDragRow(null)}
                          onClick={() => db.openRow(row.id)}
                          style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
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
                          <RowChips row={row} properties={cardProps} rows={db.rows} />
                        </div>
                      </RowContextMenu>
                    );
                  })}
                </div>
                {group.rows.length > 0 && <BoardColumnFooter db={db} view={view} properties={properties} rows={group.rows} />}
                <NewRowButton onClick={() => newInColumn(group.key)} label="New" className="px-1 py-1" />
              </>
            )}
          </div>
        );
      })}
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
export const CalendarView: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  /** Properties to show as chips under each tile's title (the date drives placement). */
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, cardProperties}) => {
  const dateProp = properties.find((p) => p.id === view.datePropertyId);
  const tileProps = (cardProperties ?? []).filter((p) => p.id !== view.datePropertyId);
  const today = new Date();
  const [cursor, setCursor] = useState({year: today.getFullYear(), month: today.getMonth()});
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  // Only manual `date` properties are reschedulable (timestamps are derived).
  const editable = dateProp?.type === 'date';

  /** Drop a row on a day: set its date (shifting a range's end by the same delta). */
  const reschedule = (rowId: string, key: string): void => {
    if (!dateProp || !editable) return;
    const row = db.visibleRows.find((r) => r.id === rowId);
    if (!row) return;
    const raw = row.properties[dateProp.id];
    if (dateProp.dateRange) {
      const oldStart = parseDay(dateStart(raw));
      const oldEnd = parseDay(dateEnd(raw));
      const newStart = parseDay(key);
      if (oldStart && oldEnd && newStart) {
        const shifted = new Date(oldEnd.getTime() + (newStart.getTime() - oldStart.getTime()));
        void db.setRowProperty(rowId, dateProp.id, {start: key, end: ymd(shifted.getFullYear(), shifted.getMonth(), shifted.getDate())});
      } else {
        void db.setRowProperty(rowId, dateProp.id, {start: key, end: null});
      }
    } else {
      void db.setRowProperty(rowId, dateProp.id, key);
    }
    setDragRow(null);
    setOverKey(null);
  };

  /** Create a row dated to a clicked day (a range starts and ends that day). */
  const createOn = (key: string): void => {
    if (!dateProp || !editable) return;
    void db.addRow({[dateProp.id]: dateProp.dateRange ? {start: key, end: null} : key});
  };

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
              data-day-key={key ?? undefined}
              onDragOver={(e) => {
                if (key && editable && dragRow) {
                  e.preventDefault();
                  setOverKey(key);
                }
              }}
              onDrop={() => key && reschedule(dragRow!, key)}
              className={cn(
                'group/day min-h-[88px] border-b border-r border-border/60 p-1 last:border-r-0 [&:nth-child(7n)]:border-r-0',
                !day && 'bg-muted/10',
                overKey === key && key && 'bg-accent/50 ring-1 ring-inset ring-brand/40',
              )}
            >
              {day && (
                <div className="mb-1 flex items-center justify-between">
                  {editable ? (
                    <button
                      onClick={() => createOn(key!)}
                      aria-label={`Add on ${key}`}
                      className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-accent hover:text-foreground group-hover/day:opacity-100"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  ) : (
                    <span />
                  )}
                  <span className={cn('text-xs', key === todayKey ? 'font-semibold text-brand' : 'text-muted-foreground/70')}>{day}</span>
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {rows.map((row) => {
                  const accent = rowColor(row, view, properties, db.rows);
                  return (
                    <RowContextMenu key={row.id} db={db} rowId={row.id}>
                      <button
                        draggable={editable}
                        onDragStart={() => setDragRow(row.id)}
                        onDragEnd={() => setDragRow(null)}
                        onClick={() => db.openRow(row.id)}
                        style={accent ? {backgroundColor: `${accent}24`, borderLeft: `3px solid ${accent}`} : undefined}
                        className={cn(
                          'flex flex-col gap-0.5 rounded bg-brand/10 px-1 py-0.5 text-left text-[11px] text-foreground/80 transition-colors hover:bg-brand/20',
                          editable && 'cursor-grab active:cursor-grabbing',
                          dragRow === row.id && 'opacity-40',
                        )}
                        title={row.name ?? 'Untitled'}
                      >
                        <span className="flex items-center gap-1 truncate">
                          <span className="shrink-0 leading-none">{readPageIcon(row.id)}</span>
                          <span className="truncate">{row.name?.trim() || 'Untitled'}</span>
                        </span>
                        {tileProps.length > 0 && <RowChips row={row} properties={tileProps} rows={db.rows} />}
                      </button>
                    </RowContextMenu>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
