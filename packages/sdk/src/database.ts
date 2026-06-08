/**
 * Notion-style databases — the second unit of storage layered over {@link
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
 * (`text`/`number`/`select`/`checkbox`/`date`/`person`/`verification`) store
 * their value per row in `page.properties[id]`. `expr` projects a named reactive
 * cell from the row page's document; `formula` computes from the row's *other*
 * properties (`prop("Price") * prop("Qty")`); `backlinks` is computed from the
 * link graph (never stored). The last three
 * (`person`/`verification`/`backlinks`) double as the built-in page properties —
 * see {@link ./pageProperties}.
 */
export type DatabasePropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'email'
  | 'phone'
  | 'relation'
  | 'created_time'
  | 'last_edited_time'
  | 'expr'
  | 'formula'
  | 'person'
  | 'verification'
  | 'backlinks';

/** Display formatting for `number`/`formula`/`expr` numeric values. */
export type NumberFormat = 'plain' | 'integer' | 'decimal' | 'percent' | 'dollar' | 'euro';

/** One choice in a `select` property. */
export interface DatabaseSelectOption {
  id: string;
  label: string;
  /** A token from the shared swatch palette (see `SELECT_COLORS`). */
  color?: string;
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
}

/**
 * The presentations the database screen supports. `table`/`list` are the
 * row-oriented layouts; `gallery` shows cards; `board` is a kanban grouped by a
 * select property; `calendar` lays rows out on a month grid by a date property;
 * `bar`/`pie` are charts that aggregate rows by a category property.
 */
export type DatabaseViewType = 'table' | 'list' | 'gallery' | 'board' | 'calendar' | 'bar' | 'pie';

/** How a chart (or a board column footer) aggregates a group of rows. */
export interface ChartAggregate {
  /** `count` tallies rows; the others fold a numeric `propertyId`. */
  type: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Property to fold (ignored for `count`). */
  propertyId?: string;
}

/** A per-column footer calculation (Notion-style table summaries). */
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
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'is_empty'
  | 'is_not_empty'
  | 'is_checked'
  | 'is_unchecked';

export interface DatabaseFilter {
  id: string;
  /** Property to test. The reserved id {@link TITLE_PROPERTY_ID} targets the page name. */
  propertyId: string;
  operator: FilterOperator;
  value?: unknown;
}

export type SortDirection = 'asc' | 'desc';

export interface DatabaseSort {
  propertyId: string;
  direction: SortDirection;
}

/** A saved presentation of the database: a layout plus its filters and sorts. */
export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  filters: DatabaseFilter[];
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
  /** Date property positioning rows on the month grid (`calendar`). */
  datePropertyId?: string;
  /** Per-column footer summaries (table), keyed by property id (or {@link TITLE_PROPERTY_ID}). */
  summaries?: Record<string, SummaryType>;
}

/** The full editable definition of a database: its columns and its views. */
export interface DatabaseSchema {
  properties: DatabaseProperty[];
  views: DatabaseView[];
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
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a row (a new page inside the database). */
export interface RowInput {
  name?: string | null;
  properties?: Record<string, unknown>;
  data?: PageSnapshot;
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

/**
 * The friendly value a `formula` reads when it references another property by
 * name: a `select` resolves to its option *label* (not the opaque id), a
 * verification to its boolean flag, multi-selects/relations to a comma list. So
 * `prop("Status")` in a formula sees `"Done"`, matching what the cell shows.
 */
function formulaFacingValue(row: DatabaseRow, property: DatabaseProperty): unknown {
  switch (property.type) {
  case 'select': {
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
function rowFormulaResolver(row: DatabaseRow, properties: DatabaseProperty[]): FormulaResolver {
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
): unknown {
  if (property === TITLE_PROPERTY_ID) return row.name ?? '';
  if (property.type === 'expr') return row.exports[property.cellName ?? property.name];
  if (property.type === 'formula') {
    if (!properties) return undefined;
    return evaluateFormula(property.formula ?? '', rowFormulaResolver(row, properties));
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
  return row.properties[property.id];
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const asNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

/** Evaluate a single filter against a resolved value. */
export function matchesFilter(operator: FilterOperator, cell: unknown, target: unknown): boolean {
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
  case 'gt':
    return asNumber(cell) > asNumber(target);
  case 'lt':
    return asNumber(cell) < asNumber(target);
  case 'gte':
    return asNumber(cell) >= asNumber(target);
  case 'lte':
    return asNumber(cell) <= asNumber(target);
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
 * Apply a view's filters and sorts to a row set, returning a new array. Filters
 * are ANDed; sorts are applied in order (first sort is primary). Pure and
 * side-effect free so it can run identically on the server or in the table UI.
 */
export function applyView(rows: DatabaseRow[], view: DatabaseView, properties: DatabaseProperty[]): DatabaseRow[] {
  const filtered = rows.filter((row) =>
    (view.filters ?? []).every((filter) => {
      const prop = propertyById(properties, filter.propertyId);
      if (!prop) return true;
      return matchesFilter(filter.operator, rowValue(row, prop, properties), filter.value);
    }),
  );

  const sorts = view.sorts ?? [];
  if (sorts.length === 0) return filtered;

  // Stable multi-key sort: index-tagged to keep equal rows in original order.
  return filtered
    .map((row, index) => ({row, index}))
    .sort((a, b) => {
      for (const sort of sorts) {
        const prop = propertyById(properties, sort.propertyId);
        if (!prop) continue;
        const cmp = compareValues(rowValue(a.row, prop, properties), rowValue(b.row, prop, properties));
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
    // Default the grouping to the first select property (kanban columns / chart
    // categories read best off a select), falling back to any property.
    const select = properties.find((p) => p.type === 'select');
    view.groupByPropertyId = (select ?? properties[0])?.id;
  }
  if (type === 'calendar') {
    const date = properties.find((p) => p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time');
    view.datePropertyId = date?.id;
  }
  return view;
}

// ── Number formatting ────────────────────────────────────────────────────────

const FORMAT_PREFIX: Partial<Record<NumberFormat, string>> = {dollar: '$', euro: '€'};

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
  case 'dollar':
  case 'euro':
    return `${FORMAT_PREFIX[format]}${n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  default:
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  }
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
  if (property.type === 'select') {
    return property.options?.find((o) => o.id === row.properties[property.id])?.label ?? '';
  }
  if (v instanceof FormulaError) return v.message;
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

  if (property.type === 'select') {
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
    .map((r) => rowValue(r, prop, properties))
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
  const group = properties.find((p) => p.id === view.groupByPropertyId);
  const agg: ChartAggregate = view.aggregate ?? {type: 'count'};
  return groupRows(rows, group, properties).map((g) => ({
    key: g.key,
    label: g.label,
    color: g.color,
    value: foldAggregate(g.rows, agg, properties),
  }));
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

  const values = rows.map((r) => rowValue(r, property, properties));
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
