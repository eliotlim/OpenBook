import {describe, it, expect, afterEach} from 'vitest';
import {render, cleanup, fireEvent} from '@testing-library/react';
import * as Y from 'yjs';
import {BlockEditor, tableDropTarget} from '../BlockEditor';
import {
  blockId,
  createDoc,
  findBlock,
  makeTable,
  rootBlocks,
  tableColumns,
  tableGrid,
  tableMergeCells,
  tableMoveColumn,
  tableSpans,
} from '../model';

// ── Harness ──────────────────────────────────────────────────────────────────

/** A `rows`×`cols` keyed table whose cells read "r<row>c<col>" (stable ids). */
const seedTableDoc = (rows = 3, cols = 3): Y.Doc => {
  const table = makeTable(rows, cols);
  table.id = 'tbl';
  table.props = {...(table.props ?? {}), header: false}; // no header styling in the way
  table.children = table.children!.map((row, r) => ({
    ...row,
    id: `row${r}`,
    children: row.children!.map((cell, c) => ({...cell, id: `r${r}c${c}`, text: `r${r}c${c}`})),
  }));
  return createDoc([table]);
};

const rowOrder = (doc: Y.Doc): string[] => tableGrid(findBlock(doc, 'tbl')!.block).rows.map(blockId);
const colOrder = (doc: Y.Doc): string[] => tableColumns(findBlock(doc, 'tbl')!.block).map((c) => c.id);

/** A minimal DataTransfer stand-in — jsdom drag events carry none. */
const dt = (): DataTransfer => ({setData() {}, getData: () => '', effectAllowed: '', dropEffect: ''}) as unknown as DataTransfer;

afterEach(cleanup);

// ── The pure boundary→toIndex conversion (the sorted-vs-array trap) ───────────

describe('tableDropTarget', () => {
  it('maps a boundary AFTER the moved item to boundary − 1 (item removed)', () => {
    // rows [A,B,C,D], move A (from 0) to the boundary before D (full index 3).
    expect(tableDropTarget(3, 0)).toBe(2); // → [B,C,A,D]
  });
  it('leaves a boundary BEFORE the moved item unchanged', () => {
    // move D (from 3) to the boundary between A and B (full index 1).
    expect(tableDropTarget(1, 3)).toBe(1); // → [A,D,B,C]
  });
  it('returns null for a no-op drop onto either edge of the item’s own slot', () => {
    expect(tableDropTarget(2, 2)).toBeNull();
    expect(tableDropTarget(3, 2)).toBeNull();
  });
  it('drop at the very top / very bottom', () => {
    expect(tableDropTarget(0, 2)).toBe(0); // to the top
    expect(tableDropTarget(4, 1)).toBe(3); // to the end (N=4 rows)
  });
});

// ── Grip presence + gating ───────────────────────────────────────────────────

describe('table drag grips (render gating)', () => {
  it('renders a row grip per row and a column grip per column when editable', () => {
    const {container} = render(<BlockEditor doc={seedTableDoc(3, 3)} />);
    expect(container.querySelectorAll('.obe-table-row-grip')).toHaveLength(3);
    expect(container.querySelectorAll('.obe-table-col-grip')).toHaveLength(3);
    // Grips are plain draggable elements (never a Radix trigger — that kills
    // native HTML5 drag), so caret placement / cell editing are untouched.
    for (const g of container.querySelectorAll('.obe-table-row-grip')) {
      expect(g.getAttribute('draggable')).toBe('true');
    }
  });

  it('hides all grips in readOnly (present/export chrome parity)', () => {
    const {container} = render(<BlockEditor doc={seedTableDoc(3, 3)} readOnly />);
    expect(container.querySelector('.obe-table-row-grip')).toBeNull();
    expect(container.querySelector('.obe-table-col-grip')).toBeNull();
    expect(container.querySelector('.obe-has-grips')).toBeNull();
  });

  it('keeps every row/column grip bound to its logical index after a 2×2 merge', () => {
    const doc = seedTableDoc(3, 3);
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const {container} = render(<BlockEditor doc={doc} />);
    const rows = container.querySelectorAll('.obe-table tbody > tr');

    expect(rows).toHaveLength(3);
    rows.forEach((row, from) => {
      const grip = row.querySelector<HTMLElement>('.obe-table-row-grip');
      expect(grip?.dataset.dragFrom).toBe(String(from));
      expect(grip?.dataset.dragId).toBe((row as HTMLElement).dataset.tableRowId);
    });

    const colGrips = [...container.querySelectorAll<HTMLElement>('.obe-table-col-grip')];
    expect(colGrips.map((grip) => grip.dataset.dragFrom)).toEqual(['0', '1', '2']);
    expect(new Set(colGrips.map((grip) => grip.dataset.dragId)).size).toBe(3);
    const anchor = container.querySelector('[data-block-text="r0c0"]')!.closest('td')!;
    expect(anchor.querySelectorAll('.obe-table-col-grip')).toHaveLength(2);
  });
});

// ── Grip → op wiring (real drag events, sorted indices) ──────────────────────

describe('table drag reorder (grip → op wiring)', () => {
  const rowGrips = (c: HTMLElement): NodeListOf<Element> => c.querySelectorAll('.obe-table-row-grip');
  const colGrips = (c: HTMLElement): NodeListOf<Element> => c.querySelectorAll('.obe-table-col-grip');
  const trs = (c: HTMLElement): NodeListOf<Element> => c.querySelectorAll('.obe-table tbody > tr');
  // jsdom rects are all-zero and drag events don't carry clientY/clientX, so a
  // dragOver always resolves to the "before" boundary (0 > 0 is false). We drive
  // every case through before-boundaries — enough to prove the wiring + indices.

  it('drags sorted row 2 above row 0 → cell contents follow, single undo restores', () => {
    const doc = seedTableDoc(3, 3);
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local']), captureTimeout: 0});
    const {container} = render(<BlockEditor doc={doc} />);

    fireEvent.dragStart(rowGrips(container)[2], {dataTransfer: dt()}); // grab row2 (sorted 2)
    fireEvent.dragOver(trs(container)[0], {dataTransfer: dt(), clientY: 0}); // top half of row0 → boundary 0
    fireEvent.drop(trs(container)[0], {dataTransfer: dt()});

    expect(rowOrder(doc)).toEqual(['row2', 'row0', 'row1']);
    undo.undo();
    expect(rowOrder(doc)).toEqual(['row0', 'row1', 'row2']); // one step restores
  });

  it('drags sorted column 1 to column 0', () => {
    const doc = seedTableDoc(3, 3);
    const cols = colOrder(doc); // [c0, c1, c2]
    const {container} = render(<BlockEditor doc={doc} />);

    fireEvent.dragStart(colGrips(container)[1], {dataTransfer: dt()}); // grab column 1
    // Drop on the LEFT half of column 0 (boundary 0).
    const firstRowCells = trs(container)[0].querySelectorAll('td');
    fireEvent.dragOver(firstRowCells[0], {dataTransfer: dt(), clientX: 0});
    fireEvent.drop(firstRowCells[0], {dataTransfer: dt()});

    expect(colOrder(doc)).toEqual([cols[1], cols[0], cols[2]]);
  });

  it('drags a rowspan-covered row by that row’s own grip', () => {
    const doc = seedTableDoc(3, 3);
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const {container} = render(<BlockEditor doc={doc} />);

    fireEvent.dragStart(trs(container)[1].querySelector('.obe-table-row-grip')!, {dataTransfer: dt()});
    fireEvent.dragOver(trs(container)[0], {dataTransfer: dt(), clientY: 0});
    fireEvent.drop(trs(container)[0], {dataTransfer: dt()});

    expect(rowOrder(doc)).toEqual(['row1', 'row0', 'row2']);
  });

  it('drags a merged anchor’s covered-column segment, not the anchor column', () => {
    const doc = seedTableDoc(3, 3);
    tableMergeCells(doc, 'tbl', {top: 0, left: 0, bottom: 1, right: 1});
    const cols = colOrder(doc);
    const {container} = render(<BlockEditor doc={doc} />);

    const coveredColumnGrip = [...colGrips(container)].find(
      (grip) => (grip as HTMLElement).dataset.dragFrom === '1',
    )!;
    fireEvent.dragStart(coveredColumnGrip, {dataTransfer: dt()});
    fireEvent.dragOver(trs(container)[0].querySelectorAll('td')[0], {dataTransfer: dt(), clientX: 0});
    fireEvent.drop(trs(container)[0].querySelectorAll('td')[0], {dataTransfer: dt()});

    expect(colOrder(doc)).toEqual([cols[1], cols[0], cols[2]]);
    expect(tableSpans(tableGrid(findBlock(doc, 'tbl')!.block))[0][1]).toEqual({
      kind: 'cell',
      colspan: 1,
      rowspan: 2,
    });

    tableMoveColumn(doc, 'tbl', cols[1], 1);
    expect(colOrder(doc)).toEqual(cols);
    expect(tableSpans(tableGrid(findBlock(doc, 'tbl')!.block))[0][0]).toEqual({
      kind: 'cell',
      colspan: 2,
      rowspan: 2,
    });
  });

  it('targets the SORTED position on an ALREADY-reordered table (the classic bug)', () => {
    const doc = seedTableDoc(3, 3);
    const {container} = render(<BlockEditor doc={doc} />);

    // First drag: sorted row 2 (row2) to the top → order becomes r2, r0, r1.
    fireEvent.dragStart(rowGrips(container)[2], {dataTransfer: dt()});
    fireEvent.dragOver(trs(container)[0], {dataTransfer: dt(), clientY: 0}); // top half of row0 → boundary 0
    fireEvent.drop(trs(container)[0], {dataTransfer: dt()});
    expect(rowOrder(doc)).toEqual(['row2', 'row0', 'row1']);

    // Second drag on the reordered table: the grip at SORTED index 2 is now row1
    // (array index 1) — a raw array-index op would grab the wrong row. Move it up
    // to the top.
    fireEvent.dragStart(rowGrips(container)[2], {dataTransfer: dt()});
    fireEvent.dragOver(trs(container)[0], {dataTransfer: dt(), clientY: 0});
    fireEvent.drop(trs(container)[0], {dataTransfer: dt()});
    // row1 (sorted 2) went to the top — proving the grip used the render index.
    expect(rowOrder(doc)).toEqual(['row1', 'row2', 'row0']);
  });
});
