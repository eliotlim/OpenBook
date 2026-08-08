import {describe, it, expect} from 'vitest';
import {appendBlocksToSnapshot, type AppendBlock} from './content';
import type {PageSnapshot} from './types';
import {
  applyTableOpToSnapshot,
  resolveTableOp,
  snapshotCellPosition,
  snapshotTableView,
  snapshotTables,
  tableOpError,
  tableOpRemovesTable,
  tableShapeOf,
  type TableOpKind,
  type TableOpRequest,
} from './tableSnapshot';

/**
 * API-3: the SNAPSHOT twin of the editor's table ops (the MCP / no-live-editor
 * path). These tests own the SDK-level invariants:
 *  · the sorted (render-order) grid over the JSON projection;
 *  · eager `col:`/`ord` migration, so an op on an `append_blocks`-built (legacy,
 *    keyless) table is defined at all — and doesn't reshuffle the grid;
 *  · the shared bounds + header-row guards (`tableOpError`), which the agent
 *    bridge and the MCP tools both call, so the three paths refuse identically;
 *  · delete-the-last-row/column removes the whole table (editor parity).
 * Cross-path grid equality against the real CRDT ops lives in
 * `packages/ui/src/blockeditor/__tests__/tableOpParity.test.ts`.
 */

const TABLE: AppendBlock[] = [
  {
    type: 'table',
    props: {header: true},
    children: [
      {type: 'row', children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}, {type: 'cell', text: 'Price'}]},
      {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}, {type: 'cell', text: '1.20'}]},
      {type: 'row', children: [{type: 'cell', text: 'Pears'}, {type: 'cell', text: '5'}, {type: 'cell', text: '2.40'}]},
    ],
  },
];

const emptyPage = (): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: [], update: 'STALE'}} as unknown as PageSnapshot);

/** A page holding one 3×3 table at block id `t-0` (as `append_blocks` builds it). */
const tablePage = (blocks: AppendBlock[] = TABLE): PageSnapshot => appendBlocksToSnapshot(emptyPage(), blocks, 't')!;

/** Apply one op by kind + resolved/id address, returning the new snapshot. */
const run = (data: PageSnapshot, kind: TableOpKind, address: Parameters<typeof resolveTableOp>[2]): PageSnapshot => {
  const view = snapshotTableView(data, 't-0')!;
  const resolved = resolveTableOp(view, kind, address);
  if ('error' in resolved) throw new Error(resolved.error);
  const err = tableOpError(tableShapeOf(view), resolved.op);
  if (err) throw new Error(err);
  return applyTableOpToSnapshot(data, 't-0', resolved.op)!.data;
};

const cells = (data: PageSnapshot): string[][] => snapshotTableView(data, 't-0')!.cells;

describe('snapshotTableView: the sorted grid over the JSON projection', () => {
  it('reads an append_blocks table in payload order, reporting it as UNMIGRATED', () => {
    const view = snapshotTableView(tablePage(), 't-0')!;
    expect(view.rows).toBe(3);
    expect(view.cols).toBe(3);
    expect(view.header).toBe(true);
    expect(view.colIds).toEqual([]); // read-only: never migrates
    expect(view.cells).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
    ]);
  });

  it('sorts a KEYED table by `ord` / `col:` keys, not array order', () => {
    // Rows stored out of order, with keys that say the reverse.
    const data = {
      ...emptyPage(),
      blockdoc: {
        blocks: [
          {
            id: 't-0',
            type: 'table',
            props: {'col:cA': 'a', 'col:cB': 'b'},
            children: [
              {id: 'r2', type: 'row', props: {ord: 'b'}, children: [{id: 'c3', type: 'cell', props: {col: 'cB'}, text: [{t: 'four'}]}, {id: 'c4', type: 'cell', props: {col: 'cA'}, text: [{t: 'three'}]}]},
              {id: 'r1', type: 'row', props: {ord: 'a'}, children: [{id: 'c1', type: 'cell', props: {col: 'cA'}, text: [{t: 'one'}]}, {id: 'c2', type: 'cell', props: {col: 'cB'}, text: [{t: 'two'}]}]},
            ],
          },
        ],
      },
    } as unknown as PageSnapshot;
    const view = snapshotTableView(data, 't-0')!;
    expect(view.rowIds).toEqual(['r1', 'r2']);
    expect(view.cells).toEqual([['one', 'two'], ['three', 'four']]);
  });

  it('locates a cell by id in SORTED coordinates, and finds every table on the page', () => {
    const data = tablePage();
    const view = snapshotTableView(data, 't-0')!;
    const applesQty = view.cellIds[1][1]!;
    expect(snapshotCellPosition(data, applesQty)).toMatchObject({tableId: 't-0', row: 1, col: 1, rows: 3, cols: 3});
    expect(snapshotTables(data)).toEqual([{id: 't-0', rows: 3, cols: 3, header: true}]);
    expect(snapshotTableView(data, 'nope')).toBeNull();
  });
});

describe('eager col:/ord migration (the documented API-3 decision)', () => {
  it('the first op migrates a keyless table WITHOUT reshuffling the grid', () => {
    const after = run(tablePage(), 'table_insert_row', {rowIndex: 3});
    const view = snapshotTableView(after, 't-0')!;
    expect(view.colIds).toEqual(['c0', 'c1', 'c2']); // deterministic ids, editor-identical
    expect(view.cells).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
      ['', '', ''],
    ]);
    const table = (after.blockdoc as {blocks: Array<{props: Record<string, unknown>; children: Array<{props?: Record<string, unknown>}>}>}).blocks[0];
    expect(Object.keys(table.props).filter((k) => k.startsWith('col:'))).toHaveLength(3);
    expect(table.children.every((r) => typeof r.props?.ord === 'string')).toBe(true);
  });

  it('migration is idempotent — a second op mints no new columns', () => {
    const once = run(tablePage(), 'table_insert_row', {rowIndex: 3});
    const twice = run(once, 'table_insert_row', {rowIndex: 4});
    expect(snapshotTableView(twice, 't-0')!.colIds).toEqual(['c0', 'c1', 'c2']);
    expect(snapshotTableView(twice, 't-0')!.rows).toBe(5);
  });

  it('drops the stale CRDT `update` so the next reader rebuilds from the projection', () => {
    const after = run(tablePage(), 'table_insert_row', {rowIndex: 1});
    expect((after.blockdoc as {update?: string}).update).toBeUndefined();
  });

  it('leaves the input snapshot untouched (ops clone)', () => {
    const before = tablePage();
    const json = JSON.stringify(before);
    run(before, 'table_delete_row', {rowIndex: 2});
    expect(JSON.stringify(before)).toBe(json);
  });
});

describe('the seven structural ops on a snapshot', () => {
  it('insert_row / insert_column place a full-width blank line at a sorted index', () => {
    expect(cells(run(tablePage(), 'table_insert_row', {rowIndex: 1}))).toEqual([
      ['Item', 'Qty', 'Price'],
      ['', '', ''],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
    ]);
    expect(cells(run(tablePage(), 'table_insert_column', {colIndex: 1}))).toEqual([
      ['Item', '', 'Qty', 'Price'],
      ['Apples', '', '3', '1.20'],
      ['Pears', '', '5', '2.40'],
    ]);
  });

  it('delete_row / delete_column remove the right line', () => {
    expect(cells(run(tablePage(), 'table_delete_row', {rowIndex: 1}))).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Pears', '5', '2.40'],
    ]);
    expect(cells(run(tablePage(), 'table_delete_column', {colIndex: 2}))).toEqual([
      ['Item', 'Qty'],
      ['Apples', '3'],
      ['Pears', '5'],
    ]);
  });

  it('duplicate_row clones content + props with FRESH ids, directly below the source', () => {
    const after = run(tablePage(), 'table_duplicate_row', {rowIndex: 1});
    const view = snapshotTableView(after, 't-0')!;
    expect(view.cells).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
    ]);
    expect(new Set(view.rowIds).size).toBe(4);
    expect(new Set(view.cellIds.flat()).size).toBe(12);
  });

  it('duplicate_row carries the source row tint (a `bg` prop)', () => {
    const tinted = run(tablePage(), 'table_set_row_color', {rowIndex: 1, color: 'amber'});
    const after = run(tinted, 'table_duplicate_row', {rowIndex: 1});
    const rows = (after.blockdoc as {blocks: Array<{children: Array<{props?: Record<string, unknown>}>}>}).blocks[0].children;
    expect(rows.filter((r) => r.props?.bg === 'amber')).toHaveLength(2);
  });

  it('move_row / move_column reorder by REWRITING ONE key, leaving nodes in place', () => {
    const moved = run(tablePage(), 'table_move_row', {rowIndex: 2, toIndex: 1});
    expect(cells(moved)).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Pears', '5', '2.40'],
      ['Apples', '3', '1.20'],
    ]);
    // The moved row's NODE stays where it was in the array — only `ord` changed.
    const arrayOrder = (moved.blockdoc as {blocks: Array<{children: Array<{id: string}>}>}).blocks[0].children.map((r) => r.id);
    expect(snapshotTableView(moved, 't-0')!.rowIds).not.toEqual(arrayOrder);

    expect(cells(run(tablePage(), 'table_move_column', {colIndex: 0, toIndex: 2}))).toEqual([
      ['Qty', 'Price', 'Item'],
      ['3', '1.20', 'Apples'],
      ['5', '2.40', 'Pears'],
    ]);
  });

  it('move_row addressed by ROW ID resolves to the same edit as the index', () => {
    const data = tablePage();
    const rowId = snapshotTableView(data, 't-0')!.rowIds[2];
    expect(cells(run(data, 'table_move_row', {rowId, toIndex: 1}))).toEqual(cells(run(data, 'table_move_row', {rowIndex: 2, toIndex: 1})));
  });
});

describe('table_set_cell', () => {
  it('sets a cell by row/column index', () => {
    expect(cells(run(tablePage(), 'table_set_cell', {rowIndex: 1, colIndex: 2, text: '9.99'}))[1]).toEqual(['Apples', '3', '9.99']);
  });

  it('sets the SAME cell when addressed by cell id', () => {
    const data = tablePage();
    const cellId = snapshotTableView(data, 't-0')!.cellIds[2][0]!;
    expect(cells(run(data, 'table_set_cell', {cellId, text: 'Plums'}))[2]).toEqual(['Plums', '5', '2.40']);
  });

  it('fills a MERGE GAP by materializing a bound cell (ragged legacy table)', () => {
    const ragged = tablePage([
      {
        type: 'table',
        children: [
          {type: 'row', children: [{type: 'cell', text: 'a'}, {type: 'cell', text: 'b'}]},
          {type: 'row', children: [{type: 'cell', text: 'c'}]},
        ],
      },
    ]);
    expect(snapshotTableView(ragged, 't-0')!.cols).toBe(2);
    expect(cells(run(ragged, 'table_set_cell', {rowIndex: 1, colIndex: 1, text: 'd'}))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('an unknown cell id is a clean error, not a silent index fallback', () => {
    const view = snapshotTableView(tablePage(), 't-0')!;
    const resolved = resolveTableOp(view, 'table_set_cell', {cellId: 'ghost', text: 'x'});
    expect('error' in resolved && /No cell "ghost"/.test(resolved.error)).toBe(true);
  });
});

describe('addressing precedence (resolveTableOp)', () => {
  it('an id WINS over the index for a node-targeting op', () => {
    const view = snapshotTableView(tablePage(), 't-0')!;
    const resolved = resolveTableOp(view, 'table_delete_row', {rowIndex: 0, rowId: view.rowIds[2]});
    expect('op' in resolved && resolved.op.rowIndex).toBe(2);
  });

  it('an id only NAMES THE TABLE for an insert — the index is a position, not a node', () => {
    const view = snapshotTableView(tablePage(), 't-0')!;
    // A cellId at row 2 must not drag the insert position to 2.
    const row = resolveTableOp(view, 'table_insert_row', {rowIndex: 0, cellId: view.cellIds[2][1]!});
    expect('op' in row && row.op.rowIndex).toBe(0);
    const col = resolveTableOp(view, 'table_insert_column', {colIndex: 3, cellId: view.cellIds[1][0]!});
    expect('op' in col && col.op.colIndex).toBe(3);
    // …but an id that isn't in this table is still an error.
    expect('error' in resolveTableOp(view, 'table_insert_row', {rowIndex: 0, cellId: 'ghost'})).toBe(true);
  });
});

describe('row / column tints', () => {
  it('a row tint is the row block `bg`; a column tint is table `colbg:<colId>`', () => {
    const withRow = run(tablePage(), 'table_set_row_color', {rowIndex: 2, color: 'blue'});
    const rows = (withRow.blockdoc as {blocks: Array<{children: Array<{props?: Record<string, unknown>}>}>}).blocks[0].children;
    expect(rows.filter((r) => r.props?.bg === 'blue')).toHaveLength(1);

    const withCol = run(withRow, 'table_set_column_color', {colIndex: 1, color: 'green'});
    const props = (withCol.blockdoc as {blocks: Array<{props: Record<string, unknown>}>}).blocks[0].props;
    expect(props['colbg:c1']).toBe('green');

    // null CLEARS (the key is removed, not stored as null).
    const cleared = run(withCol, 'table_set_column_color', {colIndex: 1, color: null});
    expect('colbg:c1' in (cleared.blockdoc as {blocks: Array<{props: Record<string, unknown>}>}).blocks[0].props).toBe(false);
  });

  it('deleting a column drops its orphan colbg entry', () => {
    const tinted = run(tablePage(), 'table_set_column_color', {colIndex: 1, color: 'green'});
    const gone = run(tinted, 'table_delete_column', {colIndex: 1});
    expect('colbg:c1' in (gone.blockdoc as {blocks: Array<{props: Record<string, unknown>}>}).blocks[0].props).toBe(false);
  });
});

describe('editor-parity guards (tableOpError)', () => {
  const shape = {rows: 3, cols: 3, header: true};

  it('refuses inserting a row ABOVE the header row (the editor hides that item)', () => {
    expect(tableOpError(shape, {kind: 'table_insert_row', rowIndex: 0})).toMatch(/above the header row/);
    expect(tableOpError(shape, {kind: 'table_insert_row', rowIndex: 1})).toBeNull();
    // No header ⇒ row 0 is an ordinary row and inserting above it is fine.
    expect(tableOpError({...shape, header: false}, {kind: 'table_insert_row', rowIndex: 0})).toBeNull();
  });

  it('allows every other op on the header row (delete / duplicate / tint / move into 0)', () => {
    expect(tableOpError(shape, {kind: 'table_delete_row', rowIndex: 0})).toBeNull();
    expect(tableOpError(shape, {kind: 'table_duplicate_row', rowIndex: 0})).toBeNull();
    expect(tableOpError(shape, {kind: 'table_set_row_color', rowIndex: 0, color: 'amber'})).toBeNull();
    expect(tableOpError(shape, {kind: 'table_move_row', rowIndex: 2, toIndex: 0})).toBeNull();
  });

  it('reports out-of-range indices with the table dimensions', () => {
    expect(tableOpError(shape, {kind: 'table_delete_row', rowIndex: 3})).toMatch(/out of range.*3 row\(s\).*3 column\(s\)/);
    expect(tableOpError(shape, {kind: 'table_delete_column', colIndex: -1})).toMatch(/out of range/);
    expect(tableOpError(shape, {kind: 'table_set_cell', rowIndex: 1, colIndex: 9, text: 'x'})).toMatch(/out of range/);
    // Inserts accept the end position (append), deletes do not.
    expect(tableOpError(shape, {kind: 'table_insert_row', rowIndex: 3})).toBeNull();
    expect(tableOpError(shape, {kind: 'table_insert_row', rowIndex: 4})).toMatch(/out of range/);
    expect(tableOpError(shape, {kind: 'table_insert_column', colIndex: 3})).toBeNull();
  });

  it('refuses a non-integer index and a non-string cell text', () => {
    expect(tableOpError(shape, {kind: 'table_delete_row', rowIndex: 1.5})).toMatch(/must be an integer/);
    expect(tableOpError(shape, {kind: 'table_delete_row'})).toMatch(/must be an integer/);
    expect(tableOpError(shape, {kind: 'table_set_cell', rowIndex: 0, colIndex: 0})).toMatch(/text must be a string/);
  });

  it('bounds a move target by the axis WITH the moved line removed', () => {
    expect(tableOpError(shape, {kind: 'table_move_row', rowIndex: 0, toIndex: 2})).toBeNull();
    expect(tableOpError(shape, {kind: 'table_move_row', rowIndex: 0, toIndex: 3})).toMatch(/out of range/);
    expect(tableOpError(shape, {kind: 'table_move_column', colIndex: 2, toIndex: 0})).toBeNull();
  });
});

describe('last row / last column removes the whole table (editor parity)', () => {
  const oneByOne = (): PageSnapshot => tablePage([{type: 'table', children: [{type: 'row', children: [{type: 'cell', text: 'only'}]}]}]);

  it('flags and performs the removal', () => {
    const data = oneByOne();
    const view = snapshotTableView(data, 't-0')!;
    const op: TableOpRequest = {kind: 'table_delete_row', rowIndex: 0};
    expect(tableOpRemovesTable(tableShapeOf(view), op)).toBe(true);
    const out = applyTableOpToSnapshot(data, 't-0', op)!;
    expect(out.removedTable).toBe(true);
    expect(snapshotTableView(out.data, 't-0')).toBeNull();
    expect((out.data.blockdoc as {blocks: unknown[]}).blocks).toHaveLength(0);
  });

  it('the last COLUMN does the same', () => {
    const out = applyTableOpToSnapshot(oneByOne(), 't-0', {kind: 'table_delete_column', colIndex: 0})!;
    expect(out.removedTable).toBe(true);
    expect((out.data.blockdoc as {blocks: unknown[]}).blocks).toHaveLength(0);
  });

  it('is NOT flagged while more than one row/column remains', () => {
    const view = snapshotTableView(tablePage(), 't-0')!;
    expect(tableOpRemovesTable(tableShapeOf(view), {kind: 'table_delete_row', rowIndex: 0})).toBe(false);
    expect(tableOpRemovesTable(tableShapeOf(view), {kind: 'table_delete_column', colIndex: 0})).toBe(false);
  });
});

describe('non-table targets', () => {
  it('returns null for a block that is not a table, and for a legacy page', () => {
    const data = tablePage();
    expect(applyTableOpToSnapshot(data, snapshotTableView(data, 't-0')!.rowIds[0], {kind: 'table_delete_row', rowIndex: 0})).toBeNull();
    const legacy = {editorjs: {blocks: []}, values: [], names: []} as unknown as PageSnapshot;
    expect(applyTableOpToSnapshot(legacy, 't-0', {kind: 'table_delete_row', rowIndex: 0})).toBeNull();
    expect(snapshotTables(legacy)).toEqual([]);
  });
});
