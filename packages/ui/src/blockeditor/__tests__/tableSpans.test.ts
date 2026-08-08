import {describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {
  blockId,
  blockProp,
  blockText,
  cellNeighbor,
  createDoc,
  docToJSON,
  findBlock,
  htmlToBlocks,
  makeTable,
  setBlockProp,
  tableCellAt,
  tableDeleteColumn,
  tableDeleteRow,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMergeCells,
  tableRangeExport,
  tableSnapRectToSpans,
  tableSpans,
  tableSplitCell,
  type BlockMap,
} from '../model';
import {blocksToHtml, cellRangeExportToHtml, projectBlocksForExport} from '../exportBlocks';

const seedTable = (rows = 3, cols = 3): Y.Doc => {
  const table = makeTable(rows, cols);
  table.id = 'tbl';
  table.props = {...table.props, header: false};
  table.children = table.children!.map((row, r) => ({
    ...row,
    id: `row${r}`,
    children: row.children!.map((cell, c) => ({...cell, id: `r${r}c${c}`, text: `r${r}c${c}`})),
  }));
  return createDoc([table]);
};

const tableBlock = (doc: Y.Doc): BlockMap => findBlock(doc, 'tbl')!.block;
const textAt = (doc: Y.Doc, row: number, col: number): string | null => {
  const grid = tableGrid(tableBlock(doc));
  const cell = grid.cells[row]?.[col];
  return cell ? blockText(cell)?.toString() ?? '' : null;
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

describe('TBL-8 merge / split model', () => {
  it('merges to one anchor on the null-gap grid, moves content, and splits in one undoable op', () => {
    const doc = seedTable();
    const undo = new Y.UndoManager(doc.getArray('blocks'), {trackedOrigins: new Set(['local']), captureTimeout: 0});

    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const anchor = findBlock(doc, 'r0c0')!.block;
    expect(blockProp(anchor, 'colspan')).toBe(2);
    expect(blockProp(anchor, 'rowspan')).toBe(2);
    expect(blockText(anchor)!.toString()).toBe('r0c0\nr0c1\nr1c0\nr1c1');
    expect(tableGrid(tableBlock(doc)).cells.map((row) => row.map((cell) => cell && blockId(cell)))).toEqual([
      ['r0c0', null, 'r0c2'],
      [null, null, 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);

    undo.undo();
    expect(textAt(doc, 0, 1)).toBe('r0c1');
    undo.redo();
    tableSplitCell(doc, 'r0c0');
    const split = tableGrid(tableBlock(doc));
    expect(split.cells.every((row) => row.every(Boolean))).toBe(true);
    expect(blockText(split.cells[0][0]!)!.toString()).toContain('r1c1');
    expect(textAt(doc, 0, 1)).toBe('');
    expect(blockProp(findBlock(doc, 'r0c0')!.block, 'colspan')).toBeUndefined();
  });

  it('snaps a partial range outward to every merged cell it touches', () => {
    const doc = seedTable(4, 4);
    tableMergeCells(doc, 'tbl', {top: 1, left: 1, bottom: 2, right: 2});
    expect(tableSnapRectToSpans(tableBlock(doc), {top: 2, left: 2, bottom: 2, right: 3})).toEqual({
      top: 1,
      left: 1,
      bottom: 2,
      right: 3,
    });
  });

  it('resolves malformed/concurrent overlap deterministically without hiding real cells', () => {
    const doc = seedTable(2, 3);
    const anchor = findBlock(doc, 'r0c0')!.block;
    doc.transact(() => {
      setBlockProp(anchor, 'colspan', 3);
      // Only c1 is a gap; the real c2 cell must force the effective span short.
      const row = tableGrid(tableBlock(doc)).rows[0].get('children') as Y.Array<BlockMap>;
      const c1 = findBlock(doc, 'r0c1')!.block;
      row.delete(row.toArray().indexOf(c1), 1);
    });
    const grid = tableGrid(tableBlock(doc));
    const spans = tableSpans(grid);
    expect(spans[0][0]).toEqual({kind: 'cell', colspan: 2, rowspan: 1});
    expect(tableCellAt(grid, 0, 1, spans)).toBe(anchor);
    expect(tableCellAt(grid, 0, 2, spans)).toBe(findBlock(doc, 'r0c2')!.block);
  });
});

describe('TBL-8 span-aware structural ops and navigation', () => {
  it('extends spans when inserting strictly inside them, on both axes', () => {
    const doc = seedTable(3, 3);
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    tableInsertRow(doc, 'tbl', 1);
    tableInsertColumn(doc, 'tbl', 1);
    const grid = tableGrid(tableBlock(doc));
    const spans = tableSpans(grid);
    expect(spans[0][0]).toEqual({kind: 'cell', colspan: 3, rowspan: 3});
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) if (r !== 0 || c !== 0) expect(grid.cells[r][c]).toBeNull();
    }
  });

  it('shrinks a span on deletion and promotes an anchor with content when its row/column is deleted', () => {
    const rowDoc = seedTable(3, 3);
    tableMergeCells(rowDoc, 'tbl', {top: 0, left: 0, bottom: 2, right: 1});
    tableDeleteRow(rowDoc, 'tbl', 0);
    let grid = tableGrid(tableBlock(rowDoc));
    let spans = tableSpans(grid);
    expect(spans[0][0]).toEqual({kind: 'cell', colspan: 2, rowspan: 2});
    expect(blockText(grid.cells[0][0]!)!.toString()).toContain('r2c1');

    const colDoc = seedTable(3, 3);
    tableMergeCells(colDoc, 'tbl', {top: 0, left: 0, bottom: 1, right: 2});
    tableDeleteColumn(colDoc, 'tbl', 0);
    grid = tableGrid(tableBlock(colDoc));
    spans = tableSpans(grid);
    expect(spans[0][0]).toEqual({kind: 'cell', colspan: 2, rowspan: 2});
    expect(blockText(grid.cells[0][0]!)!.toString()).toContain('r1c2');
  });

  it('skips its own covered slots and enters a foreign span at its anchor', () => {
    const doc = seedTable();
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    expect(cellNeighbor(doc, 'r0c0', 'next')).toBe('r0c2');
    expect(cellNeighbor(doc, 'r0c2', 'prev')).toBe('r0c0');
    expect(cellNeighbor(doc, 'r0c2', 'next')).toBe('r1c2');
    expect(cellNeighbor(doc, 'r0c0', 'down')).toBe('r2c0');
    expect(cellNeighbor(doc, 'r2c1', 'up')).toBe('r0c0');
  });

  it('converges with a concurrent ordered-axis insert without hiding the inserted cells', () => {
    const a = seedTable(2, 2);
    const b = fork(a);
    tableMergeCells(a, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    tableInsertColumn(b, 'tbl', 1);
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    const realIds = tableGrid(tableBlock(a)).cells.flat().filter(Boolean).map((cell) => blockId(cell!));
    expect(realIds.length).toBeGreaterThan(1);
  });

  it('deduplicates deterministic constituent cells from concurrent splits', () => {
    const base = seedTable(2, 2);
    tableMergeCells(base, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const a = fork(base);
    const b = fork(base);
    tableSplitCell(a, 'r0c0');
    tableSplitCell(b, 'r0c0');
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    const grid = tableGrid(tableBlock(a));
    expect(grid.width).toBe(2);
    expect(grid.cells.flat().filter(Boolean)).toHaveLength(4);
    tableMergeCells(a, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    expect(tableGrid(tableBlock(a)).cells.flat().filter(Boolean)).toHaveLength(1);
  });
});

describe('TBL-8 HTML export / import', () => {
  it('round-trips colspan/rowspan and exposes spans to the static export projection', () => {
    const doc = seedTable();
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const json = docToJSON(doc);
    const html = blocksToHtml(json);
    expect(html).toContain('<td colspan="2" rowspan="2">');

    const imported = createDoc(htmlToBlocks(html));
    const importedTable = docToJSON(imported).find((block) => block.type === 'table')!;
    const anchor = importedTable.children![0].children![0];
    expect(anchor.props).toMatchObject({colspan: 2, rowspan: 2});
    expect(importedTable.children![1].children).toHaveLength(1);

    const projected = projectBlocksForExport(json).blocks.find((block) => block.type === 'table')!;
    expect((projected.data as {cellSpans: unknown[][]}).cellSpans[0][0]).toEqual({colspan: 2, rowspan: 2});
  });

  it('retains spans when copying a snapped cell range as HTML', () => {
    const doc = seedTable();
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const html = cellRangeExportToHtml(tableRangeExport(doc, 'tbl', {top: 0, left: 0, bottom: 0, right: 0}));
    expect(html).toContain('<td colspan="2" rowspan="2">');
    const imported = createDoc(htmlToBlocks(html));
    const table = docToJSON(imported).find((block) => block.type === 'table')!;
    expect(table.children![0].children![0].props).toMatchObject({colspan: 2, rowspan: 2});
  });
});
