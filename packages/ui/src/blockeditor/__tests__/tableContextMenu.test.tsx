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
  docToJSON,
  findBlock,
  makeTable,
  setBlockProp,
  setTableCellRangeColor,
  setTableColumnColor,
  setTableRowColor,
  tableCellColor,
  tableCellOwnColor,
  tableColumns,
  tableDuplicateRow,
  tableGrid,
  tableMoveColumn,
  tableMoveRow,
  type BlockMap,
  type CellRect,
} from '../model';
import {COLOR_EXPORT_HEX} from '../colors';
import {blocksToHtml, projectBlocksForExport} from '../exportBlocks';

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

/**
 * TBL-6: right-click a cell with a live range rectangle in scope. `rect` is what
 * the table hands down from the CellSelectionContext; the menu decides which
 * variant to render from whether the clicked cell falls inside it.
 */
const openMenuWithRange = (doc: Y.Doc, cellId: string, range: CellRect, onClearRange?: () => void): void => {
  render(
    <TableCellMenu
      cell={cellBlock(doc, cellId)}
      tableId="tbl"
      editor={stubEditor(doc)}
      suppress={false}
      range={range}
      onClearRange={onClearRange}
    >
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

  it('keeps column insert/delete actions for a legacy table without column ids', () => {
    const doc = createDoc([
      {
        id: 'tbl',
        type: 'table',
        children: [{id: 'row', type: 'row', children: [{id: 'cell', type: 'cell', text: [{t: 'legacy'}]}]}],
      },
    ]);
    openMenu(doc, 'cell');
    expect(screen.getByText('Column')).toBeTruthy();
    expect(screen.getByText('Insert column left')).toBeTruthy();
    expect(screen.getByText('Insert column right')).toBeTruthy();
    expect(screen.getByText('Delete column')).toBeTruthy();
    expect(screen.getByText('Move column left').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Move column right').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true');
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

// ── TBL-6: the RANGE variant of the cell menu ────────────────────────────────
// A right-click inside the live cell-range rectangle addresses the whole range;
// a right-click outside it addresses the single cell exactly as before. The gate
// is a multi-cell `cellInRect` hit over the rect the table hands down, so these
// tests drive the `range` prop directly (live wiring is covered elsewhere).

/** A 2-rows × 3-columns selection over the top of the grid. */
const RANGE_2x3: CellRect = {top: 0, left: 0, bottom: 1, right: 2};

describe('TableCellMenu — range variant (TBL-6)', () => {
  it('a right-click INSIDE the rect shows the range items with exact counts', () => {
    openMenuWithRange(seedTableDoc(3, 3), 'r1c1', RANGE_2x3);
    for (const label of ['Selection · 2 × 3', 'Clear contents', 'Cell colour', 'Delete 2 rows', 'Delete table']) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
    // …and NONE of the single-cell items.
    for (const label of ['Insert row above', 'Insert row below', 'Duplicate row', 'Row colour', 'Toggle header row']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
  });

  it('a right-click OUTSIDE the rect shows the unchanged single-cell menu', () => {
    // r2c0 is at sorted row 2 — one row below the rect's bottom edge.
    openMenuWithRange(seedTableDoc(3, 3), 'r2c0', RANGE_2x3);
    for (const label of ['Row', 'Column', 'Insert row below', 'Duplicate row', 'Delete row', 'Toggle header row']) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
    for (const label of ['Clear contents', 'Cell colour']) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.queryByText(/Selection ·/)).toBeNull();
  });

  it('a 1×1 rect keeps the fifteen-item single-cell menu', () => {
    openMenuWithRange(seedTableDoc(3, 3), 'r1c1', {top: 1, left: 1, bottom: 1, right: 1});
    expect(screen.getByText('Duplicate row')).toBeTruthy();
    expect(screen.getByText('Toggle header row')).toBeTruthy();
    expect(screen.queryByText(/Selection ·/)).toBeNull();
    expect(screen.queryByText('Clear contents')).toBeNull();
  });

  it('a multi-cell range uses singular delete labels for a one-cell axis', () => {
    openMenuWithRange(seedTableDoc(3, 3), 'r1c1', {top: 1, left: 1, bottom: 1, right: 2});
    expect(screen.getByText('Selection · 1 × 2')).toBeTruthy();
    expect(screen.getByText('Delete row')).toBeTruthy();
    expect(screen.getByText('Delete 2 columns')).toBeTruthy();
    expect(screen.queryByText('Delete 1 rows')).toBeNull();
  });

  it('clamps stale range counts to the live grid and labels full-axis deletes as table deletes', () => {
    openMenuWithRange(seedTableDoc(3, 3), 'r1c1', {top: 0, left: 0, bottom: 99, right: 99});
    expect(screen.getByText('Selection · 3 × 3')).toBeTruthy();
    expect(screen.getAllByText('Delete table')).toHaveLength(2);
    expect(screen.queryByText('Delete 100 rows')).toBeNull();
    expect(screen.queryByText('Delete 100 columns')).toBeNull();
  });

  it('delete-rows removes EXACTLY the selected rows and drops the range', () => {
    const doc = seedTableDoc(4, 3);
    let cleared = false;
    openMenuWithRange(doc, 'r1c0', {top: 1, left: 0, bottom: 2, right: 2}, () => {
      cleared = true;
    });
    fireEvent.click(screen.getByText('Delete 2 rows'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r3c0', 'r3c1', 'r3c2'],
    ]);
    expect(cleared).toBe(true); // the stale rectangle is dropped
  });

  it('delete-columns removes EXACTLY the selected columns', () => {
    const doc = seedTableDoc(3, 4);
    openMenuWithRange(doc, 'r0c1', {top: 0, left: 1, bottom: 0, right: 2});
    fireEvent.click(screen.getByText('Delete 2 columns'));
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c3'],
      ['r1c0', 'r1c3'],
      ['r2c0', 'r2c3'],
    ]);
  });

  it('delete-rows targets SORTED rows after a reorder (the sorted-vs-array trap)', () => {
    const doc = seedTableDoc(4, 3);
    tableMoveRow(doc, 'tbl', 'row3', 0); // sorted: r3, r0, r1, r2
    openMenuWithRange(doc, 'r3c0', {top: 0, left: 0, bottom: 1, right: 2});
    fireEvent.click(screen.getByText('Delete 2 rows'));
    // The two TOP-most rendered rows go — r3 (array index 3) and r0.
    expect(rowTexts(doc)).toEqual([
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  it('clear-cells empties exactly the range, one undo step, nothing outside it', () => {
    const doc = seedTableDoc(3, 3);
    const undo = new Y.UndoManager(blockChildren(findBlock(doc, 'tbl')!.block)!, {trackedOrigins: new Set(['local'])});
    openMenuWithRange(doc, 'r0c0', RANGE_2x3);
    fireEvent.click(screen.getByText('Clear contents'));
    expect(rowTexts(doc)).toEqual([
      ['', '', ''],
      ['', '', ''],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
    undo.undo(); // the whole range reverts together
    expect(rowTexts(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  it('clears the range selection after merging so the cell menu becomes reachable', () => {
    const doc = seedTableDoc(3, 3);
    let clearCount = 0;
    openMenuWithRange(doc, 'r0c0', {top: 0, left: 0, bottom: 1, right: 1}, () => {
      clearCount += 1;
    });

    fireEvent.click(screen.getByText('Merge cells'));

    expect(clearCount).toBe(1);
    expect(blockProp(findBlock(doc, 'r0c0')!.block, 'colspan')).toBe(2);
    expect(blockProp(findBlock(doc, 'r0c0')!.block, 'rowspan')).toBe(2);
  });
});

// ── TBL-6: per-cell tint ─────────────────────────────────────────────────────

describe('per-cell tint (TBL-6)', () => {
  const tintGrid = (doc: Y.Doc): (string | null)[][] => {
    const table = findBlock(doc, 'tbl')!.block;
    const grid = tableGrid(table);
    return grid.rows.map((row, r) =>
      grid.cells[r].map((cell, c) => (cell ? tableCellColor(table, row, grid.colIds[c] ?? null, cell) : null)),
    );
  };

  it('the Cell colour swatch applies the token to EVERY cell of the range', () => {
    const doc = seedTableDoc(3, 3);
    openMenuWithRange(doc, 'r0c0', RANGE_2x3);
    fireEvent.click(screen.getByText('Cell colour')); // open the swatch submenu
    fireEvent.click(screen.getByText('Green'));
    expect(tintGrid(doc)).toEqual([
      ['green', 'green', 'green'],
      ['green', 'green', 'green'],
      [null, null, null],
    ]);
    // The tint is each cell's OWN `bg` prop — the universal block background.
    const grid = tableGrid(findBlock(doc, 'tbl')!.block);
    expect(blockProp<string>(grid.cells[0][0]!, 'bg')).toBe('green');
    expect(blockProp<string>(grid.cells[2][0]!, 'bg')).toBeUndefined();
  });

  it('"Default" clears the range tint, exposing the row/column tint underneath', () => {
    const doc = seedTableDoc(3, 3);
    const col0 = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnColor(doc, 'tbl', col0, 'blue');
    setTableCellRangeColor(doc, 'tbl', {top: 0, left: 0, bottom: 0, right: 1}, 'red');
    expect(tintGrid(doc)[0][0]).toBe('red'); // cell wins over column

    openMenuWithRange(doc, 'r0c0', {top: 0, left: 0, bottom: 0, right: 1});
    fireEvent.click(screen.getByText('Cell colour'));
    fireEvent.click(screen.getByText('Default'));
    expect(tintGrid(doc)[0][0]).toBe('blue'); // column shows through again
    expect(tableCellOwnColor(findBlock(doc, 'r0c0')!.block)).toBeNull();
  });

  it('composites CELL over ROW over COLUMN', () => {
    const doc = seedTableDoc(3, 3);
    const col0 = tableColumns(findBlock(doc, 'tbl')!.block)[0].id;
    setTableColumnColor(doc, 'tbl', col0, 'blue');
    setTableRowColor(doc, 'tbl', 'row0', 'green');
    setTableCellRangeColor(doc, 'tbl', {top: 0, left: 0, bottom: 0, right: 0}, 'red');
    // r0c0 has all three; r0c1 has the row tint; r1c0 has the column tint.
    expect(tintGrid(doc)[0][0]).toBe('red');
    expect(tintGrid(doc)[0][1]).toBe('green');
    expect(tintGrid(doc)[1][0]).toBe('blue');
  });

  it('survives a reload (Yjs round-trip into a fresh doc)', () => {
    const doc = seedTableDoc(3, 3);
    setTableCellRangeColor(doc, 'tbl', RANGE_2x3, 'purple');
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
    const grid = tableGrid(findBlock(reloaded, 'tbl')!.block);
    expect(grid.cells.slice(0, 2).flatMap((line) => line.map((c) => tableCellOwnColor(c!)))).toEqual(
      Array.from({length: 6}, () => 'purple'),
    );
    expect(tableCellOwnColor(grid.cells[2][0]!)).toBeNull();
  });

  it('appears in the exported HTML (clipboard + static projection)', () => {
    const doc = seedTableDoc(3, 3);
    setTableRowColor(doc, 'tbl', 'row0', 'green');
    setTableCellRangeColor(doc, 'tbl', {top: 0, left: 0, bottom: 0, right: 0}, 'red');
    const json = docToJSON(doc).find((b) => b.id === 'tbl')!;

    // Clipboard/standalone HTML: the cell's own tint paints its <td>, and the
    // row tint still paints its siblings (cell wins only where it is set).
    const html = blocksToHtml([json]);
    expect(html).toContain(`background:${COLOR_EXPORT_HEX.red.hl}`);
    expect(html).toContain(`background:${COLOR_EXPORT_HEX.green.hl}`);
    expect(html.indexOf(COLOR_EXPORT_HEX.red.hl)).toBeLessThan(html.indexOf(COLOR_EXPORT_HEX.green.hl));

    // HTML/PDF projection: the parallel cellColors grid carries the same token.
    const out = projectBlocksForExport(docToJSON(doc));
    const table = out.blocks.find((b) => b.type === 'table')!;
    const cellColors = (table.data as {cellColors: (string | null)[][]}).cellColors;
    expect(cellColors[0]).toEqual(['red', 'green', 'green']);
  });
});
