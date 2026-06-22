import React, {useState} from 'react';
import {Select} from '@/components/ui/select';
import {ChevronLeft, ChevronRight, Copy, GripVertical, PanelRightOpen, Plus, Trash2} from 'lucide-react';
import {
  dateEnd,
  dateStart,
  coverImageUrl,
  groupRowsBy,
  ICON_PROPERTY_ID,
  PARENT_GROUP_ID,
  parseDay,
  rowMatchesCondition,
  summarizeColumn,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type RowGroup,
  type SummaryType,
} from '@book.dev/sdk';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {cn} from '@/lib/utils';
import {hydratePageIcons, readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {pageLinks, subscribePageLinks} from '@/lib/pageLinks';
import {useData} from '@/data';
import {useNavigation} from '@/providers';
import type {UseDatabase} from './useDatabase';
import {cellValue, formatCellValue, SelectChip} from './databaseCells';
import {SWATCH_HEX} from './databaseColors';
import {RowHoverCard} from './DatabaseCard';

// ── Group headings ───────────────────────────────────────────────────────────
// A group's key is a page id when grouping by **parent item** or by a **relation**
// (otherwise it's a select-option id or a plain value). For those the header shows
// the linked page's emoji + title, resolved live through the icon cache and the
// page-link bridge (see {@link useRelationGroupTitles}), like a sub-page mention.

const GROUP_SENTINELS = new Set(['__none__', '__all__']);

/** True when a group's key identifies a page (parent-item or relation grouping). */
const isPageGroup = (group: RowGroup, prop: DatabaseProperty | undefined, groupByParent: boolean): boolean =>
  !GROUP_SENTINELS.has(group.key) && (groupByParent || prop?.type === 'relation');

/** The emoji to render beside a group's label, or `null` (non-page groups). */
export const groupGlyph = (group: RowGroup, prop: DatabaseProperty | undefined, groupByParent: boolean): string | null =>
  isPageGroup(group, prop, groupByParent) ? readPageIcon(group.key) : null;

/** A group's display label — the linked page's title for relation groups (whose
 *  SDK label is the raw page id), otherwise the group's own label (parent-item
 *  groups already carry the row name). */
export const groupHeading = (group: RowGroup, prop: DatabaseProperty | undefined): string =>
  prop?.type === 'relation' && !GROUP_SENTINELS.has(group.key) ? pageLinks.label(group.key) : group.label;

/**
 * Whether a group reads as collapsed. Empty groups fold by default (the view's
 * `collapseEmptyGroups`, on unless set false); the `collapsed` Set stores
 * *deviations* from that default, so a user can still fold a populated group or
 * unfold an empty one with the same toggle.
 */
export const groupCollapsed = (group: RowGroup, collapsed: Set<string>, collapseEmpty: boolean): boolean =>
  collapsed.has(group.key) !== (collapseEmpty && group.rows.length === 0);

/** The collapsed-Set membership that makes every group display as `collapse`
 *  (used by the board/table "Collapse all" / "Expand all" toggles). */
export const setAllGroupsCollapsed = (groups: RowGroup[], collapse: boolean, collapseEmpty: boolean): Set<string> =>
  new Set(groups.filter((g) => collapse !== (collapseEmpty && g.rows.length === 0)).map((g) => g.key));

/**
 * Register the titles + icons of relation group properties' target rows so the
 * group headers resolve to page titles/icons (mirrors the relation cell). A no-op
 * unless a passed property is a relation with a target database; safe to pass the
 * primary and sub-group properties together.
 */
export function useRelationGroupTitles(...props: Array<DatabaseProperty | undefined>): void {
  const client = useData();
  const {setPageHint} = useNavigation();
  const [, bump] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const offLinks = subscribePageLinks(bump);
    const offIcon = subscribePageIcon(bump);
    return () => {
      offLinks();
      offIcon();
    };
  }, []);
  // A stable key for the set of target databases, so the load runs once per change.
  const targets = props
    .filter((p): p is DatabaseProperty => p?.type === 'relation' && !!p.relationDatabaseId)
    .map((p) => p.relationDatabaseId!)
    .join(',');
  React.useEffect(() => {
    if (!targets) return;
    let alive = true;
    for (const dbId of targets.split(',')) {
      void client
        .listRows(dbId)
        .then((rows) => {
          if (!alive) return;
          rows.forEach((r) => setPageHint(r.id, r.name?.trim() || 'Untitled'));
          hydratePageIcons(rows.map((r) => ({id: r.id, icon: (r.properties[ICON_PROPERTY_ID] as string | undefined) ?? null})));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [targets, client, setPageHint]);
}

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
      if (property.type === 'relation' || property.type === 'dependency') {
        const ids = Array.isArray(value) ? (value as string[]) : [];
        if (ids.length === 0) return null;
        return (
          <span key={property.id} className="flex flex-wrap items-center gap-1">
            {ids.map((id) => (
              <RowHoverCard key={id} rowId={id}>
                <span className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {pageLinks.label(id)}
                </span>
              </RowHoverCard>
            ))}
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


/** A gallery card's cover: tries the URL and falls back to the page-icon strip
 *  when it isn't a loadable image (extension-less URLs are attempted on faith). */
const CardCover: React.FC<{src: string | null; heightClass: string; icon: string}> = ({src, heightClass, icon}) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="flex h-16 items-center justify-center bg-muted/40 text-3xl">
        <PageIcon value={icon} />
      </div>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} className={cn('w-full object-cover', heightClass)} />;
};

/** Gallery: a responsive grid of cards, one per row, with optional cover images.
 *  When the view names a `groupByPropertyId`, cards split into titled sections. */
export const GalleryView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const size = view.cardSize ?? 'medium';
  const schema = db.database?.schema.properties ?? properties;
  const groupByParent = view.groupByPropertyId === PARENT_GROUP_ID;
  const groupProp = !groupByParent && view.groupByPropertyId ? schema.find((p) => p.id === view.groupByPropertyId) : undefined;
  // Grouped sections already announce the group value in their header — repeating
  // it as a chip on every card underneath is noise (the board does the same).
  const cardProps = properties.filter((p) => p.id !== groupProp?.id);
  const collapseEmpty = view.collapseEmptyGroups ?? true;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  useRelationGroupTitles(groupProp);

  const card = (row: DatabaseRow): React.ReactNode => {
    const cover = view.coverPropertyId ? coverImageUrl(row.properties[view.coverPropertyId]) : null;
    const accent = rowColor(row, view, schema, db.rows);
    return (
      <RowContextMenu key={row.id} db={db} rowId={row.id}>
        <button
          onClick={() => db.openRow(row.id)}
          style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
          className="group flex flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card text-left transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:shadow-lift"
        >
          <CardCover src={cover} heightClass={GALLERY_COVER[size]} icon={readPageIcon(row.id)} />
          <div className="flex flex-col gap-2 px-3 pb-3">
            <div className="truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</div>
            <RowChips row={row} properties={cardProps} rows={db.rows} />
          </div>
        </button>
      </RowContextMenu>
    );
  };
  const grid = (rows: DatabaseRow[]): React.ReactNode => <div className={cn('grid gap-3', GALLERY_GRID[size])}>{rows.map(card)}</div>;

  if (groupProp || groupByParent) {
    const groups = groupRowsBy(db.visibleRows, view.groupByPropertyId, schema);
    return (
      <div className="space-y-5">
        {groups.map((group) => {
          const isCollapsed = groupCollapsed(group, collapsed, collapseEmpty);
          const glyph = groupGlyph(group, groupProp, groupByParent);
          return (
            <section key={group.key} data-group={group.key}>
              <button onClick={() => toggle(group.key)} className="mb-2 flex w-full items-center gap-1.5 text-sm font-medium">
                <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform', !isCollapsed && 'rotate-90')} />
                {group.color && <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />}
                {glyph && <span className="text-base leading-none">{glyph}</span>}
                <span className="truncate">{groupHeading(group, groupProp)}</span>
                <span className="text-muted-foreground/60">{group.rows.length}</span>
              </button>
              {!isCollapsed && grid(group.rows)}
            </section>
          );
        })}
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
          <Select unstyled aria-label="Summary property" value={summary.propertyId} onChange={(e) => update({propertyId: e.target.value})} className={cn(fieldClass, 'mt-1')}>
            <option value={TITLE_PROPERTY_ID}>Rows (count)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Calculate</span>
          <Select unstyled aria-label="Summary calculation" value={summary.type} onChange={(e) => update({type: e.target.value as SummaryType})} className={cn(fieldClass, 'mt-1')}>
            {BOARD_CALCS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
      </PopoverContent>
    </Popover>
  );
};

/** A board card move: drop a card into a (column, lane) cell. `subKey` is null
 *  when the board has no sub-grouping (a flat single-lane board). */
interface BoardDropTarget {
  colKey: string;
  subKey: string | null;
}

/** Mutable drag/hover state shared by every board column (flat or swimlaned). */
interface BoardDnd {
  dragRow: string | null;
  setDragRow: (id: string | null) => void;
  dragCol: string | null;
  setDragCol: (key: string | null) => void;
  /** The hovered drop cell, encoded "<colKey>::<subKey>" so lanes don't collide. */
  overKey: string | null;
  setOverKey: (key: string | null) => void;
}

const cellKey = (colKey: string, subKey: string | null): string => `${colKey}::${subKey ?? ''}`;

/**
 * One board column's cards (within a lane when sub-grouped): the draggable cards
 * plus the footer and "New" affordance. Extracted so swimlanes can reuse a column
 * per (column, lane) cell. Card DnD into this cell writes the column's group value
 * — and, when laned, the lane's sub-group value too — in a single transaction.
 */
const BoardColumnCards: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  cardProps: DatabaseProperty[];
  rows: DatabaseRow[];
  canMove: boolean;
  dnd: BoardDnd;
  newInCell: () => void;
}> = ({db, view, properties, cardProps, rows, canMove, dnd, newInCell}) => (
  <>
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const accent = rowColor(row, view, properties, db.rows);
        return (
          <RowContextMenu key={row.id} db={db} rowId={row.id}>
            <div
              draggable={canMove}
              onDragStart={() => dnd.setDragRow(row.id)}
              onDragEnd={() => dnd.setDragRow(null)}
              onClick={() => db.openRow(row.id)}
              style={accent ? {borderLeftColor: accent, borderLeftWidth: 3} : undefined}
              className={cn(
                'group cursor-pointer overflow-hidden rounded-md border border-border bg-card p-2.5 text-left shadow-sm transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-lift',
                dnd.dragRow === row.id && 'opacity-50',
              )}
            >
              {/* Board cards honour the view's cover like gallery cards. */}
              {view.coverPropertyId && coverImageUrl(row.properties[view.coverPropertyId]) && (
                <div className="-mx-2.5 -mt-2.5 mb-2">
                  <CardCover src={coverImageUrl(row.properties[view.coverPropertyId])} heightClass="h-20" icon={readPageIcon(row.id)} />
                </div>
              )}
              <div className="mb-1 flex items-center gap-1.5">
                <PageIcon value={readPageIcon(row.id)} className="shrink-0 text-sm leading-none" />
                <span className="truncate text-sm font-medium">{row.name?.trim() || 'Untitled'}</span>
                <PanelRightOpen className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition group-hover:text-muted-foreground/60" />
              </div>
              <RowChips row={row} properties={cardProps} rows={db.rows} />
            </div>
          </RowContextMenu>
        );
      })}
    </div>
    {rows.length > 0 && <BoardColumnFooter db={db} view={view} properties={properties} rows={rows} />}
    <NewRowButton onClick={newInCell} label="New" className="px-1 py-1" />
  </>
);

/**
 * Board (kanban): columns from the view's group-by property. Cards drag between
 * columns to change their group value (when grouping on a `select`). A per-column
 * "+ New" creates a row already set to that column. When the view also names a
 * `subGroupByPropertyId`, the board splits into horizontal **swimlanes** (one per
 * sub-group value, spanning all columns — the Notion model); dropping a card into
 * a (column, lane) cell sets both the column and the lane property in one
 * transaction. Lanes are collapsible and their collapsed state persists.
 */
export const BoardView: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  /** The view's visible property set, shown as card chips (defaults to all). */
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, cardProperties}) => {
  const groupByParent = view.groupByPropertyId === PARENT_GROUP_ID;
  const groupProp = groupByParent ? undefined : properties.find((p) => p.id === view.groupByPropertyId);
  // The sub-group (swimlane) dimension. Parent-item sub-grouping isn't a settable
  // property write, so DnD is limited to it but lanes still render.
  const subByParent = view.subGroupByPropertyId === PARENT_GROUP_ID;
  const subProp = subByParent ? undefined : properties.find((p) => p.id === view.subGroupByPropertyId);
  const swimlaned = !!view.subGroupByPropertyId && (!!subProp || subByParent);

  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // Swimlane (sub-group) reorder, mirroring the column dragCol/overKey pair.
  const [dragLane, setDragLane] = useState<string | null>(null);
  const [overLane, setOverLane] = useState<string | null>(null);
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set());
  // Collapsed lanes persist per view (a board with many swimlanes is unwieldy
  // until folded — remember the fold across reloads), mirroring activeViewKey.
  const [collapsedLanes, setCollapsedLanes] = usePersistedSet(`ob.board.lanes.${view.id}`);
  const dnd: BoardDnd = {dragRow, setDragRow, dragCol, setDragCol, overKey, setOverKey};

  const toggleCol = (key: string): void =>
    setCollapsedCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const collapseEmpty = view.collapseEmptyGroups ?? true;
  useRelationGroupTitles(groupProp, subProp);
  const groups = groupRowsBy(db.visibleRows, view.groupByPropertyId, properties);
  // Select/status columns reorder by dragging their header (write the option order);
  // relation columns write the linked page on drop but have no stored order.
  const colReorderable = groupProp?.type === 'select' || groupProp?.type === 'status';
  const colRelation = groupProp?.type === 'relation';
  const canMoveCol = colReorderable || groupByParent || colRelation;
  // Multi-value relations aren't offered as a sub-group, so a lane write is always
  // a single link; select/status lanes write the option id.
  const laneReorderable = subProp?.type === 'select' || subProp?.type === 'status';
  const laneRelationSingle = subProp?.type === 'relation' && !!subProp?.relationSingle;
  // Cards drag at all when the primary group is movable, OR when only the lane is
  // (so a card can change lane within an unmovable column).
  const canMoveLane = laneReorderable || laneRelationSingle;
  const canMove = canMoveCol || canMoveLane;
  // Columns backed by a reorderable option (not "No value") can be reordered;
  // parent-item and relation columns follow their own order and aren't.
  const isOption = (key: string): boolean => colReorderable && key !== '__none__' && key !== '__all__';
  // Properties shown on a card exclude the grouping ones (they're the cell itself).
  const cardProps = (cardProperties ?? properties).filter((p) => p.id !== groupProp?.id && p.id !== subProp?.id);

  // Lanes: one per sub-group value (spanning every column).
  const lanes = swimlaned ? groupRowsBy(db.visibleRows, view.subGroupByPropertyId, properties) : [];

  /** Persist a card's move into a (column, lane) cell — both writes in one txn. */
  const drop = (target: BoardDropTarget): void => {
    if (dragRow && canMove) {
      const patch: Record<string, unknown> = {};
      if (groupByParent) {
        // Parent-item columns aren't a property write — re-parent instead. (A
        // lane sub-group, if any, can still be written alongside.)
        void db.setRowParent(dragRow, target.colKey === '__none__' ? null : target.colKey);
      } else if (groupProp && colReorderable) {
        patch[groupProp.id] = target.colKey === '__none__' ? null : target.colKey;
      } else if (groupProp && colRelation) {
        // Dropping on a relation column replaces the link with that page.
        patch[groupProp.id] = target.colKey === '__none__' ? null : [target.colKey];
      }
      if (subProp && laneReorderable && target.subKey !== null) {
        patch[subProp.id] = target.subKey === '__none__' ? null : target.subKey;
      } else if (subProp && laneRelationSingle && target.subKey !== null) {
        patch[subProp.id] = target.subKey === '__none__' ? null : [target.subKey];
      }
      if (Object.keys(patch).length > 0) void db.setRowProperties(dragRow, patch);
    }
    setDragRow(null);
    setOverKey(null);
  };

  // Drop a column header on another → reorder the group property's options.
  const reorderColumn = (fromKey: string, toKey: string): void => {
    if (!groupProp || !colReorderable) return;
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

  // A swimlane backed by a reorderable sub-group option (not "No value") can be reordered.
  const isLaneOption = (key: string): boolean => laneReorderable && key !== '__none__' && key !== '__all__';

  // Drop a lane (swimlane) gutter on another → reorder the sub-group's options.
  const reorderLane = (fromKey: string, toKey: string): void => {
    if (!subProp || !laneReorderable) return;
    const opts = [...(subProp.options ?? [])];
    const from = opts.findIndex((o) => o.id === fromKey);
    const to = opts.findIndex((o) => o.id === toKey);
    if (from >= 0 && to >= 0 && from !== to) {
      const [moved] = opts.splice(from, 1);
      opts.splice(to, 0, moved);
      void db.updateProperty(subProp.id, {options: opts});
    }
    setDragLane(null);
    setOverLane(null);
  };

  /** Create a row seeded to a (column, lane) cell. */
  const newInCell = (colKey: string, subKey: string | null): void => {
    if (groupByParent) {
      // A new card in a parent's column is a sub-item of that row.
      void (colKey === '__none__' ? db.addRow() : db.addSubItem(colKey));
      return;
    }
    const initial: Record<string, unknown> = {};
    if (groupProp && colReorderable && colKey !== '__none__' && colKey !== '__all__') initial[groupProp.id] = colKey;
    else if (groupProp && colRelation && colKey !== '__none__' && colKey !== '__all__') initial[groupProp.id] = [colKey];
    if (subProp && laneReorderable && subKey && subKey !== '__none__') initial[subProp.id] = subKey;
    else if (subProp && laneRelationSingle && subKey && subKey !== '__none__') initial[subProp.id] = [subKey];
    void db.addRow(Object.keys(initial).length ? initial : undefined);
  };

  const allCollapsed = groups.length > 0 && groups.every((g) => groupCollapsed(g, collapsedCols, collapseEmpty));

  /** The shared column-header strip (used once for flat, once atop swimlanes). */
  const ColumnHeaders: React.FC = () => (
    <div className="flex gap-3">
      {groups.map((group) => {
        const isCollapsed = groupCollapsed(group, collapsedCols, collapseEmpty);
        const glyph = groupGlyph(group, groupProp, groupByParent);
        const heading = groupHeading(group, groupProp);
        return (
          <div
            key={group.key}
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
            onDragOver={(e) => {
              if (dragCol && isOption(group.key)) {
                e.preventDefault();
                setOverKey(cellKey(group.key, null));
              }
            }}
            onDrop={() => dragCol && reorderColumn(dragCol, group.key)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md bg-muted/30 px-2 py-1.5 text-xs font-medium',
              isCollapsed ? 'w-11 justify-center' : 'w-64',
              isOption(group.key) && 'cursor-grab active:cursor-grabbing',
              overKey === cellKey(group.key, null) && 'ring-1 ring-brand/40',
            )}
          >
            {group.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />}
            {glyph && <span className="shrink-0 text-sm leading-none">{glyph}</span>}
            {!isCollapsed && <span className="truncate">{heading}</span>}
            <span className="text-muted-foreground/60">{group.rows.length}</span>
            <button
              onClick={() => toggleCol(group.key)}
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${heading} column`}
              className={cn('shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-hover hover:text-foreground', !isCollapsed && 'ml-auto')}
            >
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
            </button>
          </div>
        );
      })}
    </div>
  );

  /** One (column, lane) cell's drop zone wrapping the cards. */
  const Cell: React.FC<{group: RowGroup; rows: DatabaseRow[]; subKey: string | null}> = ({group, rows, subKey}) => {
    const isCollapsed = groupCollapsed(group, collapsedCols, collapseEmpty);
    const key = cellKey(group.key, subKey);
    if (isCollapsed) return <div className="w-11 shrink-0" />;
    return (
      <div
        onDragOver={(e) => {
          if (dragRow && canMove) {
            e.preventDefault();
            setOverKey(key);
          }
        }}
        onDrop={() => !dragCol && drop({colKey: group.key, subKey})}
        className={cn(
          'flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2 transition-colors',
          overKey === key && 'bg-accent/50 ring-1 ring-brand/40',
        )}
      >
        <BoardColumnCards
          db={db}
          view={view}
          properties={properties}
          cardProps={cardProps}
          rows={rows}
          canMove={canMove}
          dnd={dnd}
          newInCell={() => newInCell(group.key, subKey)}
        />
      </div>
    );
  };

  // ── Swimlaned board: a column-header strip, then one lane per sub-group. Each
  // lane is a full-width horizontal BAR (demarcating the swimlane) ABOVE its row
  // of column cells — the lane label is a header, not a left gutter column. ─────
  if (swimlaned) {
    const toggleLane = (laneKey: string): void =>
      setCollapsedLanes((prev) => {
        const next = new Set(prev);
        if (next.has(laneKey)) next.delete(laneKey);
        else next.add(laneKey);
        return next;
      });
    return (
      <div className="overflow-x-auto pb-2">
        <div className="w-max space-y-3">
          <ColumnHeaders />
          {lanes.map((lane) => {
            const laneCollapsed = groupCollapsed(lane, collapsedLanes, collapseEmpty);
            const laneGlyph = groupGlyph(lane, subProp, subByParent);
            const laneHeading = groupHeading(lane, subProp);
            const byCol = new Map(groups.map((g) => [g.key, new Set(g.rows.map((r) => r.id))]));
            return (
              <div key={lane.key} className="space-y-2">
                {/* Full-width horizontal lane bar above the cards: a drag gutter,
                    chevron, dot, label, count. Spans every column so it reads as a
                    swimlane; drag the gutter to reorder the sub-group's options. */}
                <div
                  data-lane-key={lane.key}
                  onDragOver={(e) => {
                    if (dragLane && isLaneOption(lane.key)) {
                      e.preventDefault();
                      setOverLane(lane.key);
                    }
                  }}
                  onDrop={() => dragLane && reorderLane(dragLane, lane.key)}
                  className={cn(
                    'flex w-full items-center rounded-md border-b border-border/70 bg-muted/40 text-xs font-medium transition-colors',
                    dragLane === lane.key && 'opacity-40',
                    overLane === lane.key && 'ring-1 ring-brand/40',
                  )}
                >
                  {isLaneOption(lane.key) && (
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragLane(lane.key);
                      }}
                      onDragEnd={() => {
                        setDragLane(null);
                        setOverLane(null);
                      }}
                      aria-label={`Reorder ${laneHeading} lane`}
                      className="flex cursor-grab items-center self-stretch rounded-l-md px-1 text-muted-foreground/30 transition-colors hover:bg-hover hover:text-muted-foreground active:cursor-grabbing"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <button
                    onClick={() => toggleLane(lane.key)}
                    aria-label={`${laneCollapsed ? 'Expand' : 'Collapse'} ${laneHeading} lane`}
                    className={cn(
                      'flex flex-1 items-center gap-1.5 py-1.5 pr-2.5 text-left transition-colors hover:bg-hover',
                      isLaneOption(lane.key) ? 'rounded-r-md' : 'rounded-md pl-2.5',
                    )}
                  >
                    <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform', !laneCollapsed && 'rotate-90')} />
                    {lane.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[lane.color] ?? '#9ca3af'}} />}
                    {laneGlyph && <span className="shrink-0 text-sm leading-none">{laneGlyph}</span>}
                    <span className="truncate text-foreground/80">{laneHeading}</span>
                    <span className="text-muted-foreground/60">{lane.rows.length}</span>
                  </button>
                </div>
                {!laneCollapsed && (
                  <div className="flex gap-3">
                    {groups.map((group) => {
                      const rows = lane.rows.filter((r) => byCol.get(group.key)?.has(r.id));
                      return <Cell key={group.key} group={group} rows={rows} subKey={lane.key} />;
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Flat board (single lane): the original layout. ──────────────────────────
  return (
    <div>
      {groups.length > 1 && (
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setCollapsedCols(setAllGroupsCollapsed(groups, !allCollapsed, collapseEmpty))}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !allCollapsed && 'rotate-90')} />
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      )}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {groups.map((group) => {
          const isCollapsed = groupCollapsed(group, collapsedCols, collapseEmpty);
          const glyph = groupGlyph(group, groupProp, groupByParent);
          const heading = groupHeading(group, groupProp);
          return (
            <div
              key={group.key}
              onDragOver={(e) => {
                if ((dragRow && canMove) || (dragCol && isOption(group.key))) {
                  e.preventDefault();
                  setOverKey(cellKey(group.key, null));
                }
              }}
              onDrop={() => (dragCol ? reorderColumn(dragCol, group.key) : drop({colKey: group.key, subKey: null}))}
              className={cn(
                'flex shrink-0 flex-col gap-2 rounded-lg bg-muted/30 p-2 transition-colors',
                isCollapsed ? 'w-11 items-center' : 'w-64',
                overKey === cellKey(group.key, null) && 'bg-accent/50 ring-1 ring-brand/40',
              )}
            >
              {isCollapsed ? (
                <button
                  data-col-key={group.key}
                  onClick={() => toggleCol(group.key)}
                  aria-label={`Expand ${heading} column`}
                  className="flex flex-1 flex-col items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  {group.color && (
                    <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: SWATCH_HEX[group.color] ?? '#9ca3af'}} />
                  )}
                  {glyph && <span className="text-sm leading-none">{glyph}</span>}
                  <span className="text-muted-foreground/60">{group.rows.length}</span>
                  <span className="truncate [writing-mode:vertical-rl]">{heading}</span>
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
                    {glyph && <span className="shrink-0 text-sm leading-none">{glyph}</span>}
                    <span className="truncate">{heading}</span>
                    <span className="text-muted-foreground/60">{group.rows.length}</span>
                    <button
                      onClick={() => toggleCol(group.key)}
                      aria-label={`Collapse ${heading} column`}
                      className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-hover hover:text-foreground"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <BoardColumnCards
                    db={db}
                    view={view}
                    properties={properties}
                    cardProps={cardProps}
                    rows={group.rows}
                    canMove={canMove}
                    dnd={dnd}
                    newInCell={() => newInCell(group.key, null)}
                  />
                </>
              )}
            </div>
          );
        })}
        {/* New group: mint a select option without leaving the board (select/status only). */}
        {colReorderable && groupProp && <NewGroupColumn onAdd={(label) => void db.addSelectOption(groupProp.id, label)} />}
      </div>
    </div>
  );
};

/** A `useState`-backed Set persisted to localStorage under `key` (board lane folds). */
function usePersistedSet(key: string): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const update = (updater: (prev: Set<string>) => Set<string>): void =>
    setSet((prev) => {
      const next = updater(prev);
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* quota / private mode — fold still works in-session. */
      }
      return next;
    });
  return [set, update];
}

/** The trailing ghost column on a board: click to name a new group (select option). */
const NewGroupColumn: React.FC<{onAdd: (label: string) => void}> = ({onAdd}) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = (): void => {
    const label = draft.trim();
    if (label) onAdd(label);
    setDraft('');
    setAdding(false);
  };
  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex h-9 w-44 shrink-0 items-center gap-1 rounded-lg border border-dashed border-border/70 px-3 text-sm text-muted-foreground/70 transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground"
      >
        <Plus className="h-4 w-4" /> New group
      </button>
    );
  }
  return (
    <div className="h-9 w-44 shrink-0 rounded-lg border border-border bg-muted/30 px-2 py-1">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft('');
            setAdding(false);
          }
        }}
        onBlur={commit}
        placeholder="Group name…"
        aria-label="New group name"
        className="w-full bg-transparent py-0.5 text-sm outline-hidden placeholder:text-muted-foreground/50"
      />
    </div>
  );
};

// ── Calendar ──────────────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Normalise a cell value to a local `YYYY-MM-DD` day key, or null if undated. */
const dayKey = (value: unknown): string | null => {
  // dateStart unwraps both plain day strings and {start, end} range values —
  // ranges previously bucketed to null, leaving the calendar silently empty.
  const start = dateStart(value);
  if (!start) return null;
  // `date` properties are already `YYYY-MM-DD`; timestamps are full ISO strings.
  if (/^\d{4}-\d{2}-\d{2}/.test(start)) return start.slice(0, 10);
  const d = new Date(start);
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
          <button onClick={() => setCursor({year: today.getFullYear(), month: today.getMonth()})} className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
            Today
          </button>
          <button onClick={() => shift(-1)} className="rounded p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground" aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button onClick={() => shift(1)} className="rounded p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground" aria-label="Next month">
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
                      className="rounded p-0.5 text-muted-foreground/60 opacity-0 transition hover:bg-hover hover:text-foreground group-hover/day:opacity-100"
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
                          <PageIcon value={readPageIcon(row.id)} className="shrink-0 leading-none" />
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
