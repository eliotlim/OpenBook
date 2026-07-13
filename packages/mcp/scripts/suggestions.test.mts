/**
 * Focused test for AGENT-2: MCP write tools route through the suggestion-review
 * layer by default, and the `allowDirectEdits` opt-out restores direct mutation.
 *
 * Boots a real OpenBook server, then connects to `src/bin.ts` over stdio TWICE:
 *  - default env  → writes must persist a StoredSuggestion and NOT mutate.
 *  - OPENBOOK_MCP_ALLOW_DIRECT_EDITS=1 → the same write must mutate directly.
 *
 * Run: pnpm --filter @book.dev/mcp test
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HttpDataClient, defaultDatabaseSchema} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-suggestions-test';

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

function connect(url: string, allowDirect: boolean): Promise<Client> {
  const env: Record<string, string> = {...(process.env as Record<string, string>), OPENBOOK_URL: url};
  if (allowDirect) env.OPENBOOK_MCP_ALLOW_DIRECT_EDITS = '1';
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', 'src/bin.ts'], env, stderr: 'pipe'});
  const client = new Client({name: 'openbook-mcp-suggestions-test', version: '0.0.0'});
  return client.connect(transport).then(() => client);
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4406});
  console.log(`\nOpenBook server up at ${server.url}`);

  const seed = new HttpDataClient(server.url);

  // A block-editor page with one text block the write tools can target.
  const page = await seed.savePage({
    name: 'Review target',
    data: {editor: 'blocks', blockdoc: {blocks: [{id: 'b1', type: 'paragraph', text: [{t: 'original text'}]}]}, editorjs: {blocks: []}, values: [], names: []},
  });
  // A database + row for the set_db_cell path.
  const dbHost = await seed.savePage({name: 'Tasks board', data: {editorjs: {blocks: []}, values: [], names: []}});
  const database = await seed.createDatabase({pageId: dbHost.id, name: 'Tasks', schema: defaultDatabaseSchema()});
  const row = await seed.createRow(database.id, {name: 'A task'});
  const textProp = (database.schema.properties ?? []).find((p) => p.type === 'text')!;

  // ── DEFAULT: writes create reviewable suggestions, never mutating. ────────────
  console.log('\nDefault mode — writes create suggestions (no mutation)');
  const dflt = await connect(server.url, false);

  const upd = await dflt.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'edited by mcp'}});
  check('update_block returns a "Suggested for review" result', resultText(upd).includes('Suggested for review'));

  const suggestions = await seed.listSuggestions(page.id);
  const blockSugg = suggestions.find((s) => (s.payload as {applyKind?: string}).applyKind === 'update_block');
  check('update_block recorded exactly one suggestion', suggestions.length === 1 && Boolean(blockSugg));
  check('suggestion kind maps update_block → replace-text', blockSugg?.kind === 'replace-text');
  check('suggestion is authored by the MCP client (authorKind ai)', blockSugg?.authorKind === 'ai' && blockSugg?.authorName === 'MCP client');
  check('suggestion targets the block', blockSugg?.target.blockId === 'b1');
  check('suggestion payload mirrors the agent (applyKind + before merge base)',
    (blockSugg?.payload as {applyKind?: string; blockId?: string; text?: string; before?: string}).applyKind === 'update_block' &&
    (blockSugg?.payload as {before?: string}).before === 'original text' &&
    (blockSugg?.payload as {text?: string}).text === 'edited by mcp');

  const readBack = await dflt.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('the page text was NOT mutated (still original)', resultText(readBack).includes('original text') && !resultText(readBack).includes('edited by mcp'));

  const cell = await dflt.callTool({name: 'set_db_cell', arguments: {pageId: dbHost.id, rowId: row.id, propertyId: textProp.id, value: 'cell via mcp'}});
  check('set_db_cell returns a "Suggested for review" result', resultText(cell).includes('Suggested for review'));
  const cellSuggs = await seed.listSuggestions(dbHost.id);
  const cellSugg = cellSuggs.find((s) => s.kind === 'set-cell');
  check('set_db_cell recorded a set-cell suggestion on the host page', Boolean(cellSugg));
  check('set-cell suggestion targets the db/row/property', cellSugg?.target.databaseId === database.id && cellSugg?.target.rowId === row.id && cellSugg?.target.propertyId === textProp.id);
  const rowAfter = await seed.listRows(database.id);
  check('the database cell was NOT mutated', (rowAfter.find((r) => r.id === row.id)?.properties?.[textProp.id] ?? null) === null);

  // Creation stays immediate even in default mode (non-destructive, no target page).
  const created = await dflt.callTool({name: 'create_page', arguments: {title: 'New note', content: 'hi'}});
  const createdId = /id ([0-9a-f-]{36})/.exec(resultText(created))?.[1];
  check('create_page applies immediately (page exists)', Boolean(createdId) && Boolean(await seed.getPage(createdId!)));
  check('create_page recorded no suggestion', (await seed.listSuggestions(createdId!)).length === 0);

  await dflt.close();

  // ── DIRECT: the opt-out restores immediate mutation. ──────────────────────────
  console.log('\nTrusted mode (OPENBOOK_MCP_ALLOW_DIRECT_EDITS=1) — writes mutate directly');
  const suggestionsBefore = (await seed.listSuggestions(page.id)).length;
  const direct = await connect(server.url, true);

  const updD = await direct.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'edited directly'}});
  check('update_block confirms a direct write', resultText(updD).includes('Updated block'));
  const readD = await direct.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('the page text WAS mutated under the flag', resultText(readD).includes('edited directly'));
  check('direct write recorded NO new suggestion', (await seed.listSuggestions(page.id)).length === suggestionsBefore);

  await direct.close();

  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — MCP writes are reviewable by default and direct under the flag.`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP suggestions test failed:', err);
  process.exit(1);
});
