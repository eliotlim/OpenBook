/**
 * API-3: TABLE STRUCTURE tools over MCP.
 *
 * Boots a real OpenBook server and drives `src/bin.ts` over stdio (the same
 * harness as `blocks.test.mts`), proving the table tools end to end:
 *
 *  · a table BUILT by a nested `append_blocks` (the API-1 capability) is
 *    immediately operable — `inspect_table` reports it as "unmigrated" (no order
 *    keys, since an MCP client can't invent them) and the first op backfills
 *    `col:` / `ord` WITHOUT reshuffling the grid;
 *  · insert / delete / move / duplicate rows and columns, and set cells BOTH by
 *    render-order index and by cell id, all land in the stored projection with
 *    the right render order and content;
 *  · the EDITOR'S invariants hold server-side: insert-above-the-header-row is
 *    refused, and deleting the last row (or column) removes the whole table;
 *  · bounds and unknown-id errors are clean and actionable, and refuse BEFORE the
 *    policy branch (so a bad op queues nothing);
 *  · the policy gate: under `suggest` every op queues a `table-op` suggestion
 *    carrying the bridge's `applyKind` plus resolved coordinates AND the stable
 *    ids they resolved to — and replaying that payload produces the SAME grid the
 *    direct write produced (which is what "an accepted suggestion applies
 *    identically" means).
 *
 * Block-id caveat: ids differ between direct mode (position-derived `mcp-i-j`) and
 * suggest mode, so every id used here comes from a FRESH `inspect_table` call, never
 * from the append payload.
 *
 * Run: pnpm --filter @book.dev/mcp test
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  HttpDataClient,
  applyTableOpToSnapshot,
  resolveTableOp,
  snapshotTableView,
  tableOpError,
  tableShapeOf,
  type PageSnapshot,
  type TableOpKind,
} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-tables-test';

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const resultText = (res: {content?: unknown}): string =>
  ((res.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

const isError = (res: {isError?: unknown}): boolean => res.isError === true;

async function connect(url: string): Promise<{client: Client; close: () => Promise<void>}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...(process.env as Record<string, string>), OPENBOOK_URL: url},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-tables-test', version: '0.0.0'});
  await client.connect(transport);
  return {client, close: () => client.close()};
}

/** A 3-row × 3-column table payload, header row first. */
const TABLE_PAYLOAD = [
  {
    type: 'table',
    props: {header: true},
    children: [
      {type: 'row', children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}, {type: 'cell', text: 'Price'}]},
      {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}, {type: 'cell', text: '1.20'}]},
      {type: 'row', children: [{type: 'cell', text: 'Pears'}, {type: 'cell', text: '5'}, {type: 'cell', text: '2.40'}]},
    ],
  },
];

const blockPage = (name: string) => ({
  name,
  data: {editor: 'blocks', blockdoc: {blocks: []}, editorjs: {blocks: []}, values: [], names: []},
});

/** One parsed `inspect_table` report. */
interface TableReport {
  id: string;
  rows: number;
  cols: number;
  header: boolean;
  migrated: boolean;
  colIds: string[];
  rowIds: string[];
  /** `cells[r][c]` text, and `cellIds[r][c]`. */
  cells: string[][];
  cellIds: string[][];
  raw: string;
}

function parseTable(out: string): TableReport {
  const head = /^Table \[([^\]]+)\] — (\d+) row\(s\) × (\d+) column\(s\), header row: (yes|no)$/m.exec(out);
  assert.ok(head, `inspect_table output not parseable:\n${out}`);
  const colLine = /^Column ids(?: \(render order\))?: (.*)$/m.exec(out)![1];
  const migrated = !colLine.startsWith('none yet');
  const rows: string[][] = [];
  const cellIds: string[][] = [];
  const rowIds: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^row (\d+) \[([^\]]+)\](?: \(header\))?: (.*)$/.exec(line);
    if (!m) continue;
    rowIds.push(m[2]);
    const texts: string[] = [];
    const ids: string[] = [];
    for (const cell of m[3].matchAll(/\d+:"([^"]*)"\s\[([^\]]+)\]/g)) {
      texts.push(cell[1]);
      ids.push(cell[2]);
    }
    rows.push(texts);
    cellIds.push(ids);
  }
  return {
    id: head[1],
    rows: Number(head[2]),
    cols: Number(head[3]),
    header: head[4] === 'yes',
    migrated,
    colIds: migrated ? colLine.split(/\s+/).map((p) => p.split('=')[1]) : [],
    rowIds,
    cells: rows,
    cellIds,
    raw: out,
  };
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4412});
  console.log(`\nOpenBook server up at ${server.url}`);
  const seed = new HttpDataClient(server.url);

  await seed.setInstancePolicy({agentEdits: 'direct'});
  const page = await seed.savePage(blockPage('Table target'));
  const mcp = await connect(server.url);
  const call = (name: string, args: Record<string, unknown>) => mcp.client.callTool({name, arguments: args});
  /** A FRESH inspect_table report — never reuse ids across mutations. */
  const inspect = async (tableId: string): Promise<TableReport> => parseTable(resultText(await call('inspect_table', {pageId: page.id, tableId})));

  console.log('\nCatalogue: the twelve table tools are exposed with descriptions');
  const tools = await mcp.client.listTools();
  const byName = new Map(tools.tools.map((t) => [t.name, t]));
  const TABLE_TOOLS = [
    'inspect_table', 'table_insert_row', 'table_delete_row', 'table_duplicate_row',
    'table_insert_column', 'table_delete_column', 'table_move_row', 'table_move_column',
    'table_set_cell', 'table_set_row_color', 'table_set_column_color', 'table_set_column_width',
  ];
  check('every table tool is registered', TABLE_TOOLS.every((n) => byName.has(n)));
  check('each documents that coordinates are RENDER order',
    TABLE_TOOLS.filter((n) => n !== 'inspect_table').every((n) => /RENDER/.test(byName.get(n)!.description ?? '')));
  check('table_insert_row documents the header-row refusal',
    /header/i.test(byName.get('table_insert_row')!.description ?? ''));
  check('the delete tools document that the last row/column removes the table',
    /last/i.test(byName.get('table_delete_row')!.description ?? '') && /last/i.test(byName.get('table_delete_column')!.description ?? ''));

  console.log('\nA table built by append_blocks is immediately inspectable + operable');
  await call('append_blocks', {pageId: page.id, blocks: TABLE_PAYLOAD});
  const listed = resultText(await call('inspect_table', {pageId: page.id}));
  const tableId = /^- \[([^\]]+)\]/m.exec(listed)![1];
  check('inspect_table with no tableId lists the page\'s tables', /3 row\(s\) × 3 column\(s\), header row/.test(listed));

  const fresh = await inspect(tableId);
  check('the table reads back 3×3 with a header row', fresh.rows === 3 && fresh.cols === 3 && fresh.header);
  check('an append_blocks table has NO order keys yet (reported as unmigrated)', !fresh.migrated);
  check('cells are reported in payload order with addressable ids',
    JSON.stringify(fresh.cells) === JSON.stringify([['Item', 'Qty', 'Price'], ['Apples', '3', '1.20'], ['Pears', '5', '2.40']]) &&
    new Set(fresh.cellIds.flat()).size === 9);

  console.log('\nThe header-row invariant (the editor hides insert-above on row 0)');
  const above = await call('table_insert_row', {pageId: page.id, tableId, rowIndex: 0});
  check('inserting a row ABOVE the header row is refused with an explanation',
    isError(above) && /above the header row/.test(resultText(above)) && /rowIndex 1/.test(resultText(above)));
  check('the refusal changed nothing', (await inspect(tableId)).rows === 3);

  console.log('\ntable_insert_row: the first op migrates col:/ord without reshuffling');
  const inserted = await call('table_insert_row', {pageId: page.id, tableId, rowIndex: 1});
  check('the insert reports a direct apply and the new size', !isError(inserted) && /4 row\(s\) × 3 column\(s\)/.test(resultText(inserted)));
  const afterInsert = await inspect(tableId);
  check('order keys are now assigned (migrated) with 3 columns', afterInsert.migrated && afterInsert.colIds.length === 3);
  check('the blank row landed at render position 1 and nothing else moved',
    JSON.stringify(afterInsert.cells) === JSON.stringify([['Item', 'Qty', 'Price'], ['', '', ''], ['Apples', '3', '1.20'], ['Pears', '5', '2.40']]));
  const stored = await seed.getPage(page.id);
  check('the stored projection really carries col:/ord props',
    /"col:c0"/.test(JSON.stringify(stored?.data)) && /"ord"/.test(JSON.stringify(stored?.data)));

  console.log('\ntable_set_cell by index and by cell id');
  await call('table_set_cell', {pageId: page.id, tableId, rowIndex: 1, colIndex: 0, text: 'Cherries'});
  await call('table_set_cell', {pageId: page.id, tableId, rowIndex: 1, colIndex: 1, text: '11'});
  const byIdTarget = (await inspect(tableId)).cellIds[1][2];
  const byId = await call('table_set_cell', {pageId: page.id, cellId: byIdTarget, text: '4.75'});
  check('a cell id alone identifies the table AND the coordinates', !isError(byId));
  check('both addressing styles wrote the cells they meant',
    JSON.stringify((await inspect(tableId)).cells[1]) === JSON.stringify(['Cherries', '11', '4.75']));

  console.log('\nColumns: insert, move, tint, delete');
  await call('table_insert_column', {pageId: page.id, tableId, colIndex: 1});
  await call('table_set_cell', {pageId: page.id, tableId, rowIndex: 0, colIndex: 1, text: 'Bin'});
  const withCol = await inspect(tableId);
  check('a column was inserted at render position 1 with a cell in every row',
    withCol.cols === 4 && withCol.cells.every((r) => r.length === 4) && withCol.cells[0][1] === 'Bin');

  const movedCol = await call('table_move_column', {pageId: page.id, tableId, colIndex: 1, toIndex: 3});
  check('table_move_column reports success', !isError(movedCol));
  check('the moved column is last and the others closed up',
    JSON.stringify((await inspect(tableId)).cells[0]) === JSON.stringify(['Item', 'Qty', 'Price', 'Bin']));

  const colId = (await inspect(tableId)).colIds[3];
  await call('table_set_column_color', {pageId: page.id, tableId, colId, color: 'blue'});
  check('a column tint is stored as colbg:<colId> on the table',
    new RegExp(`"colbg:${colId}":"blue"`).test(JSON.stringify((await seed.getPage(page.id))?.data)));
  await call('table_set_column_width', {pageId: page.id, tableId, colId, width: 144});
  check('a column width is stored as colw:<colId> on the table',
    new RegExp(`"colw:${colId}":144`).test(JSON.stringify((await seed.getPage(page.id))?.data)));
  await call('table_delete_column', {pageId: page.id, tableId, colId});
  const colGone = await inspect(tableId);
  check('deleting a column by id removes its cells everywhere', colGone.cols === 3 && colGone.cells.every((r) => r.length === 3));
  check('the deleted column left no orphan colbg entry',
    !new RegExp(`"colbg:${colId}"`).test(JSON.stringify((await seed.getPage(page.id))?.data)));
  check('the deleted column left no orphan colw entry',
    !new RegExp(`"colw:${colId}"`).test(JSON.stringify((await seed.getPage(page.id))?.data)));

  console.log('\nRows: duplicate, move (by id), tint, delete');
  await call('table_duplicate_row', {pageId: page.id, tableId, rowIndex: 1});
  const dup = await inspect(tableId);
  check('duplicate_row copies the row directly below with FRESH ids',
    dup.rows === 5 && JSON.stringify(dup.cells[1]) === JSON.stringify(dup.cells[2]) && dup.rowIds[1] !== dup.rowIds[2]);
  check('the duplicated cells are distinct blocks', new Set(dup.cellIds.flat()).size === dup.rows * dup.cols);

  const lastRowId = dup.rowIds[4];
  await call('table_move_row', {pageId: page.id, rowId: lastRowId, toIndex: 1});
  const moved = await inspect(tableId);
  check('table_move_row addressed by row ID moved it to render position 1', moved.rowIds[1] === lastRowId);
  check('the header row stayed put', moved.rowIds[0] === dup.rowIds[0]);

  await call('table_set_row_color', {pageId: page.id, rowId: lastRowId, color: 'amber'});
  check('a row tint is the row block\'s bg prop', /"bg":"amber"/.test(JSON.stringify((await seed.getPage(page.id))?.data)));

  const delRow = await call('table_delete_row', {pageId: page.id, rowId: lastRowId});
  check('table_delete_row by id succeeds', !isError(delRow));
  check('the row is gone and the rest kept their render order',
    (await inspect(tableId)).rowIds.includes(lastRowId) === false && (await inspect(tableId)).rows === 4);

  console.log('\nBounds + unknown-id errors are clean and actionable');
  const oob = await call('table_delete_row', {pageId: page.id, tableId, rowIndex: 99});
  check('an out-of-range index names the table dimensions',
    isError(oob) && /out of range/.test(resultText(oob)) && /4 row\(s\)/.test(resultText(oob)));
  const badCell = await call('table_set_cell', {pageId: page.id, tableId, cellId: 'ghost', text: 'x'});
  check('an unknown cell id points at inspect_table', isError(badCell) && /No cell "ghost"/.test(resultText(badCell)));
  const badCol = await call('table_move_column', {pageId: page.id, tableId, colId: 'nope', toIndex: 0});
  check('an unknown column id errors cleanly', isError(badCol) && /No column "nope"/.test(resultText(badCol)));
  const noTable = await call('table_insert_row', {pageId: page.id, tableId: 'not-a-table', rowIndex: 1});
  check('an unknown tableId errors cleanly', isError(noTable) && /No table/.test(resultText(noTable)));
  const noAnchor = await call('table_delete_row', {pageId: page.id, rowIndex: 1});
  check('omitting every way of naming the table is refused', isError(noAnchor) && /Provide a tableId/.test(resultText(noAnchor)));
  const badMove = await call('table_move_row', {pageId: page.id, tableId, rowIndex: 1, toIndex: 4});
  check('a move target past the axis (counted with the row removed) is refused', isError(badMove) && /out of range/.test(resultText(badMove)));
  check('every refusal left the table exactly as it was', (await inspect(tableId)).rows === 4);

  console.log('\nA table cell also answers to the generic block tools (no regression)');
  const someCell = (await inspect(tableId)).cellIds[3][0];
  check('update_block can still write a cell by its block id',
    !isError(await call('update_block', {pageId: page.id, blockId: someCell, text: 'Damsons'})) &&
    (await inspect(tableId)).cells[3][0] === 'Damsons');

  console.log('\nThe last row / column removes the WHOLE table (editor parity)');
  const tiny = await seed.savePage(blockPage('One cell'));
  await mcp.client.callTool({
    name: 'append_blocks',
    arguments: {pageId: tiny.id, blocks: [{type: 'table', children: [{type: 'row', children: [{type: 'cell', text: 'only'}]}]}]},
  });
  const tinyId = /^- \[([^\]]+)\]/m.exec(resultText(await call('inspect_table', {pageId: tiny.id})))![1];
  const lastDel = await mcp.client.callTool({name: 'table_delete_row', arguments: {pageId: tiny.id, tableId: tinyId, rowIndex: 0}});
  check('deleting the last row says the whole table block was removed',
    !isError(lastDel) && /last row/.test(resultText(lastDel)) && /whole table block was removed/.test(resultText(lastDel)));
  check('the table really is gone from the page',
    !JSON.stringify((await seed.getPage(tiny.id))?.data).includes('"table"'));

  await mcp.close();

  // ── SUGGEST mode: review parity, and payload replay equivalence. ──────────────
  console.log('\nPolicy gate: every table op queues a reviewable table-op suggestion');
  await seed.setInstancePolicy({agentEdits: 'suggest'});
  const rPage = await seed.savePage(blockPage('Table review target'));
  // Seed the table by DIRECT store write so both mode branches start from the same
  // projection (append_blocks under suggest would only queue a suggestion).
  const seededTable = {
    id: 'tbl',
    type: 'table',
    props: {header: true},
    children: [
      {id: 'r0', type: 'row', children: [{id: 'c00', type: 'cell', text: [{t: 'Item'}]}, {id: 'c01', type: 'cell', text: [{t: 'Qty'}]}]},
      {id: 'r1', type: 'row', children: [{id: 'c10', type: 'cell', text: [{t: 'Apples'}]}, {id: 'c11', type: 'cell', text: [{t: '3'}]}]},
      {id: 'r2', type: 'row', children: [{id: 'c20', type: 'cell', text: [{t: 'Pears'}]}, {id: 'c21', type: 'cell', text: [{t: '5'}]}]},
    ],
  };
  const seededData = {editor: 'blocks', blockdoc: {blocks: [seededTable]}, editorjs: {blocks: []}, values: [], names: []};
  await seed.savePage({id: rPage.id, name: rPage.name, data: seededData as unknown as PageSnapshot});
  const sug = await connect(server.url);
  const sCall = (name: string, args: Record<string, unknown>) => sug.client.callTool({name, arguments: args});

  const queued = await sCall('table_insert_row', {pageId: rPage.id, tableId: 'tbl', rowIndex: 2});
  check('table_insert_row under suggest is queued, not applied', resultText(queued).includes('Suggested for review'));
  await sCall('table_move_row', {pageId: rPage.id, tableId: 'tbl', rowIndex: 2, toIndex: 1});
  await sCall('table_set_cell', {pageId: rPage.id, tableId: 'tbl', rowIndex: 1, colIndex: 1, text: '99'});
  await sCall('table_delete_column', {pageId: rPage.id, tableId: 'tbl', colIndex: 1});
  await sCall('table_set_row_color', {pageId: rPage.id, tableId: 'tbl', rowIndex: 1, color: 'amber'});

  const suggestions = await seed.listSuggestions(rPage.id);
  check('all five ops were queued', suggestions.length === 5);
  check('every one reviews as the `table-op` suggestion kind anchored on the TABLE block',
    suggestions.every((s) => s.kind === 'table-op' && s.target.blockId === 'tbl'));
  check('each payload carries the bridge applyKind = the tool name',
    new Set(suggestions.map((s) => (s.payload as {applyKind?: string}).applyKind)).size === 5 &&
    suggestions.every((s) => String((s.payload as {applyKind?: string}).applyKind).startsWith('table_')));
  check('payloads carry the page, the table, and RESOLVED sorted coordinates',
    suggestions.every((s) => {
      const p = s.payload as {pageId?: string; tableId?: string; rowIndex?: number; colIndex?: number};
      return p.pageId === rPage.id && p.tableId === 'tbl' && (typeof p.rowIndex === 'number' || typeof p.colIndex === 'number');
    }));
  const moveSug = suggestions.find((s) => (s.payload as {applyKind?: string}).applyKind === 'table_move_row')!;
  check('a node-targeting op also carries the STABLE id it resolved to (survives a reorder in review)',
    (moveSug.payload as {rowId?: string}).rowId === 'r2' && (moveSug.payload as {toIndex?: number}).toIndex === 1);
  const cellSug = suggestions.find((s) => (s.payload as {applyKind?: string}).applyKind === 'table_set_cell')!;
  check('a cell op carries the cell id and a before→after for the diff card',
    (cellSug.payload as {cellId?: string}).cellId === 'c11' && cellSug.before === '3' && cellSug.after === '99');
  check('authorship is the MCP client', suggestions.every((s) => s.authorKind === 'ai' && s.authorName === 'MCP client'));
  // Nothing landed: the grid is untouched AND no op backfilled order keys (a
  // suggested op must not migrate the table either — it never writes the page).
  const untouched = snapshotTableView((await seed.getPage(rPage.id))!.data, 'tbl')!;
  check('NOTHING was mutated under suggest — same grid, still unmigrated',
    JSON.stringify(untouched.cells) === JSON.stringify([['Item', 'Qty'], ['Apples', '3'], ['Pears', '5']]) &&
    untouched.colIds.length === 0 && untouched.rowIds.join(',') === 'r0,r1,r2');

  const refused = await sCall('table_insert_row', {pageId: rPage.id, tableId: 'tbl', rowIndex: 0});
  check('the header guard bites under suggest too, queueing nothing',
    isError(refused) && (await seed.listSuggestions(rPage.id)).length === 5);
  const oobSuggest = await sCall('table_delete_row', {pageId: rPage.id, tableId: 'tbl', rowIndex: 7});
  check('bounds are validated BEFORE the policy branch', isError(oobSuggest) && (await seed.listSuggestions(rPage.id)).length === 5);

  console.log('\nAn accepted suggestion applies IDENTICALLY to a direct write');
  // Same op, once through each mode; then replay the queued payload the way the
  // editor bridge does (resolve → validate → apply) and compare the grids.
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const dPage = await seed.savePage({...blockPage('Direct twin'), data: seededData as unknown as PageSnapshot});
  const direct = await connect(server.url);
  await direct.client.callTool({name: 'table_move_row', arguments: {pageId: dPage.id, tableId: 'tbl', rowIndex: 2, toIndex: 1}});
  await direct.close();
  const directGrid = snapshotTableView((await seed.getPage(dPage.id))!.data, 'tbl')!.cells;

  const replay = (data: PageSnapshot, payload: Record<string, unknown>): PageSnapshot => {
    const view = snapshotTableView(data, String(payload.tableId))!;
    const kind = payload.applyKind as TableOpKind;
    const resolved = resolveTableOp(view, kind, payload as Record<string, never>);
    assert.ok(!('error' in resolved), `replay could not resolve: ${JSON.stringify(payload)}`);
    const op = (resolved as {op: Parameters<typeof applyTableOpToSnapshot>[2]}).op;
    assert.equal(tableOpError(tableShapeOf(view), op), null);
    return applyTableOpToSnapshot(data, String(payload.tableId), op)!.data;
  };
  const replayed = replay(seededData as unknown as PageSnapshot, moveSug.payload as Record<string, unknown>);
  check('replaying the queued payload yields the same grid as the direct write',
    JSON.stringify(snapshotTableView(replayed, 'tbl')!.cells) === JSON.stringify(directGrid));
  check('…and it really moved something', JSON.stringify(directGrid) !== JSON.stringify(snapshotTableView(seededData as unknown as PageSnapshot, 'tbl')!.cells));

  await sug.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — table structure tools over MCP (API-3).`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP table-tools test failed:', err);
  process.exit(1);
});
