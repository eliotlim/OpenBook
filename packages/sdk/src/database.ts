/**
 * Notion-style databases — the second unit of storage layered over {@link
 * StoredPage}. A **database** is a collection of pages (its *rows*) managed by
 * typed *properties* and presented through one or more *views* (table / list).
 *
 * Two ideas make OpenBook databases different from a plain spreadsheet:
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
 *     filter and sort on it — no formula language of its own required.
 *
 * The host page (the page that *contains* the database) is itself a regular
 * page with its own content; it merely points at the database. The database
 * record — properties, views, filters — lives in its own `databases` table.
 */

import type {PageSnapshot} from './types';

/** The value kinds a (manual) database property can hold. */
export type DatabasePropertyType = 'text' | 'number' | 'select' | 'checkbox' | 'date' | 'expr';

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
  /** Choices, for `select` properties. */
  options?: DatabaseSelectOption[];
  /** Name of the exported reactive cell to read, for `expr` properties. */
  cellName?: string;
}

/** The two row presentations the database screen supports. */
export type DatabaseViewType = 'table' | 'list';

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

/** Resolve the value a row holds for a given property (title / manual / expr). */
export function rowValue(row: DatabaseRow, property: DatabaseProperty | typeof TITLE_PROPERTY_ID): unknown {
  if (property === TITLE_PROPERTY_ID) return row.name ?? '';
  if (property.type === 'expr') return row.exports[property.cellName ?? property.name];
  return row.properties[property.id];
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '';

const asNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

/** Evaluate a single filter against a resolved value. */
export function matchesFilter(operator: FilterOperator, cell: unknown, target: unknown): boolean {
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
      return matchesFilter(filter.operator, rowValue(row, prop), filter.value);
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
        const cmp = compareValues(rowValue(a.row, prop), rowValue(b.row, prop));
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
      {id: shortId('view'), name: 'List', type: 'list', filters: [], sorts: []},
    ],
  };
}
