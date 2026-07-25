import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import {
  blockId,
  blockProp,
  createDoc,
  docToJSON,
  findBlock,
  makeTable,
  rootBlocks,
  setTableColumnColor,
  setTableRowColor,
  tableCellColor,
  tableColumnColor,
  tableColumns,
  tableDuplicateRow,
  tableGrid,
  tableInsertColumn,
  tableDeleteColumn,
  tableMoveColumn,
  tableMoveRow,
  tableRowColor,
  TABLE_COLBG_PREFIX,
  type BlockMap,
} from '../model';
import {COLOR_EXPORT_HEX} from '../colors';
import {blocksToHtml, projectBlocksForExport} from '../exportBlocks';

// ── Harness (mirrors tableOrder.test.ts) ─────────────────────────────────────

/** A 3×3 keyed table whose cells read "r<row>c<col>". */
const seedTable = (rows = 3, cols = 3): Y.Doc => {
  const table = makeTable(rows, cols);
  table.id = 'tbl';
  table.children = table.children!.map((row, r) => ({
    ...row,
    id: `row${r}`,
    children: row.children!.map((cell, c) => ({...cell, id: `r${r}c${c}`, text: `r${r}c${c}`})),
  }));
  return createDoc([table]);
};

const tableBlock = (doc: Y.Doc): BlockMap => findBlock(doc, 'tbl')!.block;
const colIdAt = (doc: Y.Doc, index: number): string => tableColumns(tableBlock(doc))[index].id;

/** The composited tint token per cell, in RENDER order. */
const tintGrid = (doc: Y.Doc): (string | null)[][] => {
  const table = tableBlock(doc);
  const grid = tableGrid(table);
  return grid.rows.map((row, r) => grid.cells[r].map((cell, c) => (cell ? tableCellColor(table, row, grid.colIds[c] ?? null) : null)));
};

const fork = (doc: Y.Doc): Y.Doc => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const sync = (a: Y.Doc, b: Y.Doc): void => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

// ── Apply / clear ────────────────────────────────────────────────────────────

describe('table colours — apply / clear', () => {
  it('sets and clears a ROW tint via the row block bg prop', () => {
    const doc = seedTable(3, 3);
    setTableRowColor(doc, 'tbl', 'row1', 'green');
    expect(tableRowColor(findBlock(doc, 'row1')!.block)).toBe('green');
    expect(tintGrid(doc)[1]).toEqual(['green', 'green', 'green']);
    // Other rows are untouched.
    expect(tintGrid(doc)[0]).toEqual([null, null, null]);

    setTableRowColor(doc, 'tbl', 'row1', null);
    expect(tableRowColor(findBlock(doc, 'row1')!.block)).toBeNull();
    expect(tintGrid(doc)[1]).toEqual([null, null, null]);
  });

  it('sets and clears a COLUMN tint via a table-level colbg:<colId> prop', () => {
    const doc = seedTable(3, 3);
    const col1 = colIdAt(doc, 1);
    setTableColumnColor(doc, 'tbl', col1, 'blue');
    expect(blockProp(tableBlock(doc), TABLE_COLBG_PREFIX + col1)).toBe('blue');
    expect(tableColumnColor(tableBlock(doc), col1)).toBe('blue');
    expect(tintGrid(doc).map((r) => r[1])).toEqual(['blue', 'blue', 'blue']);

    setTableColumnColor(doc, 'tbl', col1, null);
    expect(tableColumnColor(tableBlock(doc), col1)).toBeNull();
    expect(tintGrid(doc).map((r) => r[1])).toEqual([null, null, null]);
  });
});

// ── Precedence ───────────────────────────────────────────────────────────────

describe('table colours — precedence', () => {
  it('ROW wins over COLUMN where both apply', () => {
    const doc = seedTable(3, 3);
    const col1 = colIdAt(doc, 1);
    setTableColumnColor(doc, 'tbl', col1, 'blue');
    setTableRowColor(doc, 'tbl', 'row1', 'green');
    // row1 is all green (row wins), other rows show blue only in col 1.
    expect(tintGrid(doc)[1]).toEqual(['green', 'green', 'green']);
    expect(tintGrid(doc)[0]).toEqual([null, 'blue', null]);
    expect(tintGrid(doc)[2]).toEqual([null, 'blue', null]);
  });
});

// ── Inherit on insert ────────────────────────────────────────────────────────

describe('table colours — inherit on insert', () => {
  it('a new cell inserted into a coloured column inherits the tint', () => {
    const doc = seedTable(2, 2);
    const col1 = colIdAt(doc, 1);
    setTableColumnColor(doc, 'tbl', col1, 'red');
    tableInsertColumn(doc, 'tbl', 1); // fresh blank column at index 1, pushing col1 → 2
    // The coloured column keeps its tint at its new render position; the new
    // column is untinted. No per-cell colour was ever stored.
    const grid = tintGrid(doc);
    expect(grid[0]).toEqual([null, null, 'red']);
    expect(grid[1]).toEqual([null, null, 'red']);
  });
});

// ── Survive move ─────────────────────────────────────────────────────────────

describe('table colours — survive reorder', () => {
  it('a column tint follows the column across a move (keyed on colId)', () => {
    const doc = seedTable(3, 3);
    const col0 = colIdAt(doc, 0);
    setTableColumnColor(doc, 'tbl', col0, 'purple');
    tableMoveColumn(doc, 'tbl', col0, 2); // col0 → last
    const grid = tintGrid(doc);
    expect(grid[0]).toEqual([null, null, 'purple']);
    expect(tableColumnColor(tableBlock(doc), col0)).toBe('purple');
  });

  it('a row tint follows the row across a move', () => {
    const doc = seedTable(3, 3);
    setTableRowColor(doc, 'tbl', 'row2', 'yellow');
    tableMoveRow(doc, 'tbl', 'row2', 0);
    expect(tableGrid(tableBlock(doc)).rows.map(blockId)[0]).toBe('row2');
    expect(tintGrid(doc)[0]).toEqual(['yellow', 'yellow', 'yellow']);
  });
});

// ── Duplicate row ────────────────────────────────────────────────────────────

describe('table colours — duplicate row', () => {
  it('duplicating a coloured row keeps its row tint', () => {
    const doc = seedTable(3, 3);
    setTableRowColor(doc, 'tbl', 'row1', 'orange');
    tableDuplicateRow(doc, 'tbl', 1);
    const grid = tintGrid(doc);
    // The clone sits directly below row1 (index 2) with the same tint.
    expect(grid[1]).toEqual(['orange', 'orange', 'orange']);
    expect(grid[2]).toEqual(['orange', 'orange', 'orange']);
  });
});

// ── Delete column drops the colour entry ─────────────────────────────────────

describe('table colours — delete column cleanup', () => {
  it('deleting a coloured column removes its colbg prop (no orphan)', () => {
    const doc = seedTable(3, 3);
    const col1 = colIdAt(doc, 1);
    setTableColumnColor(doc, 'tbl', col1, 'pink');
    tableDeleteColumn(doc, 'tbl', 1);
    expect(blockProp(tableBlock(doc), TABLE_COLBG_PREFIX + col1)).toBeUndefined();
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('table colours — concurrent edits', () => {
  it('a tint stored once per row/column merges cleanly with concurrent cell edits', () => {
    const a = seedTable(3, 3);
    const b = fork(a);
    // Peer A tints a column; peer B edits a cell in that column concurrently.
    const col1 = colIdAt(a, 1);
    setTableColumnColor(a, 'tbl', col1, 'green');
    const cell = findBlock(b, 'r1c1')!.block.get('text') as Y.Text;
    b.transact(() => cell.insert(cell.length, '!'), 'local');
    sync(a, b);
    expect(tableColumnColor(tableBlock(a), col1)).toBe('green');
    expect(tintGrid(a).map((r) => r[1])).toEqual(['green', 'green', 'green']);
    // The edit survived.
    const json = docToJSON(a).find((x) => x.id === 'tbl')!;
    const text = json.children![1].children![1].text!.map((t) => t.t).join('');
    expect(text).toBe('r1c1!');
  });
});

// ── Undo ─────────────────────────────────────────────────────────────────────

describe('table colours — single undo step', () => {
  it('apply then undo removes the row tint in one step', () => {
    const doc = seedTable(3, 3);
    const row = findBlock(doc, 'row1')!.block;
    const um = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local'])});
    setTableRowColor(doc, 'tbl', 'row1', 'green');
    expect(tableRowColor(row)).toBe('green');
    um.undo();
    expect(tableRowColor(row)).toBeNull();
  });

  it('apply then undo removes the column tint in one step', () => {
    const doc = seedTable(3, 3);
    const col1 = colIdAt(doc, 1);
    const um = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local'])});
    setTableColumnColor(doc, 'tbl', col1, 'blue');
    expect(tableColumnColor(tableBlock(doc), col1)).toBe('blue');
    um.undo();
    expect(tableColumnColor(tableBlock(doc), col1)).toBeNull();
  });
});

// ── Export fidelity ──────────────────────────────────────────────────────────

describe('table colours — export', () => {
  it('clipboard HTML (blocksToHtml) carries row/column tints as hex backgrounds', () => {
    const doc = seedTable(3, 3);
    const col2 = colIdAt(doc, 2);
    setTableRowColor(doc, 'tbl', 'row1', 'green');
    setTableColumnColor(doc, 'tbl', col2, 'blue');
    const json = docToJSON(doc).find((b) => b.id === 'tbl')!;
    const html = blocksToHtml([json]);
    // Row 1 cell is green; a non-row-1 cell in col 2 is blue.
    expect(html).toContain(`background:${COLOR_EXPORT_HEX.green.hl}`);
    expect(html).toContain(`background:${COLOR_EXPORT_HEX.blue.hl}`);
  });

  it('HTML/PDF projection (projectBlocksForExport) carries a parallel cellColors grid', () => {
    const doc = seedTable(3, 3);
    const col2 = colIdAt(doc, 2);
    setTableRowColor(doc, 'tbl', 'row0', 'green');
    setTableColumnColor(doc, 'tbl', col2, 'blue');
    const out = projectBlocksForExport(docToJSON(doc));
    const table = out.blocks.find((b) => b.type === 'table')!;
    const cellColors = (table.data as {cellColors: (string | null)[][]}).cellColors;
    expect(cellColors[0]).toEqual(['green', 'green', 'green']); // row wins
    expect(cellColors.map((r) => r[2])).toEqual(['green', 'blue', 'blue']);
  });
});
