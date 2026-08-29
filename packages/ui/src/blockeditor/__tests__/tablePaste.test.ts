import {describe, expect, it, vi} from 'vitest';
import {parseClipboardGrid} from '../tablePaste';
import * as Y from 'yjs';
import {
  blockProp,
  blockText,
  createDoc,
  findBlock,
  makeTable,
  rootBlocks,
  tableGrid,
  tablePasteGrid,
  type NewBlock,
} from '../model';

describe('parseClipboardGrid', () => {
  it('parses the first HTML table and preserves br as a newline', () => {
    expect(parseClipboardGrid({html: '<p>before</p><table><tr><th> A<br>B </th><th>C</th></tr></table><table><tr><td>ignored</td></tr></table>'})).toEqual([
      ['A\nB', 'C'],
    ]);
  });

  it('expands HTML colspan and rowspan with empty covered slots', () => {
    expect(parseClipboardGrid({html: '<table><tr><td colspan="2" rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>'})).toEqual([
      ['A', '', 'B'],
      ['', '', 'C'],
    ]);
  });

  it('parses TSV rows and columns', () => {
    expect(parseClipboardGrid({text: 'A\tB\nC\tD'})).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });

  it.each(['A\tB\nC\tD\n', 'A\tB\r\nC\tD\r\n'])('does not add a trailing row for %j', (text) => {
    expect(parseClipboardGrid({text})).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });

  it('parses quoted tabs/newlines and escaped quotes', () => {
    expect(parseClipboardGrid({text: '"a\tb"\t"line 1\nline 2 and ""quote"""'})).toEqual([['a\tb', 'line 1\nline 2 and "quote"']]);
  });

  it('returns null for a single plain value and empty input', () => {
    expect(parseClipboardGrid({text: 'plain'})).toBeNull();
    expect(parseClipboardGrid({text: ''})).toBeNull();
    expect(parseClipboardGrid({})).toBeNull();
  });
});

const seededTable = (rows = 3, cols = 3): Y.Doc => {
  const table = makeTable(rows, cols);
  table.id = 'tbl';
  table.children = table.children!.map((row, r) => ({
    ...row,
    children: row.children!.map((cell, c) => ({...cell, text: `${r},${c}`})),
  }));
  return createDoc([table]);
};

const texts = (doc: Y.Doc): string[][] =>
  tableGrid(findBlock(doc, 'tbl')!.block).cells.map((row) => row.map((cell) => (cell ? blockText(cell)!.toString() : '')));

describe('tablePasteGrid', () => {
  it('does nothing when the write exceeds the paste cell limit', () => {
    const doc = seededTable();
    const before = texts(doc);
    expect(tablePasteGrid(doc, 'tbl', {row: 0, col: 0}, Array.from({length: 20001}, () => ['X']))).toBeNull();
    expect(texts(doc)).toEqual(before);
  });

  it('terminates when a structural insert makes no progress', () => {
    const doc = createDoc([{id: 'tbl', type: 'table', props: {header: false, 'col:c0': 'a0'}, children: []}]);
    const rows = findBlock(doc, 'tbl')!.block.get('children') as Y.Array<unknown>;
    vi.spyOn(rows, 'insert').mockImplementation(() => {});
    expect(tablePasteGrid(doc, 'tbl', {row: 0, col: 0}, [['X']])).toBeNull();
    expect(tableGrid(findBlock(doc, 'tbl')!.block).rows).toHaveLength(0);
  });

  it('fills a selected 2x2 range', () => {
    const doc = seededTable();
    tablePasteGrid(doc, 'tbl', {row: 1, col: 1}, [['A', 'B'], ['C', 'D']], {
      range: {tableId: 'tbl', anchor: {row: 1, col: 1}, focus: {row: 2, col: 2}},
    });
    expect(texts(doc)).toEqual([
      ['0,0', '0,1', '0,2'],
      ['1,0', 'A', 'B'],
      ['2,0', 'C', 'D'],
    ]);
  });

  it('grows a 3x3 table to 5x5 when pasted at its last cell', () => {
    const doc = seededTable();
    tablePasteGrid(doc, 'tbl', {row: 2, col: 2}, [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']]);
    expect(tableGrid(findBlock(doc, 'tbl')!.block).rows).toHaveLength(5);
    expect(tableGrid(findBlock(doc, 'tbl')!.block).width).toBe(5);
    expect(texts(doc).slice(2).map((row) => row.slice(2))).toEqual([['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']]);
  });

  it('writes a merged anchor, skips covered slots, and leaves spans unchanged', () => {
    const merged: NewBlock = {
      id: 'tbl', type: 'table', props: {header: false, 'col:c0': 'a0', 'col:c1': 'a1', 'col:c2': 'a2'}, children: [
        {type: 'row', props: {ord: 'a0'}, children: [
          {id: 'anchor', type: 'cell', text: 'old', props: {col: 'c0', colspan: 2, rowspan: 2}},
          {id: 'top-right', type: 'cell', text: 'x', props: {col: 'c2'}},
        ]},
        {type: 'row', props: {ord: 'a1'}, children: [{id: 'bottom-right', type: 'cell', text: 'y', props: {col: 'c2'}}]},
      ],
    };
    const doc = createDoc([merged]);
    const before = {colspan: blockProp(findBlock(doc, 'anchor')!.block, 'colspan'), rowspan: blockProp(findBlock(doc, 'anchor')!.block, 'rowspan')};
    tablePasteGrid(doc, 'tbl', {row: 0, col: 0}, [['A', 'covered'], ['covered', 'covered']]);
    expect(blockText(findBlock(doc, 'anchor')!.block)!.toString()).toBe('A');
    expect({colspan: blockProp(findBlock(doc, 'anchor')!.block, 'colspan'), rowspan: blockProp(findBlock(doc, 'anchor')!.block, 'rowspan')}).toEqual(before);
  });

  it.each([
    {name: '1x1 over 3x2', source: [['X']], expected: [['X', 'X'], ['X', 'X'], ['X', 'X']]},
    {name: '1x2 over 3x2', source: [['X', 'Y']], expected: [['X', 'Y'], ['X', 'Y'], ['X', 'Y']]},
  ])('tiles $name', ({source, expected}) => {
    const doc = seededTable();
    tablePasteGrid(doc, 'tbl', {row: 0, col: 0}, source, {range: {tableId: 'tbl', anchor: {row: 0, col: 0}, focus: {row: 2, col: 1}}});
    expect(texts(doc).map((row) => row.slice(0, 2))).toEqual(expected);
  });

  it('writes only 2x2 from the anchor when a 3x3 range is not divisible', () => {
    const doc = seededTable();
    tablePasteGrid(doc, 'tbl', {row: 0, col: 0}, [['A', 'B'], ['C', 'D']], {range: {tableId: 'tbl', anchor: {row: 0, col: 0}, focus: {row: 2, col: 2}}});
    expect(texts(doc)).toEqual([['A', 'B', '0,2'], ['C', 'D', '1,2'], ['2,0', '2,1', '2,2']]);
  });

  it('undoes growth and every written cell in one step', () => {
    const doc = seededTable();
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local']), captureTimeout: 0});
    tablePasteGrid(doc, 'tbl', {row: 2, col: 2}, [['A', 'B'], ['C', 'D']]);
    undo.undo();
    expect(texts(doc)).toEqual([['0,0', '0,1', '0,2'], ['1,0', '1,1', '1,2'], ['2,0', '2,1', '2,2']]);
  });
});
