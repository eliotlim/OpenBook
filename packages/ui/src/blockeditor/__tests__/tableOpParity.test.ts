import {describe, it, expect} from 'vitest';
import {
  appendBlocksToSnapshot,
  applyTableOpToSnapshot,
  resolveTableOp,
  snapshotTableView,
  tableOpError,
  tableShapeOf,
  type AppendBlock,
  type PageSnapshot,
  type TableOpAddress,
  type TableOpKind,
} from '@book.dev/sdk';
import {applyProposalToDoc} from '@/lib/aiBridge';
import {
  blockId,
  blockToJSON,
  decodeSnapshot,
  encodeSnapshot,
  findBlock,
  setTableColumnColor,
  setTableRowColor,
  tableDeleteColumn,
  tableDeleteRow,
  tableDuplicateRow,
  tableGrid,
  tableInsertColumn,
  tableInsertRow,
  tableMoveColumn,
  tableMoveRow,
  type BlockDocSnapshot,
} from '../model';

/**
 * API-3 THE INVARIANT TEST: the same table op sequence must produce the same
 * grid whichever of the THREE paths runs it —
 *
 *   1. EDITOR      — the `model.ts` op called directly on a live Y.Doc (what the
 *                    context menu does);
 *   2. PROPOSAL    — an `AgentProposal` (`kind: 'table_*'`, sorted coordinates in
 *                    its payload) replayed through the editor bridge, which is
 *                    also the path an ACCEPTED suggestion takes;
 *   3. SNAPSHOT    — the SDK's `applyTableOpToSnapshot` on the stored JSON
 *                    projection (what the MCP tools do with no live editor),
 *                    then REOPENED as a CRDT document.
 *
 * They share the addressing resolver and the guard table (`resolveTableOp` /
 * `tableOpError` in the SDK) and the same order-key algebra, but the mutations
 * themselves are two implementations — Y types vs JSON. This test is what stops
 * them drifting.
 */

const TABLE: AppendBlock[] = [
  {
    type: 'table',
    props: {header: true},
    children: [
      {type: 'row', children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}, {type: 'cell', text: 'Price'}]},
      {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}, {type: 'cell', text: '1.20'}]},
      {type: 'row', children: [{type: 'cell', text: 'Pears'}, {type: 'cell', text: '5'}, {type: 'cell', text: '2.40'}]},
      {type: 'row', children: [{type: 'cell', text: 'Plums'}, {type: 'cell', text: '8'}, {type: 'cell', text: '3.60'}]},
    ],
  },
];

const TABLE_ID = 't-0';
const PAGE_ID = 'page-1';

const emptyPage = (): PageSnapshot =>
  ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: [], update: 'STALE'}} as unknown as PageSnapshot);

/** A stored page carrying one 4×3 table at `t-0`, exactly as `append_blocks` builds it. */
const storedPage = (): PageSnapshot => appendBlocksToSnapshot(emptyPage(), TABLE, 't')!;

type Doc = ReturnType<typeof decodeSnapshot>;

const openDoc = (data: PageSnapshot): Doc => decodeSnapshot(data.blockdoc as BlockDocSnapshot);

/** Cell texts in RENDER (sorted) order — the observable both paths must agree on. */
const gridText = (doc: Doc): string[][] =>
  tableGrid(findBlock(doc, TABLE_ID)!.block).cells.map((row) => row.map((cell) => (cell ? (blockToJSON(cell).text?.[0]?.t ?? '') : '')));

/**
 * Column ids in render order, and each row's / column's tint — the keyed
 * metadata. A column MINTED by an insert gets a random `col_xxxxxxxx` id on every
 * path (as it must — ids are node identity, not order), so those normalize to
 * `fresh`; the DETERMINISTIC migration ids (`c0…cN-1`) are compared verbatim,
 * which is the part the paths have to agree on.
 */
const gridMeta = (doc: Doc): {colIds: string[]; tints: Array<string | null>; colTints: Array<string | null>} => {
  const table = findBlock(doc, TABLE_ID)!.block;
  const grid = tableGrid(table);
  const props = blockToJSON(table).props ?? {};
  return {
    colIds: grid.colIds.map((id) => (/^c\d+$/.test(id) ? id : 'fresh')),
    tints: grid.rows.map((r) => (blockToJSON(r).props?.bg as string | undefined) ?? null),
    colTints: grid.colIds.map((id) => (props[`colbg:${id}`] as string | undefined) ?? null),
  };
};

/** One op in the shared vocabulary, addressed the way a proposal/tool would. */
interface Step {
  kind: TableOpKind;
  address: TableOpAddress;
}

/** PATH 1 — call the editor's model op directly, as the context menu does. */
const runEditor = (doc: Doc, step: Step): void => {
  const view = liveView(doc);
  const resolved = resolveTableOp(view, step.kind, step.address);
  if ('error' in resolved) throw new Error(resolved.error);
  const {op} = resolved;
  switch (step.kind) {
  case 'table_insert_row': tableInsertRow(doc, TABLE_ID, op.rowIndex!); return;
  case 'table_delete_row': tableDeleteRow(doc, TABLE_ID, op.rowIndex!); return;
  case 'table_duplicate_row': tableDuplicateRow(doc, TABLE_ID, op.rowIndex!); return;
  case 'table_insert_column': tableInsertColumn(doc, TABLE_ID, op.colIndex!); return;
  case 'table_delete_column': tableDeleteColumn(doc, TABLE_ID, op.colIndex!); return;
  case 'table_move_row': tableMoveRow(doc, TABLE_ID, view.rowIds[op.rowIndex!], op.toIndex!); return;
  case 'table_move_column': tableMoveColumn(doc, TABLE_ID, view.colIds[op.colIndex!], op.toIndex!); return;
  case 'table_set_row_color': setTableRowColor(doc, TABLE_ID, view.rowIds[op.rowIndex!], op.color ?? null); return;
  case 'table_set_column_color': setTableColumnColor(doc, TABLE_ID, view.colIds[op.colIndex!], op.color ?? null); return;
  case 'table_set_cell': {
    // The editor writes a cell through ordinary text editing; the proposal path's
    // `table_set_cell` is the same write, so replay it there.
    applyProposalToDoc(doc, {id: 's', kind: step.kind, summary: '', pageId: PAGE_ID, payload: {pageId: PAGE_ID, tableId: TABLE_ID, ...step.address}});
    return;
  }
  }
};

/** A sorted view of the live table (mirrors the bridge's own `liveTableView`). */
const liveView = (doc: Doc) => snapshotTableView({...emptyPage(), blockdoc: encodeSnapshot(doc)} as PageSnapshot, TABLE_ID)!;

/** PATH 2 — replay an AgentProposal through the editor bridge. */
const runProposal = (doc: Doc, step: Step): void => {
  applyProposalToDoc(doc, {
    id: `p-${step.kind}`,
    kind: step.kind,
    summary: step.kind,
    pageId: PAGE_ID,
    payload: {pageId: PAGE_ID, tableId: TABLE_ID, ...step.address},
  });
};

/** PATH 3 — mutate the stored JSON projection (the MCP no-live-editor path). */
const runSnapshot = (data: PageSnapshot, step: Step): PageSnapshot => {
  const view = snapshotTableView(data, TABLE_ID)!;
  const resolved = resolveTableOp(view, step.kind, step.address);
  if ('error' in resolved) throw new Error(resolved.error);
  const bad = tableOpError(tableShapeOf(view), resolved.op);
  if (bad) throw new Error(bad);
  return applyTableOpToSnapshot(data, TABLE_ID, resolved.op)!.data;
};

/**
 * The op sequence every path replays. Chosen to exercise all seven structural ops
 * plus cell text and both tints, and to leave the grid asymmetric enough that a
 * sorted-vs-array-order mistake in any path shows up as different text.
 */
const SEQUENCE: Step[] = [
  {kind: 'table_insert_row', address: {rowIndex: 2}},
  {kind: 'table_set_cell', address: {rowIndex: 2, colIndex: 0, text: 'Cherries'}},
  {kind: 'table_set_cell', address: {rowIndex: 2, colIndex: 1, text: '11'}},
  {kind: 'table_insert_column', address: {colIndex: 1}},
  {kind: 'table_set_cell', address: {rowIndex: 0, colIndex: 1, text: 'Bin'}},
  {kind: 'table_move_column', address: {colIndex: 1, toIndex: 3}},
  {kind: 'table_duplicate_row', address: {rowIndex: 3}},
  {kind: 'table_move_row', address: {rowIndex: 4, toIndex: 1}},
  {kind: 'table_set_row_color', address: {rowIndex: 1, color: 'amber'}},
  {kind: 'table_set_column_color', address: {colIndex: 2, color: 'blue'}},
  {kind: 'table_delete_row', address: {rowIndex: 5}},
  {kind: 'table_delete_column', address: {colIndex: 0}},
];

describe('table ops: editor / agent-proposal / snapshot paths agree (API-3)', () => {
  it('the same op sequence yields the same grid on all three paths', () => {
    const editorDoc = openDoc(storedPage());
    SEQUENCE.forEach((step) => runEditor(editorDoc, step));

    const proposalDoc = openDoc(storedPage());
    SEQUENCE.forEach((step) => runProposal(proposalDoc, step));

    let snapshot = storedPage();
    SEQUENCE.forEach((step) => {
      snapshot = runSnapshot(snapshot, step);
    });
    const snapshotDoc = openDoc(snapshot);

    const expected = gridText(editorDoc);
    // Sanity: the sequence really did rearrange the table (not a no-op comparison).
    expect(expected).not.toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
      ['Plums', '8', '3.60'],
    ]);
    expect(gridText(proposalDoc)).toEqual(expected);
    expect(gridText(snapshotDoc)).toEqual(expected);

    // …and the keyed metadata (column registry + tints) matches too, so the paths
    // agree on order KEYS, not just on the rendered text.
    const meta = gridMeta(editorDoc);
    expect(gridMeta(proposalDoc)).toEqual(meta);
    expect(gridMeta(snapshotDoc)).toEqual(meta);
  });

  it('each path survives a save → reopen round trip with the same grid', () => {
    let snapshot = storedPage();
    SEQUENCE.forEach((step) => {
      snapshot = runSnapshot(snapshot, step);
    });
    const doc = openDoc(snapshot);
    const before = gridText(doc);
    const rowIds = tableGrid(findBlock(doc, TABLE_ID)!.block).rows.map(blockId);

    const again = decodeSnapshot(encodeSnapshot(doc));
    expect(gridText(again)).toEqual(before);
    expect(tableGrid(findBlock(again, TABLE_ID)!.block).rows.map(blockId)).toEqual(rowIds);
    expect(tableGrid(findBlock(again, TABLE_ID)!.block).keyed).toBe(true);
  });

  it('the snapshot path migrates col:/ord to the SAME keys the editor would', () => {
    // One insert is enough to force migration on both paths.
    const step: Step = {kind: 'table_insert_row', address: {rowIndex: 4}};
    const editorDoc = openDoc(storedPage());
    runEditor(editorDoc, step);
    const snapshotDoc = openDoc(runSnapshot(storedPage(), step));

    const ords = (doc: Doc): Array<unknown> =>
      tableGrid(findBlock(doc, TABLE_ID)!.block).rows.map((r) => blockToJSON(r).props?.ord);
    const cols = (doc: Doc): Record<string, unknown> => {
      const props = blockToJSON(findBlock(doc, TABLE_ID)!.block).props ?? {};
      return Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith('col:')));
    };
    // Deterministic migration ⇒ identical column ids AND identical fractional keys.
    expect(cols(snapshotDoc)).toEqual(cols(editorDoc));
    // The four original rows get identical `ord`s; the inserted row's key is
    // minted from the same bounds, so it matches too.
    expect(ords(snapshotDoc)).toEqual(ords(editorDoc));
  });
});

describe('table proposals: payload → apply round trip (API-3)', () => {
  const proposal = (kind: TableOpKind, payload: Record<string, unknown>) => ({
    id: 'p1',
    kind,
    summary: kind,
    pageId: PAGE_ID,
    payload: {pageId: PAGE_ID, ...payload},
  });

  it('addresses a cell BY ID as well as by row/column index', () => {
    const doc = openDoc(storedPage());
    const cellId = blockId(tableGrid(findBlock(doc, TABLE_ID)!.block).cells[2][1]!);
    // No tableId in the payload — the cell id alone identifies the table.
    applyProposalToDoc(doc, proposal('table_set_cell', {cellId, text: '99'}));
    expect(gridText(doc)[2]).toEqual(['Pears', '99', '2.40']);
  });

  it('addresses a row BY ID for a move (the id survives a concurrent reorder)', () => {
    const doc = openDoc(storedPage());
    const rowId = blockId(tableGrid(findBlock(doc, TABLE_ID)!.block).rows[3]);
    applyProposalToDoc(doc, proposal('table_move_row', {rowId, toIndex: 1}));
    expect(gridText(doc).map((r) => r[0])).toEqual(['Item', 'Plums', 'Apples', 'Pears']);
  });

  it('addresses a column BY ID for a move and a tint', () => {
    const doc = openDoc(storedPage());
    tableInsertRow(doc, TABLE_ID, 4); // migrate so col ids exist
    const colId = tableGrid(findBlock(doc, TABLE_ID)!.block).colIds[2];
    applyProposalToDoc(doc, proposal('table_move_column', {tableId: TABLE_ID, colId, toIndex: 0}));
    expect(gridText(doc)[0]).toEqual(['Price', 'Item', 'Qty']);
    applyProposalToDoc(doc, proposal('table_set_column_color', {tableId: TABLE_ID, colId, color: 'blue'}));
    expect(blockToJSON(findBlock(doc, TABLE_ID)!.block).props?.[`colbg:${colId}`]).toBe('blue');
  });

  it('every structural kind round-trips through the bridge', () => {
    const doc = openDoc(storedPage());
    applyProposalToDoc(doc, proposal('table_insert_row', {tableId: TABLE_ID, rowIndex: 1}));
    applyProposalToDoc(doc, proposal('table_duplicate_row', {tableId: TABLE_ID, rowIndex: 2}));
    applyProposalToDoc(doc, proposal('table_insert_column', {tableId: TABLE_ID, colIndex: 3}));
    applyProposalToDoc(doc, proposal('table_move_row', {tableId: TABLE_ID, rowIndex: 1, toIndex: 4}));
    applyProposalToDoc(doc, proposal('table_move_column', {tableId: TABLE_ID, colIndex: 3, toIndex: 0}));
    applyProposalToDoc(doc, proposal('table_delete_row', {tableId: TABLE_ID, rowIndex: 4}));
    applyProposalToDoc(doc, proposal('table_delete_column', {tableId: TABLE_ID, colIndex: 0}));
    applyProposalToDoc(doc, proposal('table_set_row_color', {tableId: TABLE_ID, rowIndex: 1, color: 'amber'}));
    expect(gridText(doc)).toEqual([
      ['Item', 'Qty', 'Price'],
      ['Apples', '3', '1.20'],
      ['Apples', '3', '1.20'],
      ['Pears', '5', '2.40'],
      ['Plums', '8', '3.60'],
    ]);
  });

  it('a whole proposal is ONE undo step (the nested model transacts fold in)', () => {
    const doc = openDoc(storedPage());
    let transactions = 0;
    doc.on('afterTransaction', () => {
      transactions += 1;
    });
    applyProposalToDoc(doc, proposal('table_duplicate_row', {tableId: TABLE_ID, rowIndex: 1}));
    expect(transactions).toBe(1);
  });

  it('refuses inserting above the header row, leaving the table untouched', () => {
    const doc = openDoc(storedPage());
    const before = gridText(doc);
    expect(() => applyProposalToDoc(doc, proposal('table_insert_row', {tableId: TABLE_ID, rowIndex: 0}))).toThrow(/above the header row/);
    expect(gridText(doc)).toEqual(before);
  });

  it('refuses out-of-range coordinates and unknown ids with a clean message', () => {
    const doc = openDoc(storedPage());
    const before = gridText(doc);
    expect(() => applyProposalToDoc(doc, proposal('table_delete_row', {tableId: TABLE_ID, rowIndex: 9}))).toThrow(/out of range/);
    expect(() => applyProposalToDoc(doc, proposal('table_set_cell', {cellId: 'ghost', text: 'x'}))).toThrow(/no cell "ghost"/);
    expect(() => applyProposalToDoc(doc, proposal('table_move_row', {tableId: 'nope', rowIndex: 0, toIndex: 1}))).toThrow(/no table "nope"/);
    expect(() => applyProposalToDoc(doc, proposal('table_delete_row', {rowIndex: 0}))).toThrow(/needs a tableId/);
    expect(gridText(doc)).toEqual(before);
  });

  it('deleting the last row removes the whole table, as in the editor', () => {
    const doc = openDoc(appendBlocksToSnapshot(emptyPage(), [{type: 'table', children: [{type: 'row', children: [{type: 'cell', text: 'only'}]}]}], 't')!);
    applyProposalToDoc(doc, proposal('table_delete_row', {tableId: TABLE_ID, rowIndex: 0}));
    expect(findBlock(doc, TABLE_ID)).toBeNull();
  });
});
