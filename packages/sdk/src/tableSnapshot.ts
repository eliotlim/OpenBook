/**
 * Table STRUCTURE ops over a stored page snapshot (API-3).
 *
 * The editor owns the live-document versions of these ops (`packages/ui/src/
 * blockeditor/model.ts` — `tableInsertRow`, `tableMoveColumn`, …), which mutate a
 * Y.Doc inside one transaction. This module is their SERVER-SIDE twin: the same
 * seven structural ops (plus cell text and row/column tints) applied to the
 * `blockdoc` JSON projection, for the paths that have no live editor — the MCP
 * write tools, and the agent bridge's stored-page fallback.
 *
 * ── THE `col:` / `ord` DECISION ──────────────────────────────────────────────
 * A keyed table carries FRACTIONAL ORDER KEYS: `table.props['col:<colId>']` per
 * column and `row.props.ord` per row (see the model's table contract). Render
 * order is those keys sorted — never array order. A table built by
 * `append_blocks` has NO keys (an MCP client can't invent them), so it is a
 * "legacy" table that renders in array order until something migrates it.
 *
 * These ops MIGRATE EAGERLY: every op runs {@link ensureSnapshotTableOrder}
 * first — a line-for-line mirror of the editor's `ensureTableOrderInTx`, using
 * the SAME shared key algebra (`./orderKeys`, which the editor now imports from
 * here) and the SAME deterministic column ids (`c0…cN-1`) and
 * `keysBetween(null, null, n)` spread. So a table migrated by an MCP op and the
 * same table migrated by the editor end up with IDENTICAL keys.
 *
 * We do NOT take the alternative — "stay positional and let
 * `ensureTableOrderInTx` migrate later" — because three of the ops
 * (`move_row`, `move_column`, and every insert) are DEFINED as order-key edits.
 * A positional-only snapshot op would have to reorder the arrays instead, which
 * (a) gives a different result than the editor for an already-keyed table, and
 * (b) rewrites nodes a concurrent peer is editing, losing the ops' convergence
 * property. Migrating first costs one deterministic pass and makes the editor,
 * agent-proposal and snapshot paths produce the same grid — which is exactly
 * what the cross-path invariant test asserts.
 *
 * Ops here mutate a DEEP COPY of the snapshot's blocks and drop the stale CRDT
 * `update` (like every other snapshot writer), so the next reader rebuilds from
 * the projection.
 */

import {shortId} from './database';
import {isOrderKey, keyBetween, keysBetween, ORDER_KEY_REBALANCE_LENGTH} from './orderKeys';
import type {PageSnapshot} from './types';

/** Prefix of the column-registry entries in a table block's props. */
export const TABLE_COL_PREFIX = 'col:';

/** Prefix of the per-column colour entries (`colbg:<colId>` → palette token). */
export const TABLE_COLBG_PREFIX = 'colbg:';

/** One block of the `blockdoc` JSON projection, as these ops mutate it. */
export interface SnapshotBlock {
  id?: string;
  type?: string;
  text?: Array<{t: string; a?: Record<string, unknown>}>;
  props?: Record<string, unknown>;
  children?: SnapshotBlock[];
}

// ── The op vocabulary (shared with the agent proposals + the MCP tools) ────────

/**
 * The structural table ops, named exactly as the agent proposal kinds and the
 * MCP tool names — one vocabulary across the editor bridge, the agent, and MCP.
 */
export type TableOpKind =
  | 'table_insert_row'
  | 'table_delete_row'
  | 'table_duplicate_row'
  | 'table_insert_column'
  | 'table_delete_column'
  | 'table_move_row'
  | 'table_move_column'
  | 'table_set_cell'
  | 'table_set_row_color'
  | 'table_set_column_color';

/** Every {@link TableOpKind}, for schema/description generation. */
export const TABLE_OP_KINDS: readonly TableOpKind[] = [
  'table_insert_row',
  'table_delete_row',
  'table_duplicate_row',
  'table_insert_column',
  'table_delete_column',
  'table_move_row',
  'table_move_column',
  'table_set_cell',
  'table_set_row_color',
  'table_set_column_color',
];

/**
 * A table op with its coordinates already RESOLVED to SORTED (render-order)
 * indices — the same coordinate space as the editor's `cellPosition`. Id-based
 * addressing (a cell id, a row id, a column id) is resolved to these indices by
 * {@link resolveTableOp} before validation, so bounds errors read the same
 * whichever way the caller addressed the table.
 */
export interface TableOpRequest {
  kind: TableOpKind;
  /** Sorted row index (row-axis ops, and `table_set_cell`). */
  rowIndex?: number;
  /** Sorted column index (column-axis ops, and `table_set_cell`). */
  colIndex?: number;
  /** Move target, a sorted index counted with the moved row/column REMOVED. */
  toIndex?: number;
  /** New plain text (`table_set_cell`). */
  text?: string;
  /** Palette token, or null to clear (`table_set_row_color` / `..._column_color`). */
  color?: string | null;
}

/** The dimensions an op is validated against (from the SORTED grid). */
export interface TableShape {
  rows: number;
  cols: number;
  /** The table's `header` prop — sorted row 0 renders as the header row. */
  header: boolean;
}

const ordinal = (n: number): string => `${n}`;

/**
 * Validate a resolved op against the table's shape — the ONE definition of the
 * table ops' server-side invariants, shared by the agent bridge and the MCP
 * tools so both refuse exactly the same requests with exactly the same words.
 * Returns an actionable message, or null when the op is legal.
 *
 * Mirrors the editor's context-menu guards (`BlockEditor.tsx`,
 * `TableCellMenuContent`):
 *  · insert-row-above is HIDDEN on the header row, because rendering is
 *    positional — the blank new row would become the header and silently demote
 *    the real one. Here that is a refusal, not a silent clamp.
 *  · move up/down and move left/right are DISABLED at the extremes, which is the
 *    same thing as a target index outside `0…n-1`.
 *  · row 0 is otherwise an ordinary row: it can be deleted, duplicated, tinted,
 *    and another row may be MOVED into position 0 (that promotes it to header —
 *    the documented behaviour of contract note 5).
 * Unlike the editor's ops (which CLAMP indices and no-op on a miss), these
 * refuse: a remote caller that mis-addresses a table should hear about it rather
 * than have the edit land somewhere else.
 */
export function tableOpError(shape: TableShape, op: TableOpRequest): string | null {
  const {rows, cols, header} = shape;
  const int = (v: number | undefined, name: string): string | null =>
    typeof v !== 'number' || !Number.isInteger(v) ? `${name} must be an integer.` : null;
  const inRange = (v: number, name: string, max: number): string | null =>
    v < 0 || v > max ? `${name} ${ordinal(v)} is out of range — this table has ${rows} row(s) and ${cols} column(s).` : null;

  switch (op.kind) {
  case 'table_insert_row': {
    const bad = int(op.rowIndex, 'rowIndex') ?? inRange(op.rowIndex!, 'rowIndex', rows);
    if (bad) return bad;
    if (header && op.rowIndex === 0) {
      return 'Cannot insert a row above the header row — rendering is positional, so the new blank row would become the header. Insert at rowIndex 1 to add a row directly below the header.';
    }
    return null;
  }
  case 'table_insert_column':
    return int(op.colIndex, 'colIndex') ?? inRange(op.colIndex!, 'colIndex', cols);
  case 'table_delete_row':
  case 'table_duplicate_row':
  case 'table_set_row_color':
    return int(op.rowIndex, 'rowIndex') ?? inRange(op.rowIndex!, 'rowIndex', rows - 1);
  case 'table_delete_column':
  case 'table_set_column_color':
    return int(op.colIndex, 'colIndex') ?? inRange(op.colIndex!, 'colIndex', cols - 1);
  case 'table_move_row': {
    const bad =
      int(op.rowIndex, 'rowIndex') ??
      inRange(op.rowIndex!, 'rowIndex', rows - 1) ??
      int(op.toIndex, 'toIndex') ??
      inRange(op.toIndex!, 'toIndex', rows - 1);
    return bad;
  }
  case 'table_move_column':
    return (
      int(op.colIndex, 'colIndex') ??
      inRange(op.colIndex!, 'colIndex', cols - 1) ??
      int(op.toIndex, 'toIndex') ??
      inRange(op.toIndex!, 'toIndex', cols - 1)
    );
  case 'table_set_cell': {
    const bad =
      int(op.rowIndex, 'rowIndex') ??
      inRange(op.rowIndex!, 'rowIndex', rows - 1) ??
      int(op.colIndex, 'colIndex') ??
      inRange(op.colIndex!, 'colIndex', cols - 1);
    if (bad) return bad;
    return typeof op.text === 'string' ? null : 'text must be a string.';
  }
  default:
    return `Unknown table op "${String((op as {kind?: unknown}).kind)}".`;
  }
}

/** True for the two ops whose "last one" case removes the whole table block. */
export function tableOpRemovesTable(shape: TableShape, op: TableOpRequest): boolean {
  return (op.kind === 'table_delete_row' && shape.rows === 1) || (op.kind === 'table_delete_column' && shape.cols === 1);
}

// ── The sorted grid over the JSON projection (mirrors model.ts `tableGrid`) ────

const propOf = (b: SnapshotBlock, key: string): unknown => b.props?.[key];

const strProp = (b: SnapshotBlock, key: string): string | null => {
  const v = propOf(b, key);
  return typeof v === 'string' && v.length > 0 ? v : null;
};

const setProp = (b: SnapshotBlock, key: string, value: unknown): void => {
  if (value === undefined) {
    if (b.props) delete b.props[key];
    return;
  }
  b.props = {...(b.props ?? {}), [key]: value};
};

const kids = (b: SnapshotBlock): SnapshotBlock[] => {
  b.children = b.children ?? [];
  return b.children;
};

/** The table's column registry, sorted into render order (key, then id). */
export function snapshotTableColumns(table: SnapshotBlock): Array<{id: string; key: string}> {
  const out: Array<{id: string; key: string}> = [];
  for (const [k, v] of Object.entries(table.props ?? {})) {
    if (k.startsWith(TABLE_COL_PREFIX) && typeof v === 'string' && v.length > 0) {
      out.push({id: k.slice(TABLE_COL_PREFIX.length), key: v});
    }
  }
  out.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The sorted grid view of a snapshot table — mirrors the model's `TableGrid`. */
export interface SnapshotTableGrid {
  keyed: boolean;
  rows: SnapshotBlock[];
  colIds: string[];
  /** `cells[r][c]`, null for a merge gap (exactly like the model's grid). */
  cells: (SnapshotBlock | null)[][];
  width: number;
}

export function snapshotTableGrid(table: SnapshotBlock): SnapshotTableGrid {
  const rawRows = [...(table.children ?? [])];
  const columns = snapshotTableColumns(table);
  const keyed = columns.length > 0;

  const rows = rawRows
    .map((b, i) => ({b, i, k: strProp(b, 'ord')}))
    .sort((x, y) => {
      if (x.k !== null && y.k !== null) {
        if (x.k !== y.k) return x.k < y.k ? -1 : 1;
        const xi = x.b.id ?? '';
        const yi = y.b.id ?? '';
        if (xi !== yi) return xi < yi ? -1 : 1;
        return x.i - y.i;
      }
      if (x.k !== null) return -1;
      if (y.k !== null) return 1;
      return x.i - y.i;
    })
    .map((e) => e.b);

  const colIndex = new Map(columns.map((c, i) => [c.id, i]));
  const cells: (SnapshotBlock | null)[][] = rows.map((row) => {
    const raw = [...(row.children ?? [])];
    if (!keyed) return raw;
    const slots: (SnapshotBlock | null)[] = columns.map(() => null);
    const loose: SnapshotBlock[] = [];
    for (const cell of raw) {
      const col = strProp(cell, 'col');
      if (col === null) {
        loose.push(cell);
      } else {
        const idx = colIndex.get(col);
        if (idx === undefined) continue; // column deleted concurrently → hidden
        if (slots[idx] === null) slots[idx] = cell;
        else loose.push(cell);
      }
    }
    let s = 0;
    for (const cell of loose) {
      while (s < slots.length && slots[s] !== null) s += 1;
      if (s < slots.length) slots[s] = cell;
      else slots.push(cell);
    }
    return slots;
  });

  const width = cells.reduce((m, r) => Math.max(m, r.length), 0);
  return {keyed, rows, colIds: columns.map((c) => c.id), cells, width};
}

/**
 * Lazy migration + backfill of a snapshot table's order keys — the mirror of the
 * editor's `ensureTableOrderInTx`, deterministic in exactly the same way so a
 * migration performed here and one performed in the editor converge. Idempotent.
 */
export function ensureSnapshotTableOrder(table: SnapshotBlock): void {
  const rawRows = [...(table.children ?? [])];

  if (snapshotTableColumns(table).length === 0) {
    const width = Math.max(1, ...rawRows.map((r) => r.children?.length ?? 0));
    const colIds = Array.from({length: width}, (_, i) => `c${i}`);
    const colKeys = keysBetween(null, null, width);
    colIds.forEach((id, i) => setProp(table, TABLE_COL_PREFIX + id, colKeys[i]));
    const rowKeys = keysBetween(null, null, rawRows.length);
    rawRows.forEach((row, r) => {
      if (strProp(row, 'ord') === null) setProp(row, 'ord', rowKeys[r]);
      const cells = row.children ?? [];
      for (let c = 0; c < cells.length && c < width; c += 1) {
        if (cells[c].type === 'cell' && strProp(cells[c], 'col') === null) setProp(cells[c], 'col', colIds[c]);
      }
    });
    return;
  }

  const grid = snapshotTableGrid(table);
  let prev: string | null = null;
  for (const row of grid.rows) {
    const k = strProp(row, 'ord');
    if (k !== null) {
      prev = k;
      continue;
    }
    if (prev !== null && !isOrderKey(prev)) {
      const keys = keysBetween(null, null, grid.rows.length);
      grid.rows.forEach((r, i) => setProp(r, 'ord', keys[i]));
      break;
    }
    const next = keyBetween(prev, null);
    setProp(row, 'ord', next);
    prev = next;
  }
  const columns = snapshotTableColumns(table);
  const colIds = columns.map((c) => c.id);
  let lastKey: string | null = columns.length > 0 ? columns[columns.length - 1].key : null;
  const maxSlots = grid.cells.reduce((m, r) => Math.max(m, r.length), 0);
  if (colIds.length < maxSlots && lastKey !== null && !isOrderKey(lastKey)) {
    const keys = keysBetween(null, null, columns.length);
    columns.forEach((col, i) => setProp(table, TABLE_COL_PREFIX + col.id, keys[i]));
    lastKey = keys[keys.length - 1] ?? null;
  }
  while (colIds.length < maxSlots) {
    const id = shortId('col');
    lastKey = keyBetween(lastKey, null);
    setProp(table, TABLE_COL_PREFIX + id, lastKey);
    colIds.push(id);
  }
  grid.cells.forEach((slots) => {
    slots.forEach((cell, c) => {
      if (cell && cell.type === 'cell' && strProp(cell, 'col') === null && c < colIds.length) {
        setProp(cell, 'col', colIds[c]);
      }
    });
  });
}

/** A key between two bounds, or null when the axis needs a rebalance. */
function insertionKey(before: string | null, after: string | null): string | null {
  if (before !== null && after !== null && before >= after) return null;
  try {
    const key = keyBetween(before, after);
    return key.length > ORDER_KEY_REBALANCE_LENGTH ? null : key;
  } catch {
    return null;
  }
}

// ── Reading a snapshot's tables ───────────────────────────────────────────────

const runsText = (b: SnapshotBlock): string => (Array.isArray(b.text) ? b.text.map((r) => r.t).join('') : '');

function blockdocBlocks(data: PageSnapshot | null | undefined): SnapshotBlock[] | null {
  if (!data || data.editor !== 'blocks') return null;
  const bd = data.blockdoc as {blocks?: SnapshotBlock[]} | undefined;
  return bd?.blocks ?? [];
}

/** Depth-first search for a block by id, plus the list it lives in. */
function locate(
  list: SnapshotBlock[],
  id: string,
): {block: SnapshotBlock; parent: SnapshotBlock[]; index: number} | null {
  for (const [i, b] of list.entries()) {
    if (b.id === id) return {block: b, parent: list, index: i};
    if (b.children) {
      const hit = locate(b.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The block whose `children` contain `id`, at any depth. */
function parentOf(list: SnapshotBlock[], id: string): SnapshotBlock | null {
  for (const b of list) {
    if (!b.children) continue;
    if (b.children.some((c) => c.id === id)) return b;
    const deeper = parentOf(b.children, id);
    if (deeper) return deeper;
  }
  return null;
}

/** The `table` block a `cell` id sits in, with its owning `row`. */
function cellHome(blocks: SnapshotBlock[], cellId: string): {row: SnapshotBlock; table: SnapshotBlock} | null {
  const row = parentOf(blocks, cellId);
  if (!row || row.type !== 'row' || !row.id) return null;
  const table = parentOf(blocks, row.id);
  if (!table || table.type !== 'table' || !table.id) return null;
  return {row, table};
}

/** A read-only projection of a table for inspection + op resolution. */
export interface SnapshotTableView {
  tableId: string;
  header: boolean;
  rows: number;
  cols: number;
  /** Row block ids in SORTED order. */
  rowIds: string[];
  /** Column ids in SORTED order (empty for a not-yet-migrated legacy table). */
  colIds: string[];
  /** Cell block ids in SORTED order; null for a merge gap. */
  cellIds: (string | null)[][];
  /** Cell plain text in SORTED order; '' for a merge gap. */
  cells: string[][];
}

/**
 * Read a table by id from a page snapshot, in SORTED render order. Read-only —
 * it never migrates (like the model's `cellPosition`), so `colIds` is empty for
 * a legacy table even though `cols` already reports its rendered width. Returns
 * null when `tableId` isn't a `table` block on the page.
 */
export function snapshotTableView(data: PageSnapshot | null | undefined, tableId: string): SnapshotTableView | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  const hit = locate(blocks, tableId);
  if (!hit || hit.block.type !== 'table') return null;
  const grid = snapshotTableGrid(hit.block);
  return {
    tableId,
    header: propOf(hit.block, 'header') === true,
    rows: grid.rows.length,
    cols: grid.width,
    rowIds: grid.rows.map((r) => r.id ?? ''),
    colIds: grid.colIds,
    cellIds: grid.cells.map((row) => row.map((c) => c?.id ?? null)),
    cells: grid.cells.map((row) => row.map((c) => (c ? runsText(c) : ''))),
  };
}

/** Grid coordinates of a cell id — the snapshot mirror of `cellPosition`. */
export function snapshotCellPosition(
  data: PageSnapshot | null | undefined,
  cellId: string,
): {tableId: string; row: number; col: number; rows: number; cols: number} | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  const cell = locate(blocks, cellId);
  if (!cell || cell.block.type !== 'cell') return null;
  const home = cellHome(blocks, cellId);
  if (!home) return null;
  const grid = snapshotTableGrid(home.table);
  const r = grid.rows.indexOf(home.row);
  if (r < 0) return null;
  const c = grid.cells[r].indexOf(cell.block);
  if (c < 0) return null;
  return {tableId: home.table.id!, row: r, col: c, rows: grid.rows.length, cols: grid.width};
}

/** The id of the table that contains `blockId` (a table, row, or cell id). */
export function snapshotTableIdFor(data: PageSnapshot | null | undefined, blockId: string): string | null {
  const blocks = blockdocBlocks(data);
  if (!blocks) return null;
  const hit = locate(blocks, blockId);
  if (!hit) return null;
  if (hit.block.type === 'table') return blockId;
  if (hit.block.type === 'row') {
    const table = parentOf(blocks, blockId);
    return table?.type === 'table' ? (table.id ?? null) : null;
  }
  if (hit.block.type === 'cell') return cellHome(blocks, blockId)?.table.id ?? null;
  return null;
}

// ── Id → sorted-index resolution ─────────────────────────────────────────────

/** How a caller addressed a table op: sorted indices and/or block ids. */
export interface TableOpAddress {
  rowIndex?: number;
  colIndex?: number;
  toIndex?: number;
  /** A cell id — resolves BOTH `rowIndex` and `colIndex`. */
  cellId?: string;
  /** A row block id — resolves `rowIndex`. */
  rowId?: string;
  /** A column id (from `col:<id>` / a cell's `col` prop) — resolves `colIndex`. */
  colId?: string;
  text?: string;
  color?: string | null;
}

/**
 * Resolve id-based addressing to SORTED indices against a table view. An id that
 * isn't in this table is an error, never a silent fallback.
 *
 * Precedence: for ops that TARGET AN EXISTING NODE, an id wins over the matching
 * index — the id is that node's identity, so a caller who sent both meant the
 * node. For the two INSERT ops the index is a POSITION, not a node, so an id
 * there only serves to name the table and never overrides the position (a
 * `cellId` on `table_insert_row` means "the table this cell is in", not "insert
 * at this cell's row").
 */
export function resolveTableOp(
  view: SnapshotTableView,
  kind: TableOpKind,
  address: TableOpAddress,
): {op: TableOpRequest} | {error: string} {
  const op: TableOpRequest = {kind, rowIndex: address.rowIndex, colIndex: address.colIndex, toIndex: address.toIndex};
  if (address.text !== undefined) op.text = address.text;
  if (address.color !== undefined) op.color = address.color;
  const positional = kind === 'table_insert_row' || kind === 'table_insert_column';

  if (address.cellId !== undefined) {
    let foundRow = -1;
    let foundCol = -1;
    for (let r = 0; r < view.cellIds.length && foundRow < 0; r += 1) {
      const c = view.cellIds[r].indexOf(address.cellId);
      if (c >= 0) {
        foundRow = r;
        foundCol = c;
      }
    }
    if (foundRow < 0) return {error: `No cell "${address.cellId}" in table ${view.tableId} — use inspect_table.`};
    if (!positional) {
      op.rowIndex = foundRow;
      op.colIndex = foundCol;
    }
  }
  if (address.rowId !== undefined) {
    const r = view.rowIds.indexOf(address.rowId);
    if (r < 0) return {error: `No row "${address.rowId}" in table ${view.tableId} — use inspect_table.`};
    if (!positional) op.rowIndex = r;
  }
  if (address.colId !== undefined) {
    const c = view.colIds.indexOf(address.colId);
    if (c < 0) return {error: `No column "${address.colId}" in table ${view.tableId} — use inspect_table.`};
    if (!positional) op.colIndex = c;
  }
  return {op};
}

/** The shape an op is validated against, from a read view. */
export const tableShapeOf = (view: SnapshotTableView): TableShape => ({rows: view.rows, cols: view.cols, header: view.header});

// ── Applying an op ───────────────────────────────────────────────────────────

const newCell = (colId: string): SnapshotBlock => ({id: shortId('b'), type: 'cell', props: {col: colId}});

/** Deep-clone the projection so callers keep an untouched snapshot. */
const cloneBlocks = (blocks: SnapshotBlock[]): SnapshotBlock[] => JSON.parse(JSON.stringify(blocks)) as SnapshotBlock[];

/**
 * Apply ONE resolved table op to a page snapshot, returning the new snapshot.
 * Coordinates are SORTED indices ({@link resolveTableOp} turns ids into them);
 * validate with {@link tableOpError} first — this function assumes a legal op
 * and clamps like the editor rather than reporting.
 *
 * Returns null when `tableId` isn't a table on the page. `removedTable` is true
 * when the op deleted the LAST row or column, which removes the whole table
 * block — the editor's behaviour (`tableDeleteRow` / `tableDeleteColumn`), kept
 * identical here so the three paths can't diverge.
 */
export function applyTableOpToSnapshot(
  data: PageSnapshot,
  tableId: string,
  op: TableOpRequest,
): {data: PageSnapshot; removedTable: boolean} | null {
  const source = blockdocBlocks(data);
  if (!source) return null;
  const blocks = cloneBlocks(source);
  const hit = locate(blocks, tableId);
  if (!hit || hit.block.type !== 'table') return null;
  const table = hit.block;

  ensureSnapshotTableOrder(table);
  let removedTable = false;
  const grid = snapshotTableGrid(table);
  const rowsArr = kids(table);

  switch (op.kind) {
  case 'table_insert_row': {
    const at = Math.max(0, Math.min(op.rowIndex ?? 0, grid.rows.length));
    const before = at > 0 ? strProp(grid.rows[at - 1], 'ord') : null;
    const after = at < grid.rows.length ? strProp(grid.rows[at], 'ord') : null;
    let ord = insertionKey(before, after);
    if (ord === null) {
      const keys = keysBetween(null, null, grid.rows.length + 1);
      grid.rows.forEach((row, i) => setProp(row, 'ord', keys[i < at ? i : i + 1]));
      ord = keys[at];
    }
    rowsArr.splice(Math.min(at, rowsArr.length), 0, {
      id: shortId('b'),
      type: 'row',
      props: {ord},
      children: snapshotTableColumns(table).map((c) => newCell(c.id)),
    });
    break;
  }
  case 'table_duplicate_row': {
    const from = op.rowIndex ?? 0;
    const source_ = grid.rows[from];
    const before = strProp(source_, 'ord');
    const after = from + 1 < grid.rows.length ? strProp(grid.rows[from + 1], 'ord') : null;
    let ord = insertionKey(before, after);
    if (ord === null) {
      const keys = keysBetween(null, null, grid.rows.length + 1);
      grid.rows.forEach((row, i) => setProp(row, 'ord', keys[i <= from ? i : i + 1]));
      ord = keys[from + 1];
    }
    const columns = snapshotTableColumns(table);
    const children = columns.map((c, i) => {
      const src = grid.cells[from][i];
      return src && src.type === 'cell'
        ? {id: shortId('b'), type: 'cell', ...(src.text ? {text: JSON.parse(JSON.stringify(src.text)) as SnapshotBlock['text']} : {}), props: {...(src.props ?? {}), col: c.id}}
        : newCell(c.id);
    });
    const arrayIndex = rowsArr.indexOf(source_);
    const at = arrayIndex >= 0 ? arrayIndex + 1 : rowsArr.length;
    rowsArr.splice(Math.min(at, rowsArr.length), 0, {id: shortId('b'), type: 'row', props: {...(source_.props ?? {}), ord}, children});
    break;
  }
  case 'table_insert_column': {
    const columns = snapshotTableColumns(table);
    const at = Math.max(0, Math.min(op.colIndex ?? 0, columns.length));
    const before = at > 0 ? columns[at - 1].key : null;
    const after = at < columns.length ? columns[at].key : null;
    let key = insertionKey(before, after);
    if (key === null) {
      const keys = keysBetween(null, null, columns.length + 1);
      columns.forEach((c, i) => setProp(table, TABLE_COL_PREFIX + c.id, keys[i < at ? i : i + 1]));
      key = keys[at];
    }
    const id = shortId('col');
    setProp(table, TABLE_COL_PREFIX + id, key);
    for (const row of rowsArr) {
      const cells = kids(row);
      cells.splice(Math.max(0, Math.min(at, cells.length)), 0, newCell(id));
    }
    break;
  }
  case 'table_delete_row': {
    const at = op.rowIndex ?? 0;
    if (grid.rows.length === 1) {
      hit.parent.splice(hit.index, 1);
      removedTable = true;
      break;
    }
    const arrayIndex = rowsArr.indexOf(grid.rows[at]);
    if (arrayIndex >= 0) rowsArr.splice(arrayIndex, 1);
    break;
  }
  case 'table_delete_column': {
    const at = op.colIndex ?? 0;
    if (grid.colIds.length === 1) {
      hit.parent.splice(hit.index, 1);
      removedTable = true;
      break;
    }
    setProp(table, TABLE_COL_PREFIX + grid.colIds[at], undefined);
    setProp(table, TABLE_COLBG_PREFIX + grid.colIds[at], undefined);
    grid.rows.forEach((row, r) => {
      const cell = grid.cells[r][at];
      if (!cell) return;
      const cells = kids(row);
      const idx = cells.indexOf(cell);
      if (idx >= 0) cells.splice(idx, 1);
    });
    break;
  }
  case 'table_move_row': {
    const from = op.rowIndex ?? 0;
    const moved = grid.rows[from];
    const rest = grid.rows.filter((_, i) => i !== from);
    const at = Math.max(0, Math.min(op.toIndex ?? 0, rest.length));
    const before = at > 0 ? strProp(rest[at - 1], 'ord') : null;
    const after = at < rest.length ? strProp(rest[at], 'ord') : null;
    const ord = insertionKey(before, after);
    if (ord !== null) {
      setProp(moved, 'ord', ord);
      break;
    }
    const final = [...rest.slice(0, at), moved, ...rest.slice(at)];
    const keys = keysBetween(null, null, final.length);
    final.forEach((row, i) => setProp(row, 'ord', keys[i]));
    break;
  }
  case 'table_move_column': {
    const columns = snapshotTableColumns(table);
    const from = op.colIndex ?? 0;
    const rest = columns.filter((_, i) => i !== from);
    const at = Math.max(0, Math.min(op.toIndex ?? 0, rest.length));
    const before = at > 0 ? rest[at - 1].key : null;
    const after = at < rest.length ? rest[at].key : null;
    const key = insertionKey(before, after);
    if (key !== null) {
      setProp(table, TABLE_COL_PREFIX + columns[from].id, key);
      break;
    }
    const final = [...rest.slice(0, at), columns[from], ...rest.slice(at)];
    const keys = keysBetween(null, null, final.length);
    final.forEach((c, i) => setProp(table, TABLE_COL_PREFIX + c.id, keys[i]));
    break;
  }
  case 'table_set_cell': {
    const cell = grid.cells[op.rowIndex ?? 0]?.[op.colIndex ?? 0];
    // A merge gap has no cell node — materialize one bound to that column, so
    // set_cell can fill a ragged/legacy table instead of failing on a hole.
    if (!cell) {
      const row = grid.rows[op.rowIndex ?? 0];
      const colId = grid.colIds[op.colIndex ?? 0];
      if (row && colId) kids(row).push({...newCell(colId), text: [{t: op.text ?? ''}]});
      break;
    }
    cell.text = [{t: op.text ?? ''}];
    break;
  }
  case 'table_set_row_color': {
    const row = grid.rows[op.rowIndex ?? 0];
    if (row) setProp(row, 'bg', op.color ?? undefined);
    break;
  }
  case 'table_set_column_color': {
    const colId = grid.colIds[op.colIndex ?? 0];
    if (colId) setProp(table, TABLE_COLBG_PREFIX + colId, op.color ?? undefined);
    break;
  }
  }

  const bd = data.blockdoc as {blocks?: unknown[]; update?: string; v?: number};
  return {data: {...data, blockdoc: {...bd, update: undefined, blocks}}, removedTable};
}

/** Every `table` block on a page, in document order (for `list_tables`). */
export function snapshotTables(data: PageSnapshot | null | undefined): Array<{id: string; rows: number; cols: number; header: boolean}> {
  const blocks = blockdocBlocks(data);
  if (!blocks) return [];
  const out: Array<{id: string; rows: number; cols: number; header: boolean}> = [];
  const walk = (list: SnapshotBlock[]): void => {
    for (const b of list) {
      if (b.type === 'table' && b.id) {
        const grid = snapshotTableGrid(b);
        out.push({id: b.id, rows: grid.rows.length, cols: grid.width, header: propOf(b, 'header') === true});
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}
