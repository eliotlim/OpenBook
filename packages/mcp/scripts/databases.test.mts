import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HttpDataClient} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-databases-test';
let passed = 0;
const check = (label: string, condition: boolean): void => {
  assert.ok(condition, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const resultText = (result: {content?: unknown}): string =>
  ((result.content as Array<{type: string; text?: string}> | undefined) ?? []).map((item) => item.text ?? '').join('\n');
const json = <T>(result: {content?: unknown}): T => JSON.parse(resultText(result)) as T;

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4416});
  const seed = new HttpDataClient(server.url);
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...process.env, OPENBOOK_URL: server.url}, stderr: 'pipe'});
  const client = new Client({name: 'api-9-databases-test', version: '0.0.0'});
  await client.connect(transport);

  const created = json<{pageId: string; databaseId: string}>(await client.callTool({name: 'create_database', arguments: {title: 'API-9 tasks'}}));
  check('create_database returns page and database ids', Boolean(created.pageId) && Boolean(created.databaseId));
  const renamed = json<{name: string}>(await client.callTool({name: 'update_database', arguments: {pageId: created.pageId, name: 'API-9 work'}}));
  check('update_database returns the new name', renamed.name === 'API-9 work');

  const text = json<{property: {id: string; type: string}}>(await client.callTool({name: 'create_property', arguments: {pageId: created.pageId, name: 'Notes', type: 'text'}}));
  const number = json<{property: {id: string; type: string}}>(await client.callTool({name: 'create_property', arguments: {pageId: created.pageId, name: 'Points', type: 'number'}}));
  const select = json<{property: {id: string; type: string}}>(await client.callTool({name: 'create_property', arguments: {pageId: created.pageId, name: 'State', type: 'select', options: ['Todo', 'Done']}}));
  check('create_property returns text/number/select schemas', [text.property.type, number.property.type, select.property.type].join(',') === 'text,number,select');

  const changed = json<{property: {name: string; options: Array<{label: string}>}}>(await client.callTool({name: 'update_property', arguments: {
    pageId: created.pageId, propertyId: select.property.id, name: 'Status', options: ['Backlog', 'Doing', 'Done'],
  }}));
  check('update_property returns rename and replacement options', changed.property.name === 'Status' && changed.property.options.length === 3);

  const row = await seed.createRow(created.databaseId, {name: 'First task'});
  const updated = json<{row: {id: string; name: string; properties: Record<string, unknown>}}>(await client.callTool({name: 'update_row', arguments: {
    pageId: created.pageId, rowId: row.id, name: 'Shipped task', properties: {Notes: 'ready', Points: 8, Status: 'Done'},
  }}));
  check('update_row returns merged typed values', updated.row.name === 'Shipped task' && updated.row.properties[number.property.id] === 8);

  const described = json<{properties: unknown[]; rows: Array<{id: string}>; rowCount: number}>(await client.callTool({name: 'describe_database', arguments: {pageId: created.pageId}}));
  check('describe_database returns schema and counts', described.properties.length === 3 && described.rowCount === 1 && described.rows[0]?.id === row.id);

  const badDatabase = await client.callTool({name: 'describe_database', arguments: {pageId: '00000000-0000-0000-0000-000000000000'}});
  check('unknown database id is a typed error', badDatabase.isError === true && resultText(badDatabase).includes('[database_not_found]'));
  const badProperty = await client.callTool({name: 'update_property', arguments: {pageId: created.pageId, propertyId: 'missing', name: 'Nope'}});
  check('unknown property id is a typed error', badProperty.isError === true && resultText(badProperty).includes('[property_not_found]'));
  const badValue = await client.callTool({name: 'update_row', arguments: {pageId: created.pageId, rowId: row.id, properties: {Points: 'not-a-number'}}});
  check('wrong property value is typed and leaks no paths', badValue.isError === true && resultText(badValue).includes('[invalid_input]') && !resultText(badValue).includes(DATA_DIR));

  const deleted = json<{deleted: {id: string}; trashed: boolean}>(await client.callTool({name: 'delete_row', arguments: {pageId: created.pageId, rowId: row.id}}));
  check('delete_row soft-deletes to trash', deleted.trashed && deleted.deleted.id === row.id && (await seed.listRows(created.databaseId)).length === 0
    && (await seed.listTrash()).some((page) => page.id === row.id));

  const agentSource = readFileSync(new URL('../../server/src/ai/agent.ts', import.meta.url), 'utf8');
  const mcpSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  for (const symbol of ['describeDatabaseTool', 'createDatabaseTool', 'updateDatabaseTool', 'createPropertyTool', 'updatePropertyTool', 'updateRowTool', 'deleteRowTool']) {
    check(`${symbol} is shared by agent and MCP`, agentSource.includes(`${symbol}(`) && mcpSource.includes(`${symbol}(`));
  }

  await client.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — API-9 database round-trip and negatives.`);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
