/** API-10 page tools: round-trip, validation, tree safety, and read-only refusal. */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {COVER_GRADIENTS, COVER_PROPERTY_ID, HttpDataClient} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-pages-test';
let passed = 0;
const check = (label: string, condition: boolean): void => {
  assert.ok(condition, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const resultText = (result: {content?: unknown}): string =>
  ((result.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter(({type}) => type === 'text').map(({text}) => text ?? '').join('\n');

async function connect(url: string): Promise<{client: Client; close: () => Promise<void>}> {
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...(process.env as Record<string, string>), OPENBOOK_URL: url}, stderr: 'pipe'});
  const client = new Client({name: 'openbook-mcp-pages-test', version: '0.0.0'});
  await client.connect(transport);
  return {client, close: () => client.close()};
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4410});
  const seed = new HttpDataClient(server.url);
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const parent = await seed.savePage({name: 'Parent', data: {editorjs: {blocks: []}, values: [], names: []}});
  const child = await seed.savePage({name: 'Child', data: {editorjs: {blocks: []}, values: [], names: []}});
  const connection = await connect(server.url);
  const appearance = await connection.client.callTool({name: 'set_page_appearance', arguments: {
    pageId: child.id, icon: '📘', theme: {themeId: 'ocean', background: 'blue'}, fullWidth: true,
    cover: {kind: 'gradient', gradientId: 'ocean'},
  }});
  check('set_page_appearance applies in direct mode', appearance.isError !== true);
  check('valid gradient id resolves to curated css', (await seed.getPage(child.id))?.properties[COVER_PROPERTY_ID] != null &&
    JSON.stringify((await seed.getPage(child.id))?.properties[COVER_PROPERTY_ID]).includes(COVER_GRADIENTS.find(({id}) => id === 'ocean')!.css));
  const read = await connection.client.callTool({name: 'read_page', arguments: {pageId: child.id}});
  check('read_page reflects persisted appearance', resultText(read).includes('sys_icon') && resultText(read).includes('ocean'));

  const moved = await connection.client.callTool({name: 'move_page', arguments: {pageId: child.id, parentId: parent.id, position: {index: 0}}});
  check('move_page reparents a page', moved.isError !== true && (await seed.getPage(child.id))?.parentId === parent.id);
  const listed = await connection.client.callTool({name: 'list_pages', arguments: {}});
  check('list_pages exposes the new parent and order', resultText(listed).includes(`parent=${parent.id}, order=0`));

  const set = await connection.client.callTool({name: 'set_page_properties', arguments: {pageId: child.id, properties: {sys_owner: 'Eliot'}}});
  const get = await connection.client.callTool({name: 'get_page_properties', arguments: {pageId: child.id}});
  check('get/set page properties round-trip', set.isError !== true && resultText(get).includes('sys_owner') && resultText(get).includes('Eliot'));

  const missing = await connection.client.callTool({name: 'get_page_properties', arguments: {pageId: '00000000-0000-0000-0000-000000000000'}});
  check('unknown page returns a typed safe error', missing.isError === true && resultText(missing).includes('[page_not_found]') && !resultText(missing).includes(DATA_DIR));
  const cycle = await connection.client.callTool({name: 'move_page', arguments: {pageId: parent.id, parentId: child.id}});
  check('moving into an own subtree is refused', cycle.isError === true && resultText(cycle).includes('[invalid_move]'));
  const invalidTheme = await connection.client.callTool({name: 'set_page_appearance', arguments: {pageId: child.id, theme: {themeId: 'ultraviolet'}}});
  check('invalid appearance enum is refused without path leakage', invalidTheme.isError === true && !resultText(invalidTheme).includes(DATA_DIR));
  const arbitraryGradient = await connection.client.callTool({name: 'set_page_appearance', arguments: {pageId: child.id, cover: {kind: 'gradient', css: 'linear-gradient(red, url(https://beacon.invalid))'}}});
  check('arbitrary gradient css is refused', arbitraryGradient.isError === true);
  for (const url of ['http://example.com/cover.jpg', 'javascript:alert(1)']) {
    const invalidCover = await connection.client.callTool({name: 'set_page_appearance', arguments: {pageId: child.id, cover: {kind: 'image', url}}});
    check(`${url.split(':')[0]} image cover is refused`, invalidCover.isError === true);
  }
  for (const url of ['https://example.com/cover.jpg', '/api/assets/cover-id']) {
    const validCover = await connection.client.callTool({name: 'set_page_appearance', arguments: {pageId: child.id, cover: {kind: 'image', url}}});
    check(`${url.startsWith('https') ? 'https' : 'OpenBook asset'} image cover is accepted`, validCover.isError !== true);
  }
  const invalidProperty = await connection.client.callTool({name: 'set_page_properties', arguments: {pageId: child.id, properties: {sys_backlinks: ['x']}}});
  check('computed/unknown property writes are typed refusals', invalidProperty.isError === true && resultText(invalidProperty).includes('[invalid_input]'));

  await seed.setInstancePolicy({guestAccess: 'read'});
  const readOnly = await connection.client.callTool({name: 'set_page_properties', arguments: {pageId: child.id, properties: {sys_owner: 'Nope'}}});
  check('read-only instance refuses writes with a typed error', readOnly.isError === true && resultText(readOnly).includes('[permission_denied]'));
  check('read-only refusal leaves properties unchanged', (await seed.getPage(child.id))?.properties.sys_owner === 'Eliot');

  await connection.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} API-10 PAGE TOOL CHECKS PASSED`);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
