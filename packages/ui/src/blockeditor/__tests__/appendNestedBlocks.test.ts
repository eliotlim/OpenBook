import {describe, it, expect} from 'vitest';
import {appendBlocksToSnapshot, type AppendBlock, type PageSnapshot} from '@book.dev/sdk';
import {
  blockChildren,
  blockId,
  blockToJSON,
  decodeSnapshot,
  encodeSnapshot,
  patchBlock,
  findBlock,
  rootBlocks,
  tableColumns,
  tableGrid,
  tableInsertRow,
  type BlockDocSnapshot,
} from '../model';

/**
 * API-1 end-to-end at the MODEL level: a NESTED `append_blocks` payload (the MCP
 * write path) → the blockdoc JSON projection → REOPENED as a real CRDT document.
 *
 * The bug this pins: the projection used to be flat (`id/type/text/props`), so
 * every `children` array was silently dropped — a `table`/`columns` payload landed
 * as one empty container. The apply layer was never the problem (it recurses); the
 * projection was.
 *
 * The table case is the load-bearing one: an MCP payload cannot invent the `col:` /
 * `ord` ORDER KEYS a keyed table uses, so the reopened table is a "legacy" one —
 * it must render in payload order immediately, and the first structural op must
 * lazily backfill the keys (`ensureTableOrderInTx`) WITHOUT reshuffling the grid.
 */

/** An empty block-editor page snapshot (with a stale CRDT update, like a saved page). */
const emptyPage = (): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: [], update: 'STALE'}} as unknown as PageSnapshot);

/** Append a payload the way the MCP `append_blocks` tool does, then OPEN the page. */
const appendAndOpen = (blocks: AppendBlock[]): ReturnType<typeof decodeSnapshot> => {
  const data = appendBlocksToSnapshot(emptyPage(), blocks, 'mcp');
  return decodeSnapshot(data!.blockdoc as BlockDocSnapshot);
};

/** Round-trip an open doc through the stored snapshot (save → reopen). */
const reopen = (doc: ReturnType<typeof decodeSnapshot>): ReturnType<typeof decodeSnapshot> => decodeSnapshot(encodeSnapshot(doc));

/** `[['a','b'],['c','d']]` — the grid's cell texts in RENDER order. */
const gridText = (doc: ReturnType<typeof decodeSnapshot>, tableId: string): string[][] => {
  const table = findBlock(doc, tableId)!.block;
  return tableGrid(table).cells.map((row) => row.map((cell) => (cell ? (blockToJSON(cell).text?.[0]?.t ?? '') : '')));
};

const TABLE_PAYLOAD: AppendBlock[] = [
  {
    type: 'table',
    props: {header: true},
    children: [
      {type: 'row', props: {header: true}, children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}, {type: 'cell', text: 'Price'}]},
      {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}, {type: 'cell', text: '1.20'}]},
      {type: 'row', children: [{type: 'cell', text: 'Pears'}, {type: 'cell', text: '5'}, {type: 'cell', text: '2.40'}]},
    ],
  },
];

describe('nested append payload → reopened document (API-1)', () => {
  it('a columns/group payload materializes as real CRDT containers, not one empty block', () => {
    const doc = appendAndOpen([
      {
        type: 'columns',
        children: [
          {type: 'column', props: {span: 5}, children: [{type: 'slider', props: {name: 'spent', value: 80}}]},
          {type: 'column', props: {span: 7}, children: [{type: 'group', children: [{type: 'paragraph', text: 'Deep'}]}]},
        ],
      },
    ]);
    const columns = rootBlocks(doc).get(0);
    // Y children really exist (a JSON echo alone would pass the projection test).
    expect(blockChildren(columns)?.length).toBe(2);
    const json = blockToJSON(columns);
    expect(json.children?.[0].children?.[0].props?.name).toBe('spent');
    expect(json.children?.[1].children?.[0].children?.[0].text?.[0].t).toBe('Deep');
    // Every level kept its position-derived id, so a nested block is addressable
    // afterwards (inspect_page_structure → update_block / delete_block).
    expect(findBlock(doc, 'mcp-0-1-0-0')?.block).toBeDefined();
  });

  it('a table → row → cell payload opens as a WORKING table: 3×3 in payload order', () => {
    const doc = appendAndOpen(TABLE_PAYLOAD);
    const grid = tableGrid(findBlock(doc, 'mcp-0')!.block);
    expect(grid.rows.length).toBe(3);
    expect(grid.width).toBe(3);
    // No order keys in an MCP payload → a legacy (unkeyed) table that renders in
    // pure array order. Content is correct BEFORE any migration runs.
    expect(grid.keyed).toBe(false);
    expect(gridText(doc, 'mcp-0')).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
    ]);
  });

  it('the first structural op backfills col:/ord keys (ensureTableOrderInTx) WITHOUT reshuffling the grid', () => {
    const doc = appendAndOpen(TABLE_PAYLOAD);
    expect(tableColumns(findBlock(doc, 'mcp-0')!.block)).toHaveLength(0); // unkeyed on open

    // Any structural op migrates lazily inside its own transaction. Insert a row at
    // the end (index 3) so the existing three rows must keep their order.
    tableInsertRow(doc, 'mcp-0', 3);

    const table = findBlock(doc, 'mcp-0')!.block;
    const grid = tableGrid(table);
    expect(grid.keyed).toBe(true); // registry now exists
    expect(tableColumns(table)).toHaveLength(3); // one column per payload cell
    // Every original cell is still bound to the column it was rendered in…
    expect(gridText(doc, 'mcp-0').slice(0, 3)).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
    ]);
    // …and the inserted row landed last with a full-width set of empty cells.
    expect(grid.rows).toHaveLength(4);
    expect(gridText(doc, 'mcp-0')[3]).toEqual(['', '', '']);
    // Rows are keyed by `ord`, cells bound by `col` — the keyed invariants.
    expect(grid.rows.every((r) => typeof blockToJSON(r).props?.ord === 'string')).toBe(true);
    expect(grid.cells.flat().every((c) => c === null || typeof blockToJSON(c).props?.col === 'string')).toBe(true);
  });

  it('the keyed table survives a save→reopen round trip with the same grid', () => {
    const doc = appendAndOpen(TABLE_PAYLOAD);
    tableInsertRow(doc, 'mcp-0', 3);
    const before = gridText(doc, 'mcp-0');
    const rowIds = tableGrid(findBlock(doc, 'mcp-0')!.block).rows.map(blockId);

    const again = reopen(doc);
    expect(gridText(again, 'mcp-0')).toEqual(before);
    expect(tableGrid(findBlock(again, 'mcp-0')!.block).rows.map(blockId)).toEqual(rowIds);
    expect(tableGrid(findBlock(again, 'mcp-0')!.block).keyed).toBe(true);
  });

  it('a row/cell nested in the payload is deletable and patchable by its projected id', () => {
    const doc = appendAndOpen(TABLE_PAYLOAD);
    // update_block_props on a nested ROW (header flag), then delete_block on it.
    patchBlock(findBlock(doc, 'mcp-0-2')!.block, {props: {header: true, bg: null}});
    expect(blockToJSON(findBlock(doc, 'mcp-0-2')!.block).props?.header).toBe(true);

    const found = findBlock(doc, 'mcp-0-2')!;
    found.parent.delete(found.index, 1); // the bridge's delete_block
    expect(findBlock(doc, 'mcp-0-2')).toBeNull();
    expect(gridText(doc, 'mcp-0')).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
    ]);
  });
});

describe('patchBlock prop removal (MCP update_block_props null semantics)', () => {
  it('an explicit null REMOVES the key while other props survive the shallow merge', () => {
    const doc = appendAndOpen([{type: 'callout', text: 'note', props: {variant: 'warn', bg: 'amber'}}]);
    patchBlock(findBlock(doc, 'mcp-0')!.block, {props: {bg: null, icon: '★'}});
    const props = blockToJSON(findBlock(doc, 'mcp-0')!.block).props ?? {};
    expect('bg' in props).toBe(false); // removed, not set to null
    expect(props.variant).toBe('warn'); // untouched
    expect(props.icon).toBe('★'); // added
  });
});
