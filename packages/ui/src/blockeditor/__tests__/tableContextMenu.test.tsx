import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import * as Y from 'yjs';
import {TableCellMenu} from '../BlockEditor';
import type {BlockEditorController} from '../useBlockEditor';
import {
  blockChildren,
  blockId,
  blockPlainText,
  blockProp,
  createDoc,
  findBlock,
  makeTable,
  setBlockProp,
  tableColumns,
  tableDuplicateRow,
  tableGrid,
  tableMoveColumn,
  tableMoveRow,
  type BlockMap,
} from '../model';

// ── Harness ──────────────────────────────────────────────────────────────────

/** A `rows`×`cols` keyed table whose cells read "r<row>c<col>" (stable ids). */
const seedTableDoc = (rows = 3, cols = 3): Y.Doc => {
  const table = makeTable(rows, cols);
  table.id = 'tbl';
  table.children = table.children!.map((row, r) => ({
    ...row,
    id: `row${r}`,
    children: row.children!.map((cell, c) => ({...cell, id: `r${r}c${c}`, text: `r${r}c${c}`})),
  }));
  return createDoc([table]);
};

const cellBlock = (doc: Y.Doc, id: string): BlockMap => findBlock(doc, id)!.block;
const rowTexts = (doc: Y.Doc): string[][] => {
  const grid = tableGrid(findBlock(doc, 'tbl')!.block);
  return grid.rows.map((_, r) => grid.cells[r].map((cell) => (cell ? blockPlainText(cell) : '∅')));
};

const stubEditor = (doc: Y.Doc, readOnly = false): BlockEditorController =>
  ({doc, readOnly}) as unknown as BlockEditorController;

/** Render the cell menu and right-click it open. */
const openMenu = (doc: Y.Doc, cellId: string, suppress = false): void => {
  render(
    <TableCellMenu cell={cellBlock(doc, cellId)} tableId="tbl" editor={stubEditor(doc, suppress)} suppress={suppress}>
      <button data-testid="cell">{cellId}</button>
    </TableCellMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('cell'));
};

afterEach(cleanup);

// ── The duplicate-row model op (TBL-3 adds it per the contract) ──────────────

describe('tableDuplicateRow', () => {
  it('inserts a clone directly below with fresh ids, same col bindings, copied text', () => {
    const doc = seedTableDoc(3, 3);
    const before = tableGrid(findBlock(doc, 'tbl')!.block);
    const srcColIds = before.cells[1].map((c) => blockProp<string>(c!, 'col'));
    const srcIds = before.cells[1].map((c) => blockId(c!));

    tableDuplicateRow(doc, 'tbl', 1);

    const grid = tableGrid(findBlock(doc, 'tbl')!.block);
    expect(grid.rows).toHaveLength(4);
    // Clone lands at sorted position 2 (directly after source at 1).
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
    const clone = grid.cells[2];
    // Same column bindings as the source…
    expect(clone.map((c) => blockProp<string>(c!, 'col'))).toEqual(srcColIds);
    // …but every id is fresh (no CRDT node reuse).
    expect(clone.map((c) => blockId(c!)).some((id) => srcIds.includes(id))).toBe(false);
    expect(srcIds.includes(blockId(grid.rows[2]))).toBe(false);
  });

  it('is convergence-safe: two peers that both duplicate the same row merge to two clones (insert-only)', () => {
    const a = seedTableDoc(2, 2);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    tableDuplicateRow(a, 'tbl', 0);
    tableDuplicateRow(b, 'tbl', 0);
    // Cross-merge.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Insert-only → both clones survive, no lost content, identical convergence.
    expect(rowTexts(a)).toEqual(rowTexts(b));
    expect(tableGrid(findBlock(a, 'tbl')!.block).rows).toHaveLength(4);
    // Column registry stays consistent across the merge.
    expect(tableColumns(findBlock(a, 'tbl')!.block)).toEqual(tableColumns(findBlock(b, 'tbl')!.block));
  });

  it('one duplicate = one undo step (the whole clone reverts together)', () => {
    const doc = seedTableDoc(2, 2);
    const undo = new Y.UndoManager(blockChildren(findBlock(doc, 'tbl')!.block)!, {trackedOrigins: new Set(['local'])});
    tableDuplicateRow(doc, 'tbl', 0);
    expect(tableGrid(findBlock(doc, 'tbl')!.block).rows).toHaveLength(3);
    undo.undo();
    expect(tableGrid(findBlock(doc, 'tbl')!.block).rows).toHaveLength(2);
  });
});

// ── The per-cell context menu ────────────────────────────────────────────────

describe('TableCellMenu', () => {
  it('renders the row + column sections for a cell', () => {
    openMenu(seedTableDoc(), 'r1c1');
    for (const label of [
      'Row',
      'Column',
      'Insert row above',
      'Insert row below',
      'Duplicate row',
      'Delete row',
      'Insert column left',
      'Insert column right',
      'Delete column',
      'Toggle header row',
    ]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
  });

  it('suppressed (read-only / locked) cell shows no menu', () => {
    openMenu(seedTableDoc(), 'r1c1', true);
    expect(screen.queryByText('Insert row above')).toBeNull();
    expect(screen.queryByText('Delete row')).toBeNull();
  });

  it('insert-row-below fires at THIS cell’s sorted row + 1', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r1c0'); // sorted row 1
    fireEvent.click(screen.getByText('Insert row below'));
    // New blank row lands between sorted rows 1 and 2.
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['', '', ''],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  it('delete-column fires at THIS cell’s sorted column', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r0c1'); // sorted column 1
    fireEvent.click(screen.getByText('Delete column'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c2'],
      ['r1c0', 'r1c2'],
      ['r2c0', 'r2c2'],
    ]);
  });

  it('toggle-header flips the table header prop', () => {
    const doc = seedTableDoc(2, 2); // makeTable seeds header:true
    expect(blockProp<boolean>(findBlock(doc, 'tbl')!.block, 'header')).toBe(true);
    openMenu(doc, 'r0c0');
    fireEvent.click(screen.getByText('Toggle header row'));
    expect(blockProp<boolean>(findBlock(doc, 'tbl')!.block, 'header')).toBe(false);
  });

  // The classic sorted-vs-array bug: after a move the cell's ARRAY index and its
  // RENDER index diverge; every op must use the sorted coordinate.
  it('uses SORTED coords after a row reorder (delete row on a moved cell)', () => {
    const doc = seedTableDoc(3, 3);
    // Move row2 (array index 2) to the top → sorted order becomes r2, r0, r1.
    tableMoveRow(doc, 'tbl', 'row2', 0);
    expect(rowTexts(doc)).toEqual([
      ['r2c0', 'r2c1', 'r2c2'],
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
    ]);
    // r2c0 is now at sorted row 0 but still array index 2. Delete its row.
    openMenu(doc, 'r2c0');
    fireEvent.click(screen.getByText('Delete row'));
    // The MOVED row (sorted 0) is gone — not the array-index-0 row.
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
    ]);
  });

  // Rendering is positional: with `header`, sorted row 0 IS the header. Offering
  // "Insert row above" there would push a blank row into the header slot and
  // silently demote the real header — so the item is hidden in exactly that case.
  it('hides "Insert row above" only on the header row (sorted row 0 of a header table)', () => {
    // Header table (makeTable seeds header:true), cell in sorted row 0.
    openMenu(seedTableDoc(3, 3), 'r0c0');
    expect(screen.queryByText('Insert row above')).toBeNull();
    expect(screen.getByText('Insert row below')).toBeTruthy();
    cleanup();

    // Same coordinate, but a non-header table → both items present.
    const plain = seedTableDoc(3, 3);
    setBlockProp(findBlock(plain, 'tbl')!.block, 'header', false);
    openMenu(plain, 'r0c0');
    expect(screen.getByText('Insert row above')).toBeTruthy();
    expect(screen.getByText('Insert row below')).toBeTruthy();
  });

  it('uses SORTED coords after a row reorder (insert row above a moved cell)', () => {
    const doc = seedTableDoc(3, 3);
    tableMoveRow(doc, 'tbl', 'row2', 0); // sorted: r2, r0, r1
    openMenu(doc, 'r0c0'); // now at sorted row 1
    fireEvent.click(screen.getByText('Insert row above'));
    expect(rowTexts(doc)).toEqual([
      ['r2c0', 'r2c1', 'r2c2'],
      ['', '', ''],
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
    ]);
  });
});

// ── TBL-2: the keyboard/a11y move path (context-menu items) ──────────────────

describe('TableCellMenu — move items', () => {
  it('renders the four move items', () => {
    openMenu(seedTableDoc(), 'r1c1');
    for (const label of ['Move row up', 'Move row down', 'Move column left', 'Move column right']) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
  });

  it('move-row-down reorders to sorted row + 1', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r1c0'); // sorted row 1
    fireEvent.click(screen.getByText('Move row down'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r2c0', 'r2c1', 'r2c2'],
      ['r1c0', 'r1c1', 'r1c2'],
    ]);
  });

  it('move-column-right reorders to sorted column + 1', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r0c1'); // sorted column 1
    fireEvent.click(screen.getByText('Move column right'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c2', 'r0c1'],
      ['r1c0', 'r1c2', 'r1c1'],
      ['r2c0', 'r2c2', 'r2c1'],
    ]);
  });

  it('move-row-up is a no-op at the top row (disabled at the extreme)', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r0c0'); // sorted row 0
    fireEvent.click(screen.getByText('Move row up'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  it('move-column-left is a no-op at the first column (disabled at the extreme)', () => {
    const doc = seedTableDoc(3, 3);
    openMenu(doc, 'r0c0'); // sorted column 0
    fireEvent.click(screen.getByText('Move column left'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  // The sorted-vs-array trap: move must target the RENDER position, not the
  // array index, on a table that has already been reordered.
  it('uses SORTED coords after a reorder (move down a moved-to-top row)', () => {
    const doc = seedTableDoc(3, 3);
    tableMoveRow(doc, 'tbl', 'row2', 0); // sorted: r2, r0, r1
    openMenu(doc, 'r2c0'); // r2 is now sorted row 0 (still array index 2)
    fireEvent.click(screen.getByText('Move row down'));
    // The MOVED row (sorted 0) drops one place — not the array-index-0 row.
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r2c0', 'r2c1', 'r2c2'],
      ['r1c0', 'r1c1', 'r1c2'],
    ]);
  });

  it('move-column ops still target the right column after a column reorder', () => {
    const doc = seedTableDoc(3, 3);
    const c2 = tableColumns(findBlock(doc, 'tbl')!.block)[2].id;
    tableMoveColumn(doc, 'tbl', c2, 0); // sorted columns: c2, c0, c1
    openMenu(doc, 'r0c2'); // c2 is now sorted column 0
    fireEvent.click(screen.getByText('Move column right'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c2', 'r0c1'],
      ['r1c0', 'r1c2', 'r1c1'],
      ['r2c0', 'r2c2', 'r2c1'],
    ]);
  });
});
