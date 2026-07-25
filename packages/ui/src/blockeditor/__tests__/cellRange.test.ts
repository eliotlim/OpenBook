import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import {
  blockText,
  clearCellRange,
  createDoc,
  findBlock,
  htmlToBlocks,
  makeTable,
  normalizeCellRect,
  cellInRect,
  rootBlocks,
  tableGrid,
  tableMoveRow,
  tableMoveColumn,
  tableRangeCells,
  tableRangeRuns,
  type TextRun,
} from '../model';
import {cellRangeToHtml, cellRangeToTsv} from '../exportBlocks';

// TBL-5 — the pure range maths, clipboard serialization, single-transaction
// clear, and the paste round-trip for a copied multi-cell selection.

/** A keyed table whose cells read "r<row>c<col>" (r0 = header row). */
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

const tableBlock = (doc: Y.Doc) => findBlock(doc, 'tbl')!.block;

/** The rendered grid text (RENDER order) — sanity anchor for reorder tests. */
const renderGrid = (doc: Y.Doc): string[][] =>
  tableGrid(tableBlock(doc)).cells.map((row) => row.map((cell) => (cell ? blockText(cell)!.toString() : '')));

/** A range's runs flattened to plain-text cells (RENDER order). */
const rangeText = (doc: Y.Doc, rect: Parameters<typeof tableRangeRuns>[2]): string[][] =>
  tableRangeRuns(doc, 'tbl', rect).map((row) => row.map((cell) => cell.map((run) => run.t).join('')));

describe('normalizeCellRect + cellInRect', () => {
  it('normalises any corner order into an inclusive rectangle', () => {
    expect(normalizeCellRect({row: 2, col: 3}, {row: 0, col: 1})).toEqual({top: 0, bottom: 2, left: 1, right: 3});
    expect(normalizeCellRect({row: 1, col: 1}, {row: 1, col: 1})).toEqual({top: 1, bottom: 1, left: 1, right: 1});
  });

  it('cellInRect is inclusive on every edge', () => {
    const rect = normalizeCellRect({row: 1, col: 1}, {row: 2, col: 3});
    expect(cellInRect(rect, 1, 1)).toBe(true); // top-left corner
    expect(cellInRect(rect, 2, 3)).toBe(true); // bottom-right corner
    expect(cellInRect(rect, 0, 1)).toBe(false); // above
    expect(cellInRect(rect, 1, 0)).toBe(false); // left of
    expect(cellInRect(rect, 3, 3)).toBe(false); // below
  });
});

describe('tableRangeCells / tableRangeRuns', () => {
  it('reads a sub-rectangle in RENDER order', () => {
    const doc = seedTable();
    const rect = normalizeCellRect({row: 0, col: 0}, {row: 1, col: 1});
    expect(rangeText(doc, rect)).toEqual([
      ['r0c0', 'r0c1'],
      ['r1c0', 'r1c1'],
    ]);
    // A single cell.
    expect(rangeText(doc, normalizeCellRect({row: 2, col: 2}, {row: 2, col: 2}))).toEqual([['r2c2']]);
  });

  it('tracks positional coordinates AFTER a row reorder (sorted-vs-array trap)', () => {
    const doc = seedTable();
    // Move render row 2 to the top → grid rows become r2, r0, r1.
    tableMoveRow(doc, 'tbl', 'row2', 0);
    expect(renderGrid(doc)[0]).toEqual(['r2c0', 'r2c1', 'r2c2']);
    // The SAME coordinate rectangle now captures whatever occupies those slots.
    const rect = normalizeCellRect({row: 0, col: 0}, {row: 0, col: 2});
    expect(rangeText(doc, rect)).toEqual([['r2c0', 'r2c1', 'r2c2']]);
  });

  it('tracks positional coordinates AFTER a column reorder', () => {
    const doc = seedTable();
    tableMoveColumn(doc, 'tbl', tableGrid(tableBlock(doc)).colIds[2], 0); // col 2 → front
    const rect = normalizeCellRect({row: 1, col: 0}, {row: 1, col: 0});
    expect(rangeText(doc, rect)).toEqual([['r1c2']]);
  });

  it('emits [] for a gap (ragged short row)', () => {
    const doc = createDoc([
      {
        id: 'tbl',
        type: 'table',
        props: {header: false, 'col:c0': 'a0', 'col:c1': 'a1'},
        children: [
          {id: 'row0', type: 'row', props: {ord: 'a0'}, children: [
            {id: 'r0c0', type: 'cell', props: {col: 'c0'}, text: 'x'},
            {id: 'r0c1', type: 'cell', props: {col: 'c1'}, text: 'y'},
          ]},
          {id: 'row1', type: 'row', props: {ord: 'a1'}, children: [
            {id: 'r1c0', type: 'cell', props: {col: 'c0'}, text: 'z'},
          ]},
        ],
      },
    ]);
    const rect = normalizeCellRect({row: 0, col: 0}, {row: 1, col: 1});
    expect(rangeText(doc, rect)).toEqual([
      ['x', 'y'],
      ['z', ''], // the missing cell is an empty gap
    ]);
    expect(tableRangeCells(doc, 'tbl', rect)[1][1]).toBeNull();
  });
});

describe('clearCellRange', () => {
  it('clears every cell in the range in ONE undo step, leaving cells outside intact', () => {
    const doc = seedTable();
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local'])});
    const rect = normalizeCellRect({row: 0, col: 0}, {row: 1, col: 1});
    clearCellRange(doc, 'tbl', rect);
    expect(renderGrid(doc)).toEqual([
      ['', '', 'r0c2'],
      ['', '', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
    // Single undo restores every cleared cell at once.
    undo.undo();
    expect(renderGrid(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });
});

describe('clipboard serialization', () => {
  const grid: TextRun[][][] = [
    [[{t: 'A1'}], [{t: 'B1'}]],
    [[{t: 'A2'}], [{t: 'B2', a: {b: true}}]],
  ];

  it('cellRangeToTsv joins with tabs + newlines', () => {
    expect(cellRangeToTsv(grid)).toBe('A1\tB1\nA2\tB2');
  });

  it('cellRangeToTsv collapses embedded tabs/newlines to a space', () => {
    expect(cellRangeToTsv([[[{t: 'a\tb'}], [{t: 'c\nd'}]]])).toBe('a b\tc d');
  });

  it('cellRangeToHtml preserves inline formatting', () => {
    const html = cellRangeToHtml(grid);
    expect(html).toContain('<table');
    expect(html).toContain('<td>A1</td>');
    expect(html).toContain('<strong>B2</strong>');
  });

  it('round-trips: copied HTML pastes back as a table with the same grid', () => {
    const blocks = htmlToBlocks(cellRangeToHtml(grid));
    const table = blocks.find((b) => b.type === 'table');
    expect(table).toBeTruthy();
    const text = (table!.children ?? []).map((row) =>
      (row.children ?? []).map((cell) => (Array.isArray(cell.text) ? cell.text.map((r) => r.t).join('') : String(cell.text ?? ''))),
    );
    expect(text).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);
  });
});
