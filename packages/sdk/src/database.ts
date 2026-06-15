/**
 * Full-featured databases — the second unit of storage layered over {@link
 * StoredPage}. A **database** is a collection of pages (its *rows*) managed by
 * typed *properties* and presented through one or more configurable *views*
 * (table, board, gallery, calendar, list, or a bar/pie chart).
 *
 * Three ideas make OpenBook databases different from a plain spreadsheet:
 *
 *  1. **Rows are real pages.** Each row is an ordinary page in the `pages`
 *     table with its own editable document — so a row can itself contain text,
 *     reactive sliders, charts, even another database. Opening a row in the
 *     split pane edits that page directly.
 *
 *  2. **Columns can be reactive.** A property of type `expr` reads a *named
 *     exported cell* from the row page's reactive store (the `names`/`values`
 *     pairs in its {@link PageSnapshot}). A "Total" column can therefore show
 *     the live result of an expression block inside each row, and the table can
 *     filter and sort on it.
 *
 *  3. **Columns can compute.** A property of type `formula` evaluates a small
 *     expression over the row's *other* properties (`prop("Price") * prop("Qty")`)
 *     via the pure evaluator in {@link ./formula}. Filters/sorts/charts read the
 *     computed value just like any stored one.
 *
 * The host page (the page that *contains* the database) is itself a regular
 * page with its own content; it merely points at the database. The database
 * record — properties, views, filters — lives in its own `databases` table.
 */

import type {PageSnapshot} from './types';
import {evaluateFormula, FormulaError, type FormulaResolver} from './formula';

/**
 * The value kinds a property can hold. The manual kinds
 * (`text`/`number`/`select`/`status`/`checkbox`/`date`/`person`/`verification`)
 * store their value per row in `page.properties[id]`. `expr` projects a named
 * reactive cell from the row page's document; `formula` computes from the row's
 * *other* properties (`prop("Price") * prop("Qty")`); `rollup` folds a target
 * property across the rows a `relation`/`dependency` points to; `backlinks` is
 * computed from the link graph (never stored). The last three
 * (`person`/`verification`/`backlinks`) double as the built-in page properties —
 * see {@link ./pageProperties}.
 */
export type DatabasePropertyType =
  | 'text'
  | 'number'
  | 'rating'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'email'
  | 'phone'
  | 'location'
  | 'files'
  | 'relation'
  | 'dependency'
  | 'rollup'
  | 'created_time'
  | 'last_edited_time'
  | 'unique_id'
  | 'expr'
  | 'formula'
  | 'person'
  | 'verification'
  | 'backlinks';

/** Display formatting for `number`/`formula`/`expr` numeric values. */
export type NumberFormat = 'plain' | 'integer' | 'decimal' | 'percent' | 'dollar' | 'euro' | 'pound' | 'yen' | 'rupee';

/** How a number cell is visualised: as text, a horizontal bar, or a ring. */
export type NumberDisplay = 'number' | 'bar' | 'ring';

/** The lifecycle bucket a `status` option belongs to. */
export type StatusGroup = 'todo' | 'in_progress' | 'complete';

/** One choice in a `select` / `multi_select` / `status` property. */
export interface DatabaseSelectOption {
  id: string;
  label: string;
  /** A token from the shared swatch palette (see `SELECT_COLORS`). */
  color?: string;
  /** For `status` options: which lifecycle bucket the option sits in. */
  group?: StatusGroup;
}

/** How a {@link DatabaseProperty.rollup} folds the related rows' target values. */
export type RollupFunction =
  | 'show_original'
  | 'count'
  | 'count_values'
  | 'count_unique'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'range'
  | 'median'
  | 'checked'
  | 'percent_checked';

/** Rollup configuration: aggregate a related set's target property. */
export interface RollupConfig {
  /** A `relation` / `dependency` property on this row holding the related ids. */
  relationPropertyId: string;
  /** The property on the related rows to fold ({@link TITLE_PROPERTY_ID} for the title). */
  targetPropertyId: string;
  function: RollupFunction;
}

/**
 * A column definition. Manual types (`text`/`number`/`select`/`checkbox`/
 * `date`) store their value per row in `page.properties[id]`. The `expr` type
 * stores nothing on the row — its value is projected live from the row page's
 * exported cell named {@link cellName}.
 */
export interface DatabaseProperty {
  id: string;
  name: string;
  type: DatabasePropertyType;
  /** Choices, for `select` / `multi_select` properties. */
  options?: DatabaseSelectOption[];
  /** Name of the exported reactive cell to read, for `expr` properties. */
  cellName?: string;
  /** Expression source, for `formula` properties (references other props by name). */
  formula?: string;
  /** Numeric display format, for `number` / `formula` / `expr` properties. */
  numberFormat?: NumberFormat;
  /** How a `number` cell is visualised: plain text (default), a `bar`, or a `ring`. */
  numberDisplay?: NumberDisplay;
  /** The 100%-of-the-bar value for `bar`/`ring` display (defaults to 100). */
  numberTarget?: number;
  /** Optional prefix for a `unique_id` property, e.g. `TASK` → `TASK-1`. */
  idPrefix?: string;
  /**
   * `date` only: when true the cell holds a `{start, end}` range (a `DateRange`)
   * instead of a single `YYYY-MM-DD` string. Drives the timeline's bar length.
   */
  dateRange?: boolean;
  /** `date` only: when true the cell stores a time too (`YYYY-MM-DDTHH:mm`). */
  includeTime?: boolean;
  /** `date` only: show dates relative to today ("Today", "In 3 days") near the present,
   *  falling back to an absolute date further out. Defaults to absolute. */
  dateDisplay?: 'absolute' | 'relative';
  /** A short helper description, shown beneath the field in the page-view panel. */
  description?: string;
  /** The {@link PropertyGroup} this property belongs to (page-view organisation). */
  groupId?: string;
  /** Hidden in the page-view properties panel (still available as a table column). */
  pageHidden?: boolean;
  /** Rollup configuration, for `rollup` properties. */
  rollup?: RollupConfig;
  /**
   * For a two-way `dependency`: the id of the paired inverse `dependency` property
   * (same database). Linking A→B via this property also lists A on B's inverse.
   */
  syncedPropertyId?: string;
  /**
   * `relation` only: the id of the **target database** whose rows this column
   * links to. A relation is database↔database — the cell picks rows from this
   * database. (A legacy relation without it links arbitrary pages.)
   */
  relationDatabaseId?: string;
  /**
   * `relation` only: cap the cell at a single linked row (the "one" side of a
   * 1:1 or 1:n relation). Many (the default) is the "n" side. Read by the cell
   * editor on every relation property (forward and reverse).
   */
  relationSingle?: boolean;
  /**
   * `relation` (forward side) only: the chosen cardinality, kept for display and
   * to derive the reverse property's multiplicity when pairing a two-way link.
   */
  relationCardinality?: RelationCardinality;
  /**
   * `relation` only: the id of the paired reverse `relation` property on the
   * {@link relationDatabaseId target database} (a two-way link). Mirrors
   * {@link syncedPropertyId} but across databases — setting A→B also lists A on
   * B's reverse column.
   */
  reversePropertyId?: string;
}

/** Relation cardinality, from the perspective of the forward property: how many
 *  rows this side links, and how many the reverse side links back. */
export type RelationCardinality = '1:1' | '1:n' | 'n:n';

/** Whether each side of a relation cardinality holds a single row. `1:1` is
 *  single both ways; `1:n` links many but each target points back to one; `n:n`
 *  is many both ways. */
export function relationSides(card: RelationCardinality): {forwardSingle: boolean; reverseSingle: boolean} {
  return {forwardSingle: card === '1:1', reverseSingle: card !== 'n:n'};
}

/** The stored value of a `date` property configured as a range. */
export interface DateRange {
  start: string | null;
  end?: string | null;
}

/**
 * The stored value of a `location` property: a geographic point with optional
 * human label and source address. The shape mirrors the `location` **kit
 * input** (see `blockeditor/kit/scope.ts`) so the two are interchangeable —
 * `address` is added here for the database's geocoding round-trip (a text/address
 * property geocoded into coords keeps the source string for re-display).
 */
export interface LocationValue {
  lat: number;
  lng: number;
  label?: string;
  address?: string;
}

/** Read a `{lat, lng, …}` location value from a cell, or null when unresolvable. */
export function asLocation(value: unknown): LocationValue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<LocationValue>;
  const lat = typeof v.lat === 'number' ? v.lat : Number(v.lat);
  const lng = typeof v.lng === 'number' ? v.lng : Number(v.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    ...(typeof v.label === 'string' && v.label.trim() ? {label: v.label} : {}),
    ...(typeof v.address === 'string' && v.address.trim() ? {address: v.address} : {}),
  };
}

/**
 * A named, collapsible/toggleable cluster of properties in the **page-view
 * properties panel** (open a database row → its fields, organised). Hiding a
 * group hides all its properties at once; collapsing just folds them away.
 */
export interface PropertyGroup {
  id: string;
  name: string;
  /** When true, the group's properties are hidden from the page-view panel. */
  hidden?: boolean;
  /** When true, the group renders folded (a header you can expand). */
  collapsed?: boolean;
}

/**
 * A reusable new-row preset: a named set of property values applied when a row
 * is created "from template". Captured from an existing row and stored on the
 * schema so every view can offer it from the New-row control.
 */
export interface RowTemplate {
  id: string;
  name: string;
  /** Property values to seed onto the new row (keyed by property id). */
  properties: Record<string, unknown>;
}

/**
 * The presentations the database screen supports. `table`/`list` are the
 * row-oriented layouts; `gallery` shows cards; `board` is a kanban grouped by a
 * select property; `calendar` lays rows out on a month grid by a date property;
 * `bar`/`pie` are charts that aggregate rows by a category property.
 */
export type DatabaseViewType =
  | 'table'
  | 'list'
  | 'gallery'
  | 'board'
  | 'calendar'
  | 'timeline'
  | 'map'
  | 'graph'
  | 'bar'
  | 'pie';

/** How a chart (or a board column footer) aggregates a group of rows. */
export interface ChartAggregate {
  /** `count` tallies rows; the others fold a numeric `propertyId`. */
  type: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Property to fold (ignored for `count`). */
  propertyId?: string;
}

/** A per-column footer calculation (table summary aggregations). */
export type SummaryType =
  | 'none'
  | 'count_all'
  | 'count_values'
  | 'count_empty'
  | 'count_filled'
  | 'count_unique'
  | 'percent_empty'
  | 'percent_filled'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'range'
  | 'median';

/** Comparison used by a {@link DatabaseFilter}. */
export type FilterOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'is_today'
  | 'is_this_week'
  | 'is_past_week'
  | 'is_next_week'
  | 'is_this_month'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_checked'
  | 'is_unchecked';

/** The value-less, relative-to-today date operators. */
export const RELATIVE_DATE_OPS: FilterOperator[] = [
  'is_today',
  'is_this_week',
  'is_past_week',
  'is_next_week',
  'is_this_month',
];

export interface DatabaseFilter {
  id: string;
  /** Property to test. The reserved id {@link TITLE_PROPERTY_ID} targets the page name. */
  propertyId: string;
  operator: FilterOperator;
  value?: unknown;
}

/** How a {@link DatabaseFilterGroup}'s children combine. */
export type FilterConjunction = 'and' | 'or';

/**
 * A nested filter group: a set of conditions and/or sub-groups combined with a
 * single conjunction (all `and`, or any `or`). This is the nested filter
 * tree — `view.filterRoot` is the root group; an empty group matches everything.
 */
export interface DatabaseFilterGroup {
  id: string;
  conjunction: FilterConjunction;
  filters: Array<DatabaseFilter | DatabaseFilterGroup>;
}

/** A filter node is either a leaf condition or a nested group. */
export type FilterNode = DatabaseFilter | DatabaseFilterGroup;

/** True when a filter node is a group (vs. a leaf condition). */
export function isFilterGroup(node: FilterNode): node is DatabaseFilterGroup {
  return (node as DatabaseFilterGroup).conjunction !== undefined;
}

export type SortDirection = 'asc' | 'desc';

export interface DatabaseSort {
  propertyId: string;
  direction: SortDirection;
}

/** A conditional-formatting rule: when its condition holds for a row, the row's
 *  edge is tinted `color`. The first matching rule wins. */
export interface ColorRule {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value?: unknown;
  /** A swatch palette token (see `SELECT_COLORS`). */
  color: string;
}

/** A dashboard metric card: a single aggregate over the view's filtered rows. */
export interface DatabaseMetric {
  id: string;
  /** Property to summarise; the reserved {@link TITLE_PROPERTY_ID} counts rows. */
  propertyId: string;
  type: SummaryType;
  /** Optional custom label (defaults to "<property> · <summary>"). */
  label?: string;
  /** Optional goal — when set, the card shows a progress bar of value/target. */
  target?: number;
}

/** A saved presentation of the database: a layout plus its filters and sorts. */
export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  /** Legacy flat (all-AND) filters. Superseded by {@link filterRoot} when present. */
  filters: DatabaseFilter[];
  /** The nested filter tree (and/or groups). Falls back to ANDing {@link filters}. */
  filterRoot?: DatabaseFilterGroup;
  sorts: DatabaseSort[];
  /**
   * Property ids to show, in order. Empty/undefined shows every property. The
   * title is always shown and is not listed here.
   */
  visiblePropertyIds?: string[];
  /**
   * Property to group rows by. Drives the kanban columns (`board`) and the
   * category axis of a chart (`bar`/`pie`). Best paired with a `select`
   * property, but any property works (rows group by their displayed value).
   */
  groupByPropertyId?: string;
  /** Chart aggregation (`bar`/`pie`). Defaults to counting rows per group. */
  aggregate?: ChartAggregate;
  /**
   * Chart second-level group (`bar`/`pie`). Splits each `groupByPropertyId`
   * category into stacked bar segments (or a breakdown ring on the pie). Ignored
   * when unset or equal to `groupByPropertyId`.
   */
  breakdownPropertyId?: string;
  /** Bar chart with a breakdown: stretch every bar to 100% and show each segment
   *  as its share of the group total (proportions rather than absolute lengths). */
  chartStacked100?: boolean;
  /** Date property positioning rows on the month grid (`calendar`) or the bar
   *  start on the `timeline`. A `dateRange` property supplies both ends at once. */
  datePropertyId?: string;
  /** Timeline only: the property giving each bar's end (when not a range date). */
  endDatePropertyId?: string;
  /** Timeline only: the `dependency` property whose links draw arrows between bars. */
  dependencyPropertyId?: string;
  /** Gallery only: a `files`/`url` property whose first image is the card cover. */
  coverPropertyId?: string;
  /** Gallery only: card preview size. Defaults to `medium`. */
  cardSize?: 'small' | 'medium' | 'large';
  /** Gallery/board: a `select`/`status` property whose option colour tints each card's edge. */
  cardColorPropertyId?: string;
  /** Conditional formatting: rules that tint a row/card edge when their condition holds. */
  colorRules?: ColorRule[];
  /** Per-column footer summaries (table), keyed by property id (or {@link TITLE_PROPERTY_ID}). */
  summaries?: Record<string, SummaryType>;
  /** Dashboard metric cards shown above the view (count/sum/avg/… over the filtered rows). */
  metrics?: DatabaseMetric[];
  /** Board only: the per-column footer calculation (a property + summary). Defaults
   *  to summing the first numeric property, or counting rows. */
  boardSummary?: {propertyId: string; type: SummaryType};
  /** When grouped, hide groups/columns that currently have no rows (table + board). */
  hideEmptyGroups?: boolean;
  /**
   * Board/timeline only: a **second** grouping dimension. The board renders one
   * horizontal swimlane per value of this property (columns stay the primary
   * {@link groupByPropertyId}, the Notion model); the timeline already groups by
   * {@link groupByPropertyId}. Distinct from the chart {@link breakdownPropertyId}
   * (different semantics — keep the menus unambiguous).
   */
  subGroupByPropertyId?: string;
  /** Map only: the `location` property whose coords place each row's marker. */
  geoPropertyId?: string;
  /** Map only: an optional text/address property the user can opt to geocode into
   *  the {@link geoPropertyId} coords (no silent network calls — explicit action). */
  addressPropertyId?: string;
  /** Map only: cluster nearby markers at low zoom (default on for dense data). */
  mapClustered?: boolean;
}

/** The full editable definition of a database: its columns, views, and the
 *  page-view property groups. */
export interface DatabaseSchema {
  properties: DatabaseProperty[];
  views: DatabaseView[];
  /** Named groups organising the properties in the page-view panel. */
  propertyGroups?: PropertyGroup[];
  /** Reusable new-row presets offered by the New-row control. */
  templates?: RowTemplate[];
}

/** A database as returned by the store. */
export interface StoredDatabase {
  id: string;
  /** The host page that contains this database. */
  pageId: string;
  name: string | null;
  schema: DatabaseSchema;
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a database (always tied to an existing host page). */
export interface DatabaseInput {
  id?: string;
  pageId: string;
  name?: string | null;
  schema?: DatabaseSchema;
}

/** Payload for editing a database's name and/or schema in place. */
export interface DatabaseUpdate {
  name?: string | null;
  schema?: DatabaseSchema;
}

/**
 * A single row, projected for list/table rendering. Lightweight on purpose: it
 * carries the manual `properties` and the projected `exports` (named reactive
 * values) but not the row page's full document — that is fetched only when the
 * row is opened in the split pane.
 */
export interface DatabaseRow {
  /** The row's page id. */
  id: string;
  /** The row's page title. */
  name: string | null;
  /** Manual property values, keyed by property id. */
  properties: Record<string, unknown>;
  /** Exported reactive cell values, keyed by cell name. */
  exports: Record<string, unknown>;
  /** The row this row is a *sub-item* of (another row of the same database), or null. */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a row (a new page inside the database). */
export interface RowInput {
  name?: string | null;
  properties?: Record<string, unknown>;
  data?: PageSnapshot;
  /** Nest the new row under this row as a sub-item (same database). */
  parentId?: string | null;
}

/**
 * Arrange a flat row list into a parent→children forest by `parentId` (rows
 * whose parent isn't in the set become roots), preserving the input order within
 * each sibling group. Used to render sub-items as an expandable tree.
 */
export interface RowTreeNode {
  row: DatabaseRow;
  depth: number;
  children: RowTreeNode[];
}

export function buildRowTree(rows: DatabaseRow[]): RowTreeNode[] {
  const byParent = new Map<string | null, DatabaseRow[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const parent = row.parentId && ids.has(row.parentId) ? row.parentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(row);
    byParent.set(parent, list);
  }
  const build = (parent: string | null, depth: number): RowTreeNode[] =>
    (byParent.get(parent) ?? []).map((row) => ({row, depth, children: build(row.id, depth + 1)}));
  return build(null, 0);
}

/** Flatten a row tree to a list (depth-first), dropping the children of collapsed rows. */
export function flattenRowTree(nodes: RowTreeNode[], collapsed: Set<string>): RowTreeNode[] {
  const out: RowTreeNode[] = [];
  const walk = (list: RowTreeNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0 && !collapsed.has(node.row.id)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Payload for editing a row's title and/or manual property values. */
export interface RowUpdate {
  name?: string | null;
  properties?: Record<string, unknown>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Reserved property id addressing the row's page title in filters/sorts/views. */
export const TITLE_PROPERTY_ID = 'title';

/** Swatch tokens for `select` options; resolved to colors by the UI. */
export const SELECT_COLORS = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;

// ── Projection + view evaluation (shared by server and client) ───────────────

/**
 * Project a page snapshot's reactive store into a `{name: value}` map. This is
 * how `expr` columns get their values without shipping the whole document: the
 * `names` index maps each exported name to a cellId, and `values` holds the
 * cellId → value pairs.
 */
export function projectExports(snapshot: Pick<PageSnapshot, 'values' | 'names'>): Record<string, unknown> {
  const valueByCell = new Map(snapshot.values);
  const out: Record<string, unknown> = {};
  for (const [name, cellId] of snapshot.names) {
    out[name] = valueByCell.get(cellId);
  }
  return out;
}

/** True when a URL looks like an image (by extension), for thumbnail rendering. */
export function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?.*)?$/i.test(url.trim());
}

/** The first image URL in a `files`/`url` cell value (a string or string[]), or null. */
export function firstImageUrl(value: unknown): string | null {
  const urls = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  for (const u of urls) {
    if (typeof u === 'string' && isImageUrl(u)) return u;
  }
  return null;
}

/**
 * The URL a gallery cover should try: the first extension-detected image, else
 * the first http(s) URL — CDN/signed image URLs often carry no extension, and
 * the property was explicitly chosen as the cover, so any URL in it is worth
 * attempting (the UI falls back to the placeholder if it fails to load).
 */
export function coverImageUrl(value: unknown): string | null {
  const urls = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const strings = urls.filter((u): u is string => typeof u === 'string');
  return strings.find(isImageUrl) ?? strings.find((u) => /^https?:\/\//i.test(u.trim())) ?? null;
}

/**
 * The friendly value a `formula` reads when it references another property by
 * name: a `select` resolves to its option *label* (not the opaque id), a
 * verification to its boolean flag, multi-selects/relations to a comma list. So
 * `prop("Status")` in a formula sees `"Done"`, matching what the cell shows.
 */
function formulaFacingValue(row: DatabaseRow, property: DatabaseProperty): unknown {
  switch (property.type) {
  case 'select':
  case 'status': {
    const opt = property.options?.find((o) => o.id === row.properties[property.id]);
    return opt ? opt.label : '';
  }
  case 'multi_select': {
    const ids = Array.isArray(row.properties[property.id]) ? (row.properties[property.id] as string[]) : [];
    return ids.map((id) => property.options?.find((o) => o.id === id)?.label ?? '').filter(Boolean).join(', ');
  }
  case 'checkbox':
    return row.properties[property.id] === true;
  case 'created_time':
    return row.createdAt;
  case 'last_edited_time':
    return row.updatedAt;
  case 'expr':
    return row.exports[property.cellName ?? property.name];
  case 'verification': {
    const v = row.properties[property.id];
    return !!(v && typeof v === 'object' && (v as {verified?: boolean}).verified);
  }
  case 'date':
    return dateStart(row.properties[property.id]) ?? '';
  default:
    return row.properties[property.id];
  }
}

/**
 * A {@link FormulaResolver} that looks a property up by name within one row and
 * returns its formula-facing value. Resolves nested formulas recursively and
 * guards against reference cycles (a cyclic ref yields a {@link FormulaError}).
 * The reserved names `Name`/`Title` map to the row's page title.
 */
function rowFormulaResolver(row: DatabaseRow, properties: DatabaseProperty[], rows?: DatabaseRow[]): FormulaResolver {
  const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
  const visiting = new Set<string>();
  const resolve: FormulaResolver = (name) => {
    const key = name.toLowerCase();
    const property = byName.get(key);
    if (!property) {
      if (key === 'name' || key === 'title') return row.name ?? '';
      return null;
    }
    if (property.type === 'formula') {
      if (visiting.has(property.id)) return new FormulaError('Circular formula');
      visiting.add(property.id);
      try {
        return evaluateFormula(property.formula ?? '', resolve) as unknown;
      } finally {
        visiting.delete(property.id);
      }
    }
    // A `rollup` resolves to its computed value so formulas can build on rollups.
    if (property.type === 'rollup') return rowValue(row, property, properties, rows);
    return formulaFacingValue(row, property);
  };
  return resolve;
}

/**
 * Resolve the value a row holds for a given property (title / manual / derived).
 * `properties` is needed only to evaluate `formula` columns (which read other
 * properties); pass it from any caller that has the schema (filters, sorts,
 * cells). Without it, a formula resolves to `undefined`.
 */
export function rowValue(
  row: DatabaseRow,
  property: DatabaseProperty | typeof TITLE_PROPERTY_ID,
  properties?: DatabaseProperty[],
  rows?: DatabaseRow[],
): unknown {
  if (property === TITLE_PROPERTY_ID) return row.name ?? '';
  if (property.type === 'expr') return row.exports[property.cellName ?? property.name];
  if (property.type === 'formula') {
    if (!properties) return undefined;
    return evaluateFormula(property.formula ?? '', rowFormulaResolver(row, properties, rows));
  }
  // A `rollup` folds a target property across the rows a relation points to.
  if (property.type === 'rollup') {
    if (!properties || !rows || !property.rollup) return undefined;
    return computeRollup(row, property.rollup, properties, rows);
  }
  // Timestamps are derived from the row page, not stored in `properties`.
  if (property.type === 'created_time') return row.createdAt;
  if (property.type === 'last_edited_time') return row.updatedAt;
  // Verification filters/sorts on the boolean flag (so `is checked` works); the
  // full {verified, by, at} object is read directly by the cell renderer.
  if (property.type === 'verification') {
    const v = row.properties[property.id];
    return !!(v && typeof v === 'object' && (v as {verified?: boolean}).verified);
  }
  // A `date` may hold a `{start, end}` range; filters/sorts compare the start.
  if (property.type === 'date') return dateStart(row.properties[property.id]) ?? '';
  return row.properties[property.id];
}

/** Numeric folds shared by rollups, chart aggregates and summaries. */
const numericFold = (nums: number[], fn: 'sum' | 'avg' | 'min' | 'max' | 'range' | 'median'): number => {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  switch (fn) {
  case 'sum':
    return sorted.reduce((a, b) => a + b, 0);
  case 'avg':
    return sorted.reduce((a, b) => a + b, 0) / sorted.length;
  case 'min':
    return sorted[0];
  case 'max':
    return sorted[sorted.length - 1];
  case 'range':
    return sorted[sorted.length - 1] - sorted[0];
  case 'median': {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  }
};

/** Compute a rollup value: gather the related rows, fold the target property. */
function computeRollup(row: DatabaseRow, cfg: RollupConfig, properties: DatabaseProperty[], rows: DatabaseRow[]): unknown {
  const relProp = properties.find((p) => p.id === cfg.relationPropertyId);
  const raw = relProp ? row.properties[relProp.id] : undefined;
  const ids = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const related = ids.map((id) => byId.get(id)).filter((r): r is DatabaseRow => !!r);
  if (cfg.function === 'count') return related.length;

  const target =
    cfg.targetPropertyId === TITLE_PROPERTY_ID ? TITLE_PROPERTY_ID : properties.find((p) => p.id === cfg.targetPropertyId);
  if (!target) return undefined;
  const values = related.map((r) => rowValue(r, target, properties, rows));

  switch (cfg.function) {
  case 'show_original':
    return values;
  case 'count_values':
    return values.filter((v) => !isEmpty(v)).length;
  case 'count_unique':
    return new Set(values.filter((v) => !isEmpty(v)).map((v) => (Array.isArray(v) ? JSON.stringify(v) : String(v)))).size;
  case 'checked':
    return values.filter((v) => v === true).length;
  case 'percent_checked':
    return values.length ? Math.round((values.filter((v) => v === true).length / values.length) * 100) : 0;
  default: {
    const nums = values.map(asNumber).filter((n) => !Number.isNaN(n));
    return numericFold(nums, cfg.function);
  }
  }
}

// ── Dates & timeline spans ───────────────────────────────────────────────────

/** The `start` day of a date value (a plain `YYYY-MM-DD` string or a {@link DateRange}). */
export function dateStart(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (value && typeof value === 'object') {
    const s = (value as DateRange).start;
    return typeof s === 'string' && s.trim() ? s : null;
  }
  return null;
}

/** The `end` day of a {@link DateRange} value (null for a single-day date). */
export function dateEnd(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const e = (value as DateRange).end;
    return typeof e === 'string' && e.trim() ? e : null;
  }
  return null;
}

/** Parse a `YYYY-MM-DD` (or any Date-parseable) string to a *local* midnight Date. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An inclusive day span for a timeline bar. */
export interface DateSpan {
  start: Date;
  end: Date;
}

/**
 * The timeline bar span for a row: `[start, end]` resolved from the view's date
 * configuration — a `dateRange` property (start+end in one), or a start date
 * property plus an optional `endDatePropertyId`. Returns `null` when the row has
 * no start date. A missing/earlier end collapses to a single-day bar.
 */
export function rowDateSpan(row: DatabaseRow, view: DatabaseView, properties: DatabaseProperty[]): DateSpan | null {
  const startProp = properties.find((p) => p.id === view.datePropertyId);
  if (!startProp) return null;
  const raw = row.properties[startProp.id];
  const start = parseDay(dateStart(raw));
  if (!start) return null;

  const endProp = view.endDatePropertyId ? properties.find((p) => p.id === view.endDatePropertyId) : undefined;
  const endStr = endProp ? dateStart(row.properties[endProp.id]) : dateEnd(raw);
  const end = parseDay(endStr);
  return {start, end: end && end >= start ? end : start};
}

/**
 * The map marker location for a row: the resolved coords of the view's
 * `geoPropertyId` location cell, or null when the row has no usable coords (an
 * empty cell, or an address that hasn't been geocoded). Pure — drives the map
 * view's placed/unplaced split and is unit-testable.
 */
export function rowLocation(row: DatabaseRow, view: DatabaseView, properties: DatabaseProperty[]): LocationValue | null {
  const geoProp = view.geoPropertyId ? properties.find((p) => p.id === view.geoPropertyId) : undefined;
  if (!geoProp) return null;
  return asLocation(row.properties[geoProp.id]);
}

// ── Dependency graph ─────────────────────────────────────────────────────────

/** A node in the dependency graph, placed in a layer (column) at an order (row). */
export interface GraphNode {
  id: string;
  /** Longest-path depth from a root (a row with no predecessors). */
  layer: number;
  /** Position within the layer (stable: source-row order). */
  order: number;
}

/** A directed edge `from` a predecessor `to` the row that depends on it. */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Number of layers (the graph's depth); at least 1. */
  layerCount: number;
  /** The most nodes in any one layer (the graph's height). */
  maxLayerSize: number;
}

/**
 * Lay a database's rows out as a dependency DAG: each row is a node, and its
 * `dependency` property lists the predecessors it points back to (edge
 * predecessor → dependent). Nodes are assigned a **layer** by longest path from a
 * root (a row with no predecessors) so dependents always sit to the right of
 * everything they depend on, and an **order** within the layer (stable, by row
 * order). Pure and cycle-safe — a back-edge simply doesn't deepen the layer — so
 * it can drive the graph view and be unit-tested directly.
 */
export function dependencyGraph(rows: DatabaseRow[], dependencyPropertyId: string | undefined): DependencyGraph {
  const ids = new Set(rows.map((r) => r.id));
  const predsOf = new Map<string, string[]>();
  for (const r of rows) {
    const raw = dependencyPropertyId ? r.properties[dependencyPropertyId] : undefined;
    const deps = Array.isArray(raw) ? (raw as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    predsOf.set(r.id, deps.filter((id) => ids.has(id) && id !== r.id));
  }

  const layerCache = new Map<string, number>();
  const computing = new Set<string>();
  const layerOf = (id: string): number => {
    const cached = layerCache.get(id);
    if (cached !== undefined) return cached;
    if (computing.has(id)) return 0; // cycle — break without deepening
    computing.add(id);
    const preds = predsOf.get(id) ?? [];
    const layer = preds.length === 0 ? 0 : Math.max(...preds.map(layerOf)) + 1;
    computing.delete(id);
    layerCache.set(id, layer);
    return layer;
  };

  const perLayer = new Map<number, number>();
  const nodes: GraphNode[] = rows.map((r) => {
    const layer = layerOf(r.id);
    const order = perLayer.get(layer) ?? 0;
    perLayer.set(layer, order + 1);
    return {id: r.id, layer, order};
  });

  const edges: GraphEdge[] = [];
  for (const r of rows) for (const p of predsOf.get(r.id) ?? []) edges.push({from: p, to: r.id});

  return {
    nodes,
    edges,
    layerCount: Math.max(0, ...nodes.map((n) => n.layer)) + 1,
    maxLayerSize: Math.max(1, ...[...perLayer.values()]),
  };
}

/** A related row's inverse-property value to write when syncing a two-way link. */
export interface InverseUpdate {
  rowId: string;
  value: string[];
}

/**
 * Compute the inverse-property writes for a two-way `dependency` change: when
 * `rowId`'s links go from `oldIds` to `newIds`, each newly-added related row gains
 * `rowId` in its `inversePropertyId`, and each removed one loses it. Pure — the
 * hook applies the returned updates — so the sync logic is unit-tested directly.
 */
export function syncInverseUpdates(
  rowId: string,
  oldIds: string[],
  newIds: string[],
  relatedRows: DatabaseRow[],
  inversePropertyId: string,
): InverseUpdate[] {
  const byId = new Map(relatedRows.map((r) => [r.id, r]));
  const inverseOf = (r: DatabaseRow): string[] =>
    Array.isArray(r.properties[inversePropertyId]) ? (r.properties[inversePropertyId] as string[]) : [];
  const updates: InverseUpdate[] = [];
  for (const id of newIds.filter((x) => !oldIds.includes(x))) {
    const r = byId.get(id);
    if (r && !inverseOf(r).includes(rowId)) updates.push({rowId: id, value: [...inverseOf(r), rowId]});
  }
  for (const id of oldIds.filter((x) => !newIds.includes(x))) {
    const r = byId.get(id);
    if (r && inverseOf(r).includes(rowId)) updates.push({rowId: id, value: inverseOf(r).filter((x) => x !== rowId)});
  }
  return updates;
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const asNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const shiftDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Evaluate a relative-to-`now` date operator against a cell's day value. */
function matchesRelativeDate(operator: FilterOperator, cell: unknown, now: Date): boolean {
  const day = parseDay(typeof cell === 'string' ? cell : '');
  if (!day) return false;
  const today = startOfDay(now);
  switch (operator) {
  case 'is_today':
    return day.getTime() === today.getTime();
  case 'is_this_week': {
    const start = shiftDays(today, -today.getDay()); // week starts Sunday
    return day >= start && day < shiftDays(start, 7);
  }
  case 'is_past_week':
    return day >= shiftDays(today, -7) && day <= today;
  case 'is_next_week':
    return day > today && day <= shiftDays(today, 7);
  case 'is_this_month':
    return day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth();
  default:
    return false;
  }
}

/**
 * Evaluate a single filter against a resolved value. The optional `now`
 * (defaulting to the current date) anchors the relative date operators
 * (`is_today`, `is_this_week`, …) — pass it explicitly to keep tests deterministic.
 */
export function matchesFilter(operator: FilterOperator, cell: unknown, target: unknown, now?: Date): boolean {
  if (RELATIVE_DATE_OPS.includes(operator)) return matchesRelativeDate(operator, cell, now ?? new Date());
  // Array cells (multi-select / relation) test membership / emptiness.
  if (Array.isArray(cell)) {
    const needle = String(target ?? '').toLowerCase();
    const has = cell.some((x) => String(x).toLowerCase().includes(needle));
    switch (operator) {
    case 'contains':
      return has;
    case 'not_contains':
      return !has;
    case 'is_empty':
      return cell.length === 0;
    case 'is_not_empty':
      return cell.length > 0;
    default:
      return true;
    }
  }
  switch (operator) {
  case 'equals':
    return String(cell ?? '') === String(target ?? '');
  case 'not_equals':
    return String(cell ?? '') !== String(target ?? '');
  case 'contains':
    return String(cell ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
  case 'not_contains':
    return !String(cell ?? '').toLowerCase().includes(String(target ?? '').toLowerCase());
  case 'starts_with':
    return String(cell ?? '').toLowerCase().startsWith(String(target ?? '').toLowerCase());
  case 'ends_with':
    return String(cell ?? '').toLowerCase().endsWith(String(target ?? '').toLowerCase());
  case 'gt':
    return asNumber(cell) > asNumber(target);
  case 'lt':
    return asNumber(cell) < asNumber(target);
  case 'gte':
    return asNumber(cell) >= asNumber(target);
  case 'lte':
    return asNumber(cell) <= asNumber(target);
  case 'before':
  case 'after':
  case 'on_or_before':
  case 'on_or_after': {
    const c = parseDay(String(cell ?? ''));
    const t = parseDay(String(target ?? ''));
    if (!c || !t) return false;
    const d = c.getTime() - t.getTime();
    return operator === 'before' ? d < 0 : operator === 'after' ? d > 0 : operator === 'on_or_before' ? d <= 0 : d >= 0;
  }
  case 'is_empty':
    return isEmpty(cell);
  case 'is_not_empty':
    return !isEmpty(cell);
  case 'is_checked':
    return cell === true;
  case 'is_unchecked':
    return cell !== true;
  default:
    return true;
  }
}

const propertyById = (
  properties: DatabaseProperty[],
  id: string,
): DatabaseProperty | typeof TITLE_PROPERTY_ID | undefined =>
  id === TITLE_PROPERTY_ID ? TITLE_PROPERTY_ID : properties.find((p) => p.id === id);

/** Compare two resolved cell values for sorting, numeric when both look numeric. */
function compareValues(a: unknown, b: unknown): number {
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1; // empties sort last
  if (isEmpty(b)) return -1;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * The effective filter tree for a view: its `filterRoot`, or a synthesised
 * all-`and` group wrapping the legacy flat `filters`. Lets the UI always edit a
 * single tree while old views keep working.
 */
export function viewFilterRoot(view: DatabaseView): DatabaseFilterGroup {
  return view.filterRoot ?? {id: 'root', conjunction: 'and', filters: view.filters ?? []};
}

/**
 * Apply a view's filters and sorts to a row set, returning a new array. Filters
 * are evaluated as a nested and/or tree ({@link viewFilterRoot}); sorts are
 * applied in order (first sort is primary). Pure and side-effect free so it can
 * run identically on the server or in the table UI.
 */
/**
 * True when a single leaf condition holds for a row — the same per-row test
 * {@link applyView} uses for filtering, exposed for conditional formatting
 * (color rules). Returns false when the condition's property no longer exists.
 */
export function rowMatchesCondition(
  row: DatabaseRow,
  condition: {propertyId: string; operator: FilterOperator; value?: unknown},
  properties: DatabaseProperty[],
  rows?: DatabaseRow[],
): boolean {
  const prop = properties.find((p) => p.id === condition.propertyId);
  if (!prop) return false;
  return matchesFilter(condition.operator, rowValue(row, prop, properties, rows), condition.value);
}

export function applyView(rows: DatabaseRow[], view: DatabaseView, properties: DatabaseProperty[]): DatabaseRow[] {
  const root = viewFilterRoot(view);
  const evalNode = (node: FilterNode, row: DatabaseRow): boolean => {
    if (isFilterGroup(node)) {
      if (node.filters.length === 0) return true; // empty group matches everything
      const results = node.filters.map((child) => evalNode(child, row));
      return node.conjunction === 'or' ? results.some(Boolean) : results.every(Boolean);
    }
    const prop = propertyById(properties, node.propertyId);
    if (!prop) return true;
    return matchesFilter(node.operator, rowValue(row, prop, properties, rows), node.value);
  };
  const filtered = rows.filter((row) => evalNode(root, row));

  const sorts = view.sorts ?? [];
  if (sorts.length === 0) return filtered;

  // Stable multi-key sort: index-tagged to keep equal rows in original order.
  return filtered
    .map((row, index) => ({row, index}))
    .sort((a, b) => {
      for (const sort of sorts) {
        const prop = propertyById(properties, sort.propertyId);
        if (!prop) continue;
        const cmp = compareValues(rowValue(a.row, prop, properties, rows), rowValue(b.row, prop, properties, rows));
        if (cmp !== 0) return sort.direction === 'desc' ? -cmp : cmp;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

// ── Defaults ─────────────────────────────────────────────────────────────────

let counter = 0;
/** Short non-cryptographic id for properties/views/options/filters. */
export const shortId = (prefix: string): string => {
  counter += 1;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : `${counter}`;
  return `${prefix}_${rand}`;
};

/**
 * A sensible starting schema for a brand-new database: a couple of manual
 * properties and both a table and a list view, so the view switcher has
 * something to switch between out of the box.
 */
export function defaultDatabaseSchema(): DatabaseSchema {
  const status: DatabaseProperty = {
    id: shortId('prop'),
    name: 'Status',
    type: 'select',
    options: [
      {id: shortId('opt'), label: 'Todo', color: 'gray'},
      {id: shortId('opt'), label: 'In progress', color: 'blue'},
      {id: shortId('opt'), label: 'Done', color: 'green'},
    ],
  };
  const notes: DatabaseProperty = {id: shortId('prop'), name: 'Notes', type: 'text'};
  return {
    properties: [status, notes],
    views: [
      {id: shortId('view'), name: 'Table', type: 'table', filters: [], sorts: []},
      {id: shortId('view'), name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: status.id},
      {id: shortId('view'), name: 'List', type: 'list', filters: [], sorts: []},
    ],
  };
}

/** A fresh view of a given type with sensible defaults for its layout. */
export function defaultView(type: DatabaseViewType, name: string, properties: DatabaseProperty[]): DatabaseView {
  const view: DatabaseView = {id: shortId('view'), name, type, filters: [], sorts: []};
  if (type === 'board' || type === 'bar' || type === 'pie') {
    // Default the grouping to the first select/status property (kanban columns /
    // chart categories read best off one), falling back to any property.
    const select = properties.find((p) => p.type === 'select' || p.type === 'status');
    view.groupByPropertyId = (select ?? properties[0])?.id;
  }
  if (type === 'calendar' || type === 'timeline') {
    const date = properties.find((p) => p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time');
    view.datePropertyId = date?.id;
  }
  if (type === 'timeline') {
    // A non-range start date pairs with a second date property for the bar end;
    // a `dependency` property (if any) draws the arrows between bars.
    const dates = properties.filter((p) => p.type === 'date');
    if (dates.length >= 2 && !dates[0].dateRange) view.endDatePropertyId = dates[1].id;
    view.dependencyPropertyId = properties.find((p) => p.type === 'dependency')?.id;
  }
  if (type === 'graph') {
    view.dependencyPropertyId = properties.find((p) => p.type === 'dependency')?.id;
  }
  if (type === 'map') {
    // Place markers off the first location property; clustering on by default.
    view.geoPropertyId = properties.find((p) => p.type === 'location')?.id;
    view.mapClustered = true;
  }
  return view;
}

/** The starting options for a `status` property: one per lifecycle bucket. */
export function defaultStatusOptions(): DatabaseSelectOption[] {
  return [
    {id: shortId('opt'), label: 'Not started', color: 'gray', group: 'todo'},
    {id: shortId('opt'), label: 'In progress', color: 'blue', group: 'in_progress'},
    {id: shortId('opt'), label: 'Done', color: 'green', group: 'complete'},
  ];
}

/** The lifecycle buckets a `status` property groups its options under, in order. */
export const STATUS_GROUPS: {id: StatusGroup; label: string}[] = [
  {id: 'todo', label: 'To-do'},
  {id: 'in_progress', label: 'In progress'},
  {id: 'complete', label: 'Complete'},
];

/**
 * Remove a property from a schema and scrub **every** dangling reference to it:
 * each view's filters (flat list *and* the nested {@link filterRoot} tree),
 * sorts, visible columns, summaries, and the group-by / date / cover config; plus
 * any `rollup` on another property that aggregated through or over it. Pure —
 * returns a fresh schema — so it can be unit-tested and shared by the delete
 * action. (Renders already tolerate stale refs; this keeps the schema clean.)
 */
export function removeProperty(schema: DatabaseSchema, propertyId: string): DatabaseSchema {
  const pruneNode = (node: FilterNode): FilterNode | null => {
    if (isFilterGroup(node)) {
      return {...node, filters: node.filters.map(pruneNode).filter((n): n is FilterNode => n !== null)};
    }
    return node.propertyId === propertyId ? null : node;
  };

  return {
    ...schema,
    properties: schema.properties
      .filter((p) => p.id !== propertyId)
      .map((p) => {
        let next = p;
        if (p.rollup && (p.rollup.relationPropertyId === propertyId || p.rollup.targetPropertyId === propertyId)) {
          next = {...next, rollup: undefined};
        }
        // Break a two-way dependency pairing when its partner is removed.
        if (p.syncedPropertyId === propertyId) next = {...next, syncedPropertyId: undefined};
        return next;
      }),
    views: schema.views.map((v) => {
      const summaries = v.summaries
        ? Object.fromEntries(Object.entries(v.summaries).filter(([k]) => k !== propertyId))
        : undefined;
      return {
        ...v,
        filters: (v.filters ?? []).filter((f) => f.propertyId !== propertyId),
        filterRoot: v.filterRoot ? (pruneNode(v.filterRoot) as DatabaseFilterGroup) : undefined,
        sorts: (v.sorts ?? []).filter((s) => s.propertyId !== propertyId),
        visiblePropertyIds: v.visiblePropertyIds?.filter((id) => id !== propertyId),
        summaries,
        groupByPropertyId: v.groupByPropertyId === propertyId ? undefined : v.groupByPropertyId,
        subGroupByPropertyId: v.subGroupByPropertyId === propertyId ? undefined : v.subGroupByPropertyId,
        datePropertyId: v.datePropertyId === propertyId ? undefined : v.datePropertyId,
        endDatePropertyId: v.endDatePropertyId === propertyId ? undefined : v.endDatePropertyId,
        dependencyPropertyId: v.dependencyPropertyId === propertyId ? undefined : v.dependencyPropertyId,
        coverPropertyId: v.coverPropertyId === propertyId ? undefined : v.coverPropertyId,
        geoPropertyId: v.geoPropertyId === propertyId ? undefined : v.geoPropertyId,
        addressPropertyId: v.addressPropertyId === propertyId ? undefined : v.addressPropertyId,
      };
    }),
    // Drop the removed property's seed value from every row template.
    templates: schema.templates?.map((t) =>
      propertyId in t.properties
        ? {...t, properties: Object.fromEntries(Object.entries(t.properties).filter(([k]) => k !== propertyId))}
        : t,
    ),
  };
}

// ── Number formatting ────────────────────────────────────────────────────────

const FORMAT_PREFIX: Partial<Record<NumberFormat, string>> = {dollar: '$', euro: '€', pound: '£', rupee: '₹'};

/** Format a numeric value for display per a {@link NumberFormat}. Non-numbers pass through as text. */
export function formatNumber(value: unknown, format: NumberFormat | undefined): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (Number.isNaN(n)) return value === undefined || value === null ? '' : String(value);
  switch (format) {
  case 'integer':
    return Math.round(n).toLocaleString();
  case 'decimal':
    return n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  case 'percent':
    return `${(n * 100).toLocaleString(undefined, {maximumFractionDigits: 2})}%`;
  case 'yen':
    return `¥${Math.round(n).toLocaleString()}`; // yen is conventionally whole-number
  case 'dollar':
  case 'euro':
  case 'pound':
  case 'rupee':
    return `${FORMAT_PREFIX[format]}${n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  default:
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  }
}

/**
 * Format a `unique_id` value for display: an integer, optionally prefixed
 * (`TASK` → `TASK-3`). Empty for unassigned (non-numeric) values. Pure.
 */
export function formatUniqueId(value: unknown, prefix?: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const p = prefix?.trim();
  return p ? `${p}-${value}` : String(value);
}

/**
 * The clamped 0..1 fraction of a number cell relative to its `target` (the
 * value that fills a `bar`/`ring`). Non-numbers and a non-positive target read
 * as 0; the target defaults to 100. Pure — drives the bar/ring cell and tests.
 */
export function numberProgress(value: unknown, target?: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const max = typeof target === 'number' && target > 0 ? target : 100;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n / max));
}

// ── Grouping + aggregation (board columns, charts) ───────────────────────────

/** The label shown for rows that have no value for the grouping property. */
export const NO_VALUE_GROUP = 'No value';

/** One group of rows sharing a value of the grouping property. */
export interface RowGroup {
  /** Stable key for the group (option id, or the displayed string). */
  key: string;
  /** Human label (option label, or the value itself). */
  label: string;
  /** Swatch color, when the group corresponds to a select option. */
  color?: string;
  rows: DatabaseRow[];
}

/** Display string for a row's value of a property (option labels, joined lists). */
function displayValue(row: DatabaseRow, property: DatabaseProperty, properties: DatabaseProperty[]): string {
  const v = rowValue(row, property, properties);
  if (property.type === 'select' || property.type === 'status') {
    return property.options?.find((o) => o.id === row.properties[property.id])?.label ?? '';
  }
  if (v instanceof FormulaError) return v.message;
  if (property.type === 'location') {
    const loc = asLocation(v);
    return loc ? loc.label ?? loc.address ?? `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : '';
  }
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'Checked' : 'Unchecked';
  return String(v);
}

/**
 * Group rows by a property for the board (kanban) layout. When the property is a
 * `select`, columns follow the option order (including empty ones) so the board
 * is stable as rows move; otherwise columns are the distinct displayed values.
 * Rows with no value collect into a trailing {@link NO_VALUE_GROUP} column.
 */
export function groupRows(
  rows: DatabaseRow[],
  property: DatabaseProperty | undefined,
  properties: DatabaseProperty[],
): RowGroup[] {
  if (!property) return [{key: '__all__', label: 'All', rows}];

  if (property.type === 'select' || property.type === 'status') {
    const groups: RowGroup[] = (property.options ?? []).map((o) => ({key: o.id, label: o.label, color: o.color, rows: []}));
    const byId = new Map(groups.map((g) => [g.key, g]));
    const none: RowGroup = {key: '__none__', label: NO_VALUE_GROUP, rows: []};
    for (const row of rows) {
      const id = row.properties[property.id];
      const group = typeof id === 'string' ? byId.get(id) : undefined;
      (group ?? none).rows.push(row);
    }
    return none.rows.length ? [...groups, none] : groups;
  }

  // Generic: bucket by displayed value, preserving first-seen order.
  const order: string[] = [];
  const byLabel = new Map<string, RowGroup>();
  for (const row of rows) {
    const label = displayValue(row, property, properties) || NO_VALUE_GROUP;
    let group = byLabel.get(label);
    if (!group) {
      group = {key: label, label, rows: []};
      byLabel.set(label, group);
      order.push(label);
    }
    group.rows.push(row);
  }
  return order.map((label) => byLabel.get(label)!);
}

/**
 * Sentinel `groupByPropertyId` meaning "group by parent item" (sub-items).
 * Not a real property id — {@link groupRowsBy} dispatches on it.
 */
export const PARENT_GROUP_ID = '__parent__';

/** The label of the trailing group for rows that are nobody's sub-item. */
export const NO_PARENT_GROUP = 'No parent';

/**
 * Group rows by their parent row (sub-items): one group per row with at least
 * one direct child in the set (key = the parent's row id, in row order), plus a
 * trailing {@link NO_PARENT_GROUP} group for loose rows — rows that neither
 * have a parent in the set nor children of their own. A row that is both a
 * parent and a sub-item appears in its parent's group *and* heads its own.
 * Parents outside the set (filtered out, or the host page) don't count.
 */
export function groupRowsByParent(rows: DatabaseRow[]): RowGroup[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, DatabaseRow[]>();
  for (const row of rows) {
    if (row.parentId && ids.has(row.parentId)) {
      const list = children.get(row.parentId);
      if (list) list.push(row);
      else children.set(row.parentId, [row]);
    }
  }
  const groups: RowGroup[] = [];
  const none: RowGroup = {key: '__none__', label: NO_PARENT_GROUP, rows: []};
  for (const row of rows) {
    const kids = children.get(row.id);
    if (kids) groups.push({key: row.id, label: row.name?.trim() || 'Untitled', rows: kids});
    else if (!(row.parentId && ids.has(row.parentId))) none.rows.push(row);
  }
  return none.rows.length ? [...groups, none] : groups;
}

/**
 * Group rows by a view's `groupByPropertyId`: the {@link PARENT_GROUP_ID}
 * sentinel groups by parent item ({@link groupRowsByParent}); anything else
 * resolves to a property and falls through to {@link groupRows} (an unset or
 * unknown id yields the single "All" group). The one dispatch shared by the
 * board, table, list, gallery, and the chart aggregations.
 */
export function groupRowsBy(rows: DatabaseRow[], groupByPropertyId: string | undefined, properties: DatabaseProperty[]): RowGroup[] {
  if (groupByPropertyId === PARENT_GROUP_ID) return groupRowsByParent(rows);
  return groupRows(rows, properties.find((p) => p.id === groupByPropertyId), properties);
}

/** One category of a chart: a label, its aggregated value, and an optional color. */
export interface ChartDatum {
  key: string;
  label: string;
  value: number;
  color?: string;
}

const foldAggregate = (rows: DatabaseRow[], agg: ChartAggregate, properties: DatabaseProperty[]): number => {
  if (agg.type === 'count' || !agg.propertyId) return rows.length;
  const prop = properties.find((p) => p.id === agg.propertyId);
  if (!prop) return rows.length;
  const nums = rows
    .map((r) => rowValue(r, prop, properties, rows))
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN))
    .filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return 0;
  switch (agg.type) {
  case 'sum':
    return nums.reduce((a, b) => a + b, 0);
  case 'avg':
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  case 'min':
    return Math.min(...nums);
  case 'max':
    return Math.max(...nums);
  default:
    return rows.length;
  }
};

/**
 * Aggregate rows into chart data: one datum per group of the view's
 * `groupByPropertyId`, with the bar/slice height computed by the view's
 * `aggregate` (count by default, else sum/avg/min/max of a numeric property).
 */
export function aggregateRows(rows: DatabaseRow[], view: DatabaseView, properties: DatabaseProperty[]): ChartDatum[] {
  const agg: ChartAggregate = view.aggregate ?? {type: 'count'};
  return groupRowsBy(rows, view.groupByPropertyId, properties).map((g) => ({
    key: g.key,
    label: g.label,
    color: g.color,
    value: foldAggregate(g.rows, agg, properties),
  }));
}

/** Synthetic series used when a chart has no breakdown (a single full-height bar). */
export const CHART_TOTAL_SERIES = '__total__';

/** A breakdown series — the second-level group shared across every chart group. */
export interface ChartSeries {
  /** Stable key (breakdown option id, or its displayed value). */
  key: string;
  label: string;
  /** Swatch color when the series is a select option. */
  color?: string;
}

/** One series' slice of a {@link ChartGroup}: its rows and aggregated value. */
export interface ChartSegment {
  seriesKey: string;
  value: number;
  /** The rows behind this segment (powers click-to-drill). */
  rows: DatabaseRow[];
}

/** One primary chart category, split across the shared {@link ChartMatrix.series}. */
export interface ChartGroup {
  key: string;
  label: string;
  color?: string;
  /** The group's bar height / slice size (sum of its segment values). */
  total: number;
  /** Per-series contributions, in {@link ChartMatrix.series} order (zero-filled). */
  segments: ChartSegment[];
  rows: DatabaseRow[];
}

/** A chart's full data: primary groups, each split across a shared series set. */
export interface ChartMatrix {
  groups: ChartGroup[];
  series: ChartSeries[];
}

/**
 * Aggregate rows into a {@link ChartMatrix}: one group per value of the view's
 * `groupByPropertyId`, each split into segments by `breakdownPropertyId` (the
 * second-level group). The series are derived once across all rows so every group
 * shares the same ordered, coloured set — a group with no rows for a series gets a
 * zero segment, keeping stacked bars aligned. Without a breakdown each group has a
 * single {@link CHART_TOTAL_SERIES} segment equal to its total. Pure — drives the
 * bar and pie charts and their drill-downs.
 */
export function aggregateMatrix(rows: DatabaseRow[], view: DatabaseView, properties: DatabaseProperty[]): ChartMatrix {
  const agg: ChartAggregate = view.aggregate ?? {type: 'count'};
  const groups = groupRowsBy(rows, view.groupByPropertyId, properties);
  // A breakdown id is honoured when it differs from the primary grouping and
  // resolves to something real (a property, or the parent-item sentinel).
  const breakdownId =
    view.breakdownPropertyId &&
    view.breakdownPropertyId !== view.groupByPropertyId &&
    (view.breakdownPropertyId === PARENT_GROUP_ID || properties.some((p) => p.id === view.breakdownPropertyId))
      ? view.breakdownPropertyId
      : undefined;

  if (!breakdownId) {
    return {
      series: [{key: CHART_TOTAL_SERIES, label: ''}],
      groups: groups.map((g) => {
        const total = foldAggregate(g.rows, agg, properties);
        return {
          key: g.key,
          label: g.label,
          color: g.color,
          total,
          rows: g.rows,
          segments: [{seriesKey: CHART_TOTAL_SERIES, value: total, rows: g.rows}],
        };
      }),
    };
  }

  // Derive the shared series from the breakdown across every row (stable order).
  // Segments intersect a series' full-set rows with the group's rows rather than
  // re-grouping the subset: for property breakdowns the two are equivalent, but a
  // parent-item breakdown needs the full set (a subset loses the parents that
  // anchor its groups).
  const seriesGroups = groupRowsBy(rows, breakdownId, properties);
  const series: ChartSeries[] = seriesGroups.map((s) => ({key: s.key, label: s.label, color: s.color}));
  return {
    series,
    groups: groups.map((g) => {
      const inGroup = new Set(g.rows.map((r) => r.id));
      const segments: ChartSegment[] = seriesGroups.map((s) => {
        const segRows = s.rows.filter((r) => inGroup.has(r.id));
        return {seriesKey: s.key, value: foldAggregate(segRows, agg, properties), rows: segRows};
      });
      return {key: g.key, label: g.label, color: g.color, total: foldAggregate(g.rows, agg, properties), rows: g.rows, segments};
    }),
  };
}

// ── Column summaries (table footers) ─────────────────────────────────────────

const toNum = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;

/**
 * Compute a column footer summary over a row set: counts (all / values / empty /
 * filled / unique), percentages, or numeric folds (sum / avg / min / max / range
 * / median). Returns a display string ('' for `none`). `property` is
 * {@link TITLE_PROPERTY_ID} for the title column; numeric folds honour a
 * property's `numberFormat`. Pure — shared by the table footer UI and tests.
 */
export function summarizeColumn(
  rows: DatabaseRow[],
  property: DatabaseProperty | typeof TITLE_PROPERTY_ID,
  type: SummaryType,
  properties: DatabaseProperty[],
): string {
  if (type === 'none') return '';
  if (type === 'count_all') return String(rows.length);

  const values = rows.map((r) => rowValue(r, property, properties, rows));
  const filled = values.filter((v) => !isEmpty(v));
  const total = rows.length || 1;

  switch (type) {
  case 'count_values':
  case 'count_filled':
    return String(filled.length);
  case 'count_empty':
    return String(values.length - filled.length);
  case 'count_unique':
    return String(new Set(filled.map((v) => (Array.isArray(v) ? JSON.stringify(v) : String(v)))).size);
  case 'percent_empty':
    return `${Math.round(((values.length - filled.length) / total) * 100)}%`;
  case 'percent_filled':
    return `${Math.round((filled.length / total) * 100)}%`;
  default:
    break;
  }

  // Numeric folds.
  const nums = filled.map(toNum).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (nums.length === 0) return '—';
  const format = property !== TITLE_PROPERTY_ID ? property.numberFormat : undefined;
  const fmt = (n: number): string => formatNumber(n, format);
  switch (type) {
  case 'sum':
    return fmt(nums.reduce((a, b) => a + b, 0));
  case 'avg':
    return fmt(nums.reduce((a, b) => a + b, 0) / nums.length);
  case 'min':
    return fmt(nums[0]);
  case 'max':
    return fmt(nums[nums.length - 1]);
  case 'range':
    return fmt(nums[nums.length - 1] - nums[0]);
  case 'median': {
    const mid = Math.floor(nums.length / 2);
    return fmt(nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2);
  }
  default:
    return '';
  }
}
