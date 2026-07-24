import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import {
  blockChildren,
  blockId,
  blockToJSON,
  cellNeighbor,
  cellPosition,
  createDoc,
  docToJSON,
  findBlock,
  makeBlock,
  makeTable,
  rootBlocks,
  tableColumns,
  tableDeleteColumn,
  tableDeleteRow,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMoveColumn,
  tableMoveRow,
  TABLE_COL_PREFIX,
  type BlockJSON,
  type BlockMap,
} from '../model';
import {blocksToHtml, blocksToMarkdown} from '../exportBlocks';
import {isOrderKey} from '../orderKeys';

// ── Harness ──────────────────────────────────────────────────────────────────

/** A 3×3 keyed table whose cells read "r<row>c<col>" (r0 = header row). */
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

/** A legacy (pre-TBL-1) table: no registry, no ord, no col bindings. */
const seedLegacyTable = (rows = 3, cols = 3): Y.Doc =>
  createDoc([
    {
      id: 'tbl',
      type: 'table',
      props: {header: true},
      children: Array.from({length: rows}, (_, r) => ({
        id: `row${r}`,
        type: 'row' as const,
        children: Array.from({length: cols}, (_, c) => ({id: `r${r}c${c}`, type: 'cell' as const, text: `r${r}c${c}`})),
      })),
    },
  ]);

const fork = (doc: Y.Doc): Y.Doc => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};

const sync = (a: Y.Doc, b: Y.Doc): void => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); // settle both directions
};

const tableBlock = (doc: Y.Doc): BlockMap => findBlock(doc, 'tbl')!.block;

/** The rendered grid as plain text — rows and cells in RENDER order. */
const renderText = (doc: Y.Doc): string[][] => {
  const json = docToJSON(doc).find((b) => b.id === 'tbl')!;
  return (json.children ?? []).map((row) => (row.children ?? []).map((cell) => (cell.text ?? []).map((t) => t.t).join('')));
};

const rowOrder = (doc: Y.Doc): string[] => tableGrid(tableBlock(doc)).rows.map(blockId);

const editCell = (doc: Y.Doc, cellId: string, append: string): void => {
  const cell = findBlock(doc, cellId)!.block;
  const text = cell.get('text') as Y.Text;
  doc.transact(() => text.insert(text.length, append), 'local');
};

// ── New tables are born keyed ────────────────────────────────────────────────

describe('table order contract — schema', () => {
  it('makeTable produces a keyed table: registry, row ords, cell bindings', () => {
    const doc = seedTable();
    const table = tableBlock(doc);
    const cols = tableColumns(table);
    expect(cols).toHaveLength(3);
    for (const c of cols) expect(isOrderKey(c.key)).toBe(true);
    const grid = tableGrid(table);
    expect(grid.keyed).toBe(true);
    expect(grid.width).toBe(3);
    expect(renderText(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
  });

  it('insert/delete honour SORTED positions and keep bindings consistent', () => {
    const doc = seedTable(2, 2);
    tableMoveRow(doc, 'tbl', 'row1', 0); // render order: row1, row0
    tableInsertRow(doc, 'tbl', 1); // between them
    expect(rowOrder(doc)[0]).toBe('row1');
    expect(rowOrder(doc)[2]).toBe('row0');
    expect(renderText(doc)[1]).toEqual(['', '']);

    tableInsertColumn(doc, 'tbl', 1);
    expect(renderText(doc).map((r) => r.length)).toEqual([3, 3, 3]);
    expect(renderText(doc)[0]).toEqual(['r1c0', '', 'r1c1']);
    tableDeleteColumn(doc, 'tbl', 1);
    expect(renderText(doc)[0]).toEqual(['r1c0', 'r1c1']);
    tableDeleteRow(doc, 'tbl', 1); // the inserted blank row
    expect(rowOrder(doc)).toEqual(['row1', 'row0']);
  });

  it('one move = one undo step that only rewrites the order key', () => {
    const doc = seedTable();
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local']), captureTimeout: 0});
    const before = renderText(doc);
    tableMoveRow(doc, 'tbl', 'row0', 2);
    expect(rowOrder(doc)).toEqual(['row1', 'row2', 'row0']);
    // Same row/cell nodes — nothing was cloned or re-inserted.
    expect(findBlock(doc, 'r0c1')).not.toBeNull();
    undo.undo();
    expect(renderText(doc)).toEqual(before);
  });
});

// ── Convergence (the acceptance quartet) ─────────────────────────────────────

describe('table order contract — convergence under concurrent edits', () => {
  it('(a) moveRow vs cell edit in the moved row: both survive, orders match', () => {
    const a = seedTable();
    const b = fork(a);

    tableMoveRow(a, 'tbl', 'row0', 2); // A moves the row…
    editCell(b, 'r0c1', '+edited'); // …while B edits a cell inside it
    sync(a, b);

    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(rowOrder(a)).toEqual(['row1', 'row2', 'row0']);
    // The concurrent edit is NOT lost (the clone-based move would drop it).
    expect(renderText(a)[2][1]).toBe('r0c1+edited');
  });

  it('(b) moveColumn vs insertColumn: both land, identical column order', () => {
    const a = seedTable();
    const b = fork(a);

    tableMoveColumn(a, 'tbl', tableGrid(tableBlock(a)).colIds[0], 2); // A: c0 → end
    tableInsertColumn(b, 'tbl', 1); // B: new column at 1
    sync(a, b);

    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(tableColumns(tableBlock(a))).toHaveLength(4);
    expect(renderText(a).map((r) => r.length)).toEqual([4, 4, 4]);
    // The moved column is last; the inserted (blank) column kept its slot.
    expect(renderText(a)[1][3]).toBe('r1c0');
    expect(renderText(a)[1]).toContain('');
  });

  it('(c) moveColumn vs cell edit in that column: edit lands in the moved column', () => {
    const a = seedTable();
    const b = fork(a);

    tableMoveColumn(a, 'tbl', tableGrid(tableBlock(a)).colIds[1], 0); // A: c1 → front
    editCell(b, 'r2c1', '+edited'); // B edits a c1 cell
    sync(a, b);

    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(renderText(a)[2][0]).toBe('r2c1+edited');
    expect(renderText(b)[2][0]).toBe('r2c1+edited');
  });

  it('(d) two conflicting moveRows converge to one deterministic order', () => {
    const a = seedTable();
    const b = fork(a);

    tableMoveRow(a, 'tbl', 'row0', 2); // A: row0 to the bottom
    tableMoveRow(b, 'tbl', 'row0', 1); // B: row0 to the middle
    sync(a, b);

    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(rowOrder(a)).toEqual(rowOrder(b));
    // One writer won LWW; either way all three rows are present exactly once.
    expect([...rowOrder(a)].sort()).toEqual(['row0', 'row1', 'row2']);
    expect(renderText(a).flat()).toContain('r0c0'); // no cell content lost
  });

  it('(d′) conflicting moves of two DIFFERENT rows both apply', () => {
    const a = seedTable(4, 2);
    const b = fork(a);
    tableMoveRow(a, 'tbl', 'row0', 3);
    tableMoveRow(b, 'tbl', 'row3', 0);
    sync(a, b);
    expect(rowOrder(a)).toEqual(rowOrder(b));
    expect(rowOrder(a)[0]).toBe('row3');
    expect(rowOrder(a)[3]).toBe('row0');
  });
});

// ── Legacy tables + lazy migration ───────────────────────────────────────────

describe('table order contract — legacy tables and migration', () => {
  it('legacy tables render in pure array order, byte-identically, with no keys', () => {
    const doc = seedLegacyTable();
    const table = tableBlock(doc);
    expect(tableColumns(table)).toHaveLength(0);
    const grid = tableGrid(table);
    expect(grid.keyed).toBe(false);
    expect(grid.rows.map(blockId)).toEqual(['row0', 'row1', 'row2']);
    expect(renderText(doc)).toEqual([
      ['r0c0', 'r0c1', 'r0c2'],
      ['r1c0', 'r1c1', 'r1c2'],
      ['r2c0', 'r2c1', 'r2c2'],
    ]);
    // Reading never migrates: still keyless after render + navigation.
    cellNeighbor(doc, 'r0c0', 'next');
    expect(tableColumns(table)).toHaveLength(0);
    expect(blockToJSON(table).props).toEqual({header: true});
  });

  it('the first structural op migrates in ONE transaction (one undo step)', () => {
    const doc = seedLegacyTable();
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local']), captureTimeout: 0});
    let transactions = 0;
    doc.on('afterTransaction', (tr) => {
      if (tr.origin === 'local') transactions += 1;
    });

    tableMoveRow(doc, 'tbl', 'row2', 0); // first structural op on a legacy table
    expect(transactions).toBe(1);
    const table = tableBlock(doc);
    expect(tableColumns(table)).toHaveLength(3); // migrated…
    expect(rowOrder(doc)).toEqual(['row2', 'row0', 'row1']); // …and moved
    const cells = blockChildren(findBlock(doc, 'row0')!.block)!;
    expect((cells.get(0).get('props') as Y.Map<unknown>).get('col')).toBe('c0');

    undo.undo(); // migration + move revert together
    expect(rowOrder(doc)).toEqual(['row0', 'row1', 'row2']);
    expect(tableColumns(table)).toHaveLength(0);
  });

  it('migration is deterministic: two peers migrating concurrently converge', () => {
    const a = seedLegacyTable();
    const b = fork(a);
    tableMoveRow(a, 'tbl', 'row0', 2); // both structural ops migrate first
    tableInsertColumn(b, 'tbl', 3);
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(tableColumns(tableBlock(a))).toHaveLength(4); // c0..c2 + the insert
    // Both migrations wrote IDENTICAL registry values, so the registry never
    // duplicates; row0's ord is whichever writer won LWW (move vs migration)
    // but every row is present exactly once on both peers.
    expect(rowOrder(a)).toEqual(rowOrder(b));
    expect([...rowOrder(a)].sort()).toEqual(['row0', 'row1', 'row2']);
    expect(renderText(a).map((r) => r.length)).toEqual([4, 4, 4]);
  });

  it('a migrated doc converges with an unmigrated peer editing cells', () => {
    const a = seedLegacyTable();
    const b = fork(a);
    tableMoveRow(a, 'tbl', 'row0', 2); // A migrates + moves
    editCell(b, 'r0c2', '+legacy'); // B is still legacy — plain text edit
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(rowOrder(a)).toEqual(['row1', 'row2', 'row0']);
    expect(renderText(a)[2][2]).toBe('r0c2+legacy');
  });

  it('a raw keyless row from a legacy peer sorts last, converges, and is backfilled', () => {
    const a = seedLegacyTable(2, 2);
    const b = fork(a);
    tableMoveRow(a, 'tbl', 'row0', 1); // A migrates (render order: row1, row0)
    // B, still running legacy code, pushes a raw row: no ord, no col bindings.
    const rowsArr = blockChildren(tableBlock(b))!;
    b.transact(() => {
      rowsArr.insert(1, [
        makeBlock({
          id: 'rowX',
          type: 'row',
          children: [
            {id: 'x0', type: 'cell', text: 'x0'},
            {id: 'x1', type: 'cell', text: 'x1'},
          ],
        }),
      ]);
    }, 'local');
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    // Keyless rows render last (transient state); keyless cells bind by position.
    expect(rowOrder(a)).toEqual(['row1', 'row0', 'rowX']);
    expect(renderText(a)[2]).toEqual(['x0', 'x1']);

    tableInsertRow(a, 'tbl', 3); // ANY structural op backfills rowX in place
    const ords = tableGrid(tableBlock(a)).rows.map((r) => (r.get('props') as Y.Map<unknown> | undefined)?.get('ord'));
    expect(ords.every((k) => isOrderKey(k))).toBe(true);
    expect(rowOrder(a).slice(0, 3)).toEqual(['row1', 'row0', 'rowX']); // render order preserved
  });
});

// ── Order consumers ──────────────────────────────────────────────────────────

describe('table order contract — consumers honour render order', () => {
  it('cellPosition / cellNeighbor navigate in sorted order', () => {
    const doc = seedTable();
    tableMoveRow(doc, 'tbl', 'row0', 2); // render: row1, row2, row0
    tableMoveColumn(doc, 'tbl', 'c0', 2); // render: c1, c2, c0

    const pos = cellPosition(doc, 'r0c0');
    expect(pos).toMatchObject({row: 2, col: 2, rows: 3, cols: 3});
    // Tab from the row-2 col-1 cell walks the SORTED grid.
    expect(cellNeighbor(doc, 'r0c2', 'next')).toBe('r0c0'); // c2 → c0 (last col)
    expect(cellNeighbor(doc, 'r0c0', 'next')).toBeNull(); // bottom-right edge
    expect(cellNeighbor(doc, 'r1c1', 'down')).toBe('r2c1'); // column-stable
    expect(cellNeighbor(doc, 'r2c1', 'down')).toBe('r0c1');
    expect(cellNeighbor(doc, 'r1c1', 'up')).toBeNull(); // r1 renders first
  });

  it('HTML and Markdown exports emit rows/cells in render order', () => {
    const doc = seedTable(2, 2);
    tableMoveRow(doc, 'tbl', 'row0', 1);
    tableMoveColumn(doc, 'tbl', 'c0', 1);
    const json = docToJSON(doc);
    const html = blocksToHtml(json);
    expect(html.indexOf('r1c1')).toBeLessThan(html.indexOf('r1c0'));
    expect(html.indexOf('r1c0')).toBeLessThan(html.indexOf('r0c1'));
    const md = blocksToMarkdown(json);
    expect(md.indexOf('r1c1')).toBeLessThan(md.indexOf('r0c1'));
    expect(md.split('\n')[0]).toContain('r1c1 | r1c0');
  });

  it('pasted tables (htmlToBlocks) are born keyed', async () => {
    const {htmlToBlocks} = await import('../model');
    const blocks = htmlToBlocks('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    const table = blocks.find((b) => b.type === 'table')! as BlockJSON;
    const colEntries = Object.keys(table.props ?? {}).filter((k) => k.startsWith(TABLE_COL_PREFIX));
    expect(colEntries).toHaveLength(2);
    for (const row of table.children ?? []) {
      expect(isOrderKey((row.props as Record<string, unknown>).ord)).toBe(true);
      for (const cell of row.children ?? []) expect((cell.props as Record<string, unknown>).col).toMatch(/^c\d+$/);
    }
  });

  it('a cell for a concurrently-deleted column hides — the column never resurrects', () => {
    const a = seedTable(2, 2);
    const b = fork(a);
    tableDeleteColumn(a, 'tbl', 1); // A deletes c1 (registry entry + its cells)
    tableInsertRow(b, 'tbl', 2); // B appends a row — which carries a c1-bound cell
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(tableColumns(tableBlock(a))).toHaveLength(1);
    // The merged new row has a ghost c1 cell: hidden, not rendered, and it
    // does not resurrect the deleted column.
    expect(renderText(a)).toEqual([['r0c0'], ['r1c0'], ['']]);
  });

  it('malformed row key (trailing zero) + a keyless row: backfill repairs, never wedges', () => {
    const doc = seedTable(3, 2);
    doc.transact(() => {
      // Last-sorted row carries a malformed key (trailing zero — invalid) …
      (findBlock(doc, 'row2')!.block.get('props') as Y.Map<unknown>).set('ord', 'z0');
      // … plus a keyless row (its cells stay column-bound to isolate the row axis).
      blockChildren(tableBlock(doc))!.insert(3, [
        makeBlock({
          id: 'rowX',
          type: 'row',
          children: [
            {id: 'x0', type: 'cell', text: 'x0', props: {col: 'c0'}},
            {id: 'x1', type: 'cell', text: 'x1', props: {col: 'c1'}},
          ],
        }),
      ]);
    }, 'local');
    expect(rowOrder(doc)).toEqual(['row0', 'row1', 'row2', 'rowX']); // 'z0' sorts last among keyed

    expect(() => tableInsertRow(doc, 'tbl', 4)).not.toThrow();
    const ords = tableGrid(tableBlock(doc)).rows.map((r) => (r.get('props') as Y.Map<unknown>).get('ord'));
    expect(ords.every((k) => isOrderKey(k))).toBe(true); // axis fully repaired
    expect(rowOrder(doc).slice(0, 4)).toEqual(['row0', 'row1', 'row2', 'rowX']); // render order preserved

    tableMoveRow(doc, 'tbl', 'row0', 2); // a follow-up op still works
    expect(rowOrder(doc)[0]).not.toBe('row0');
    expect([...rowOrder(doc)].filter((id) => id === 'row0')).toHaveLength(1);
  });

  it('malformed registry key + a wider keyless row: column backfill repairs, never wedges', () => {
    const doc = seedTable(2, 2);
    doc.transact(() => {
      // Last-sorted column registry value is malformed (trailing zero — invalid) …
      (tableBlock(doc).get('props') as Y.Map<unknown>).set(`${TABLE_COL_PREFIX}c1`, 'z0');
      // … plus a keyless, extra-wide row (3 cells) that forces a column backfill.
      blockChildren(tableBlock(doc))!.insert(2, [
        makeBlock({
          id: 'rowX',
          type: 'row',
          props: {ord: 'x'},
          children: [
            {id: 'x0', type: 'cell', text: 'x0'},
            {id: 'x1', type: 'cell', text: 'x1'},
            {id: 'x2', type: 'cell', text: 'x2'},
          ],
        }),
      ]);
    }, 'local');
    const colsBefore = tableColumns(tableBlock(doc)).map((c) => c.id);
    expect(colsBefore).toEqual(['c0', 'c1']); // 'z0' sorts c1 last

    expect(() => tableInsertColumn(doc, 'tbl', 3)).not.toThrow();
    const cols = tableColumns(tableBlock(doc));
    expect(cols.map((c) => c.key).every((k) => isOrderKey(k))).toBe(true); // registry fully repaired
    expect(cols.slice(0, 2).map((c) => c.id)).toEqual(['c0', 'c1']); // column order preserved

    tableMoveColumn(doc, 'tbl', 'c0', 2); // a follow-up op still works
    const after = tableColumns(tableBlock(doc)).map((c) => c.id);
    expect(after.filter((id) => id === 'c0')).toHaveLength(1);
    expect(after[0]).not.toBe('c0');
  });

  it('malformed-key repair converges: the repaired peer syncs identically to a fresh peer', () => {
    const a = seedTable(3, 2);
    a.transact(() => {
      (findBlock(a, 'row2')!.block.get('props') as Y.Map<unknown>).set('ord', 'z0');
      blockChildren(tableBlock(a))!.insert(3, [
        makeBlock({
          id: 'rowX',
          type: 'row',
          children: [
            {id: 'x0', type: 'cell', text: 'x0', props: {col: 'c0'}},
            {id: 'x1', type: 'cell', text: 'x1', props: {col: 'c1'}},
          ],
        }),
      ]);
    }, 'local');
    const b = fork(a);
    tableInsertRow(a, 'tbl', 4); // A repairs the axis on the first structural op
    sync(a, b);
    expect(docToJSON(a)).toEqual(docToJSON(b));
  });

  it('rebalance: degenerate key bounds rewrite the axis and keep order', () => {
    const doc = seedTable(3, 2);
    // Force a key tie: two rows with the SAME ord (merge-artifact shape).
    const r0 = findBlock(doc, 'row0')!.block;
    const r1 = findBlock(doc, 'row1')!.block;
    doc.transact(() => {
      (r0.get('props') as Y.Map<unknown>).set('ord', 'V');
      (r1.get('props') as Y.Map<unknown>).set('ord', 'V');
    }, 'local');
    tableMoveRow(doc, 'tbl', 'row2', 1); // between the tied pair → rebalance
    const ords = tableGrid(tableBlock(doc)).rows.map((r) => (r.get('props') as Y.Map<unknown>).get('ord') as string);
    expect(new Set(ords).size).toBe(3); // all distinct again
    expect(rowOrder(doc)[1]).toBe('row2');
    for (const k of ords) expect(isOrderKey(k)).toBe(true);
  });
});
