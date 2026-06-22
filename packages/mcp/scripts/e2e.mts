/**
 * Integration test for the OpenBook MCP server.
 *
 * Boots a real OpenBook server (embedded PGlite, throwaway data dir), seeds a
 * couple of pages and a database, then connects to `src/bin.ts` over stdio as
 * a real MCP client: handshake, tools/list, and one call per tool — including
 * the failure modes (missing page, blocks-editor guard).
 *
 * Run: pnpm --filter @book.dev/mcp test:e2e
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HttpDataClient, defaultDatabaseSchema} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-e2e';

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

/** The text of a tool result (MCP content blocks). */
const resultText = (res: {content?: unknown}): string =>
  ((res.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4402});
  console.log(`\nOpenBook server up at ${server.url}`);

  // Seed: two text pages and a page hosting a database.
  const seed = new HttpDataClient(server.url);
  const note = await seed.savePage({
    name: 'Quarterly planning',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'The budget forecast needs a revision before Friday.'}}]}, values: [], names: []},
  });
  await seed.savePage({
    name: 'Weekend ideas',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Hiking, picnic, museum.'}}]}, values: [], names: []},
  });
  const blocksPage = await seed.savePage({
    name: 'Collab doc',
    data: {editor: 'blocks', blockdoc: {blocks: []}, editorjs: {blocks: []}, values: [], names: []},
  });
  const dbHost = await seed.savePage({name: 'Tasks board', data: {editorjs: {blocks: []}, values: [], names: []}});
  const database = await seed.createDatabase({pageId: dbHost.id, name: 'Tasks', schema: defaultDatabaseSchema()});
  const seededRow = await seed.createRow(database.id, {name: 'Write the report'});

  // Connect to the stdio binary as a real MCP client.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...process.env, OPENBOOK_URL: server.url},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-e2e', version: '0.0.0'});
  await client.connect(transport);

  console.log('\nMCP handshake + tool catalogue');
  const serverInfo = client.getServerVersion();
  check('handshake reports the openbook server', serverInfo?.name === 'openbook');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    'all sixteen tools are listed',
    JSON.stringify(names) ===
      JSON.stringify([
        'append_blocks', 'append_to_page', 'create_artifact_page', 'create_database_row', 'create_page',
        'get_db_row', 'get_kit_values', 'inspect_page_structure', 'list_database_rows', 'list_db_views',
        'list_pages', 'read_page', 'search_notes', 'set_db_cell', 'set_kit_value', 'update_block',
      ]),
  );
  check('tools carry descriptions', tools.tools.every((t) => (t.description ?? '').length > 10));

  console.log('\nRead tools');
  const list = await client.callTool({name: 'list_pages', arguments: {}});
  check('list_pages includes seeded pages', resultText(list).includes('Quarterly planning') && resultText(list).includes(note.id));

  const read = await client.callTool({name: 'read_page', arguments: {pageId: note.id}});
  check('read_page returns title and body', resultText(read).includes('Quarterly planning') && resultText(read).includes('budget forecast'));

  const missing = await client.callTool({name: 'read_page', arguments: {pageId: '00000000-0000-0000-0000-000000000000'}});
  check('read_page flags a missing page as an error', missing.isError === true);

  const search = await client.callTool({name: 'search_notes', arguments: {query: 'budget forecast revision'}});
  check('search_notes ranks the planning note first', resultText(search).split('\n')[0].includes('Quarterly planning'));

  console.log('\nWrite tools');
  const created = await client.callTool({name: 'create_page', arguments: {title: 'MCP scratchpad', content: 'First line.\nSecond line.'}});
  const createdId = /id ([0-9a-f-]{36})/.exec(resultText(created))?.[1];
  check('create_page returns the new id', Boolean(createdId));

  const append = await client.callTool({name: 'append_to_page', arguments: {pageId: createdId!, content: 'Appended line.'}});
  check('append_to_page confirms', resultText(append).includes('Appended to'));
  const reread = await client.callTool({name: 'read_page', arguments: {pageId: createdId!}});
  check('appended text is readable back', resultText(reread).includes('Appended line.'));

  const guarded = await client.callTool({name: 'append_to_page', arguments: {pageId: blocksPage.id, content: 'nope'}});
  check('append refuses collaborative-editor pages', guarded.isError === true && resultText(guarded).includes('collaborative editor'));

  const dupe = await client.callTool({name: 'create_page', arguments: {title: 'Quarterly planning'}});
  check('create_page surfaces the duplicate-name conflict', dupe.isError === true);

  console.log('\nArtifact tool');
  const artifact = await client.callTool({
    name: 'create_artifact_page',
    arguments: {
      title: 'MCP artifact',
      blocks: [
        {type: 'heading', text: 'Counter demo', props: {level: 2}},
        {type: 'number', props: {name: 'n', value: 3, min: 0, max: 10, step: 1}},
        {type: 'statuslight', props: {label: 'Level', source: 'n', okAt: 5, warnAt: 2}},
        {type: 'kitchart', props: {kind: 'bar', title: 'Powers', source: '[n, n*n]'}},
        {type: 'actionbutton', props: {btnlabel: 'Step', action: 'increment', target: 'n'}},
      ],
    },
  });
  const artifactId = /id ([0-9a-f-]{36})/.exec(resultText(artifact))?.[1];
  check('create_artifact_page returns the new id', Boolean(artifactId) && artifact.isError !== true);
  const artifactPage = await seed.getPage(artifactId!);
  check('the artifact is stamped for the block editor', artifactPage?.data?.editor === 'blocks');
  const artifactBlocks = (artifactPage?.data as {blockdoc?: {blocks?: Array<{type: string}>}})?.blockdoc?.blocks ?? [];
  check('all five blocks landed in order', artifactBlocks.map((b) => b.type).join(',') === 'heading,number,statuslight,kitchart,actionbutton');
  const readArtifact = await client.callTool({name: 'read_page', arguments: {pageId: artifactId!}});
  check('read_page sees the artifact heading', resultText(readArtifact).includes('Counter demo'));
  const badType = await client.callTool({
    name: 'create_artifact_page',
    arguments: {title: 'Bad artifact', blocks: [{type: 'iframe', props: {}}]},
  });
  check('unknown block types are rejected', badType.isError === true && resultText(badType).includes('iframe'));

  console.log('\nDatabase tools');
  const rows = await client.callTool({name: 'list_database_rows', arguments: {pageId: dbHost.id}});
  check('list_database_rows lists the seeded row', resultText(rows).includes('Write the report'));

  const newRow = await client.callTool({name: 'create_database_row', arguments: {pageId: dbHost.id, name: 'Review the PR'}});
  check('create_database_row confirms', resultText(newRow).includes('Review the PR'));
  const rowsAfter = await client.callTool({name: 'list_database_rows', arguments: {pageId: dbHost.id}});
  check('the new row shows up', resultText(rowsAfter).includes('Review the PR'));

  const noDb = await client.callTool({name: 'list_database_rows', arguments: {pageId: note.id}});
  check('list_database_rows flags a page without a database', noDb.isError === true);

  console.log('\nInspection tools (T11)');
  const tree = await client.callTool({name: 'inspect_page_structure', arguments: {pageId: artifactId!}});
  check('inspect_page_structure shows the block tree', resultText(tree).includes('heading') && resultText(tree).includes('number'));
  const headingId = /- \[([^\]]+)\] heading/.exec(resultText(tree))?.[1];
  check('inspect_page_structure exposes block ids', Boolean(headingId));

  const kitVals = await client.callTool({name: 'get_kit_values', arguments: {pageId: artifactId!}});
  check('get_kit_values reads the published input', resultText(kitVals).includes('n = 3'));
  const noKit = await client.callTool({name: 'get_kit_values', arguments: {pageId: note.id}});
  check('get_kit_values reports a page with no kit values', resultText(noKit).includes('no named kit values'));

  const views = await client.callTool({name: 'list_db_views', arguments: {pageId: dbHost.id}});
  check('list_db_views lists the database views', resultText(views).includes('board') && resultText(views).includes('table'));

  const getRow = await client.callTool({name: 'get_db_row', arguments: {pageId: dbHost.id, rowId: seededRow.id}});
  check('get_db_row reads the row by id', resultText(getRow).includes('Write the report'));

  console.log('\nWrite tools (T11)');
  const setKit = await client.callTool({name: 'set_kit_value', arguments: {pageId: artifactId!, name: 'n', value: 7}});
  check('set_kit_value confirms', resultText(setKit).includes('"n"') && resultText(setKit).includes('7'));
  const kitAfter = await client.callTool({name: 'get_kit_values', arguments: {pageId: artifactId!}});
  check('set_kit_value persisted the new value', resultText(kitAfter).includes('n = 7'));
  const setKitMissing = await client.callTool({name: 'set_kit_value', arguments: {pageId: artifactId!, name: 'nope', value: 1}});
  check('set_kit_value rejects an unknown input', setKitMissing.isError === true);

  const updateBlock = await client.callTool({name: 'update_block', arguments: {pageId: artifactId!, blockId: headingId!, text: 'Renamed demo'}});
  check('update_block confirms', resultText(updateBlock).includes('Updated block'));
  const treeAfter = await client.callTool({name: 'inspect_page_structure', arguments: {pageId: artifactId!}});
  check('update_block changed the heading text', resultText(treeAfter).includes('Renamed demo'));
  const updateMissing = await client.callTool({name: 'update_block', arguments: {pageId: artifactId!, blockId: 'no-such-block', text: 'x'}});
  check('update_block rejects an unknown block id', updateMissing.isError === true);

  const appended = await client.callTool({name: 'append_blocks', arguments: {pageId: artifactId!, blocks: [{type: 'paragraph', text: 'Appended via MCP.'}]}});
  check('append_blocks confirms', resultText(appended).includes('Appended 1 block'));
  const readAppended = await client.callTool({name: 'read_page', arguments: {pageId: artifactId!}});
  check('append_blocks added the paragraph', resultText(readAppended).includes('Appended via MCP.'));
  const appendGuard = await client.callTool({name: 'append_blocks', arguments: {pageId: note.id, blocks: [{type: 'paragraph', text: 'x'}]}});
  check('append_blocks refuses legacy editor pages', appendGuard.isError === true);

  const textProp = (database.schema.properties ?? []).find((p) => p.type === 'text');
  const setCell = await client.callTool({name: 'set_db_cell', arguments: {pageId: dbHost.id, rowId: seededRow.id, propertyId: textProp!.id, value: 'set via mcp'}});
  check('set_db_cell confirms', resultText(setCell).includes('set via mcp'));
  const rowAfter = await client.callTool({name: 'get_db_row', arguments: {pageId: dbHost.id, rowId: seededRow.id}});
  check('set_db_cell persisted the cell', resultText(rowAfter).includes('set via mcp'));
  const setCellMissing = await client.callTool({name: 'set_db_cell', arguments: {pageId: dbHost.id, rowId: seededRow.id, propertyId: 'nope', value: 'x'}});
  check('set_db_cell rejects an unknown property', setCellMissing.isError === true);

  await client.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — MCP handshake, catalogue, and every tool verified.`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP e2e failed:', err);
  process.exit(1);
});
