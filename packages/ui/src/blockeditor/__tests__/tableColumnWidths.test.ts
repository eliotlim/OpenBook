import {describe, expect, it} from 'vitest';
import {
  blockToJSON,
  createDoc,
  findBlock,
  htmlToBlocks,
  makeTable,
  setTableColumnWidth,
  tableColumnWidth,
  tableColumns,
  tableDeleteColumn,
  tableInsertColumn,
  tableMoveColumn,
} from '../model';
import {blocksToHtml} from '../exportBlocks';

const seed = () => {
  const table = makeTable(2, 3);
  table.id = 'tbl';
  return createDoc([table]);
};

describe('table column widths (TBL-12)', () => {
  it('stores canonical widths and persists them in the document', () => {
    const doc = seed();
    const colId = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnWidth(doc, 'tbl', colId, 91.6);
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(92);
    setTableColumnWidth(doc, 'tbl', colId, 1);
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBe(48);
    setTableColumnWidth(doc, 'tbl', colId, null);
    expect(tableColumnWidth(findBlock(doc, 'tbl')!.block, colId)).toBeNull();
  });

  it('follows stable colIds across move/insert and clears only a deleted column', () => {
    const doc = seed();
    const table = findBlock(doc, 'tbl')!.block;
    const [a, b, c] = tableColumns(table).map((column) => column.id);
    setTableColumnWidth(doc, 'tbl', a, 80);
    setTableColumnWidth(doc, 'tbl', b, 120);
    tableMoveColumn(doc, 'tbl', a, 2);
    tableInsertColumn(doc, 'tbl', 1);
    expect(tableColumnWidth(table, a)).toBe(80);
    expect(tableColumnWidth(table, b)).toBe(120);
    expect(tableColumnWidth(table, c)).toBeNull();
    const bIndex = tableColumns(table).findIndex((column) => column.id === b);
    tableDeleteColumn(doc, 'tbl', bIndex);
    expect(blockToJSON(table).props?.[`colw:${b}`]).toBeUndefined();
    expect(tableColumnWidth(table, a)).toBe(80);
  });

  it('round-trips pixel widths through exported HTML colgroups', () => {
    const doc = seed();
    const table = findBlock(doc, 'tbl')!.block;
    const [a, , c] = tableColumns(table).map((column) => column.id);
    setTableColumnWidth(doc, 'tbl', a, 88);
    setTableColumnWidth(doc, 'tbl', c, 144);
    const html = blocksToHtml([blockToJSON(table)]);
    expect(html).toContain('<colgroup><col style="width:88px"><col><col style="width:144px"></colgroup>');
    const imported = htmlToBlocks(html)[0];
    const reopened = createDoc([{...imported, id: 'copy'}]);
    const copy = findBlock(reopened, 'copy')!.block;
    const ids = tableColumns(copy).map((column) => column.id);
    expect(ids.map((id) => tableColumnWidth(copy, id))).toEqual([88, null, 144]);
  });
});
