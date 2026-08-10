/**
 * API-2: MCP block-type validation is DERIVED from the SDK catalogue (the
 * hand-written ARTIFACT_TYPES allowlist is gone), and `list_block_types`
 * serves the whole catalogue including installed plugins' declared blocks.
 *
 *  - COVERAGE: every catalogued type — including the ones the old allowlist
 *    silently rejected on this path (image, htmlArtifact, notes, dbview,
 *    progressbar, dropdown, choicecards, searchselect, tagfield, longtext,
 *    richtext, slider…) — is creatable via `create_artifact_page`, enumerated
 *    from the catalogue so new types are covered the day they're catalogued.
 *  - Unknown types are refused pointing at list_block_types; plugin types
 *    (`<pluginId>/<type>`) are refused while the plugin is NOT installed and
 *    accepted once it is (the REAL bundled ledger plugin, installed from
 *    examples/plugins/ledger).
 *  - The table cell-count rule (square tables) is enforced on both
 *    append_blocks and create_artifact_page.
 *  - update_block_props validates declared prop VALUE types (permissive:
 *    unknown props pass).
 *
 * Boots a real OpenBook server and drives `src/bin.ts` over stdio (same
 * harness as blocks.test.mts). Run: pnpm --filter @book.dev/mcp test
 */
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BLOCK_TYPE_CATALOGUE,
  CHILD_ONLY_PARENT,
  HttpDataClient,
  LOCAL_OWNER_HEADER,
  type PluginManifest,
} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-blocktypes-test';
const LOCAL_OWNER_SECRET = 'mcp-blocktypes-local-owner';

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
  const client = new Client({name: 'openbook-mcp-blocktypes-test', version: '0.0.0'});
  await client.connect(transport);
  return {client, close: () => client.close()};
}

/** A minimal instance of `type`, wrapped in its required ancestors — derived
 *  purely from the catalogue's child-only map, so the enumeration needs no
 *  per-type knowledge. */
const minimalBlock = (type: string): Record<string, unknown> => {
  let block: Record<string, unknown> = {type};
  for (let t = type; CHILD_ONLY_PARENT[t]; t = CHILD_ONLY_PARENT[t]) {
    block = {type: CHILD_ONLY_PARENT[t], children: [block]};
  }
  return block;
};

/** Load the REAL bundled ledger plugin package from examples/plugins/ledger. */
function ledgerPackage(): {manifest: PluginManifest; files: Record<string, string>} {
  const dir = resolve(import.meta.dirname, '..', '..', '..', 'examples', 'plugins', 'ledger');
  const manifest = JSON.parse(readFileSync(join(dir, 'openbook.json'), 'utf-8')) as PluginManifest;
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|json)$/.test(entry) && entry !== 'openbook.json') {
        files[relative(dir, full)] = readFileSync(full, 'utf-8');
      }
    }
  };
  walk(dir);
  return {manifest, files};
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({
    dataDir: DATA_DIR,
    host: '127.0.0.1',
    port: 4414,
    localOwnerSecret: LOCAL_OWNER_SECRET,
  });
  console.log(`\nOpenBook server up at ${server.url}`);
  const seed = new HttpDataClient(server.url);
  const ownerSeed = new HttpDataClient(server.url, undefined, {
    fetchImpl: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(LOCAL_OWNER_HEADER, LOCAL_OWNER_SECRET);
      return fetch(input, {...init, headers});
    },
  });
  const mcp = await connect(server.url);

  console.log('\nAPI-2: the tool catalogue exposes list_block_types');
  const tools = await mcp.client.listTools();
  const byName = new Map(tools.tools.map((t) => [t.name, t]));
  check('list_block_types is registered', byName.has('list_block_types'));
  const artifactSchema = JSON.stringify(byName.get('create_artifact_page')?.inputSchema ?? {});
  check('create_artifact_page advertises catalogue types in its schema (generated, not hand-written)',
    artifactSchema.includes('htmlArtifact') && artifactSchema.includes('dbview') && artifactSchema.includes('progressbar'));

  console.log('\nAPI-2: EVERY catalogued type is creatable via create_artifact_page (coverage)');
  const blocks = BLOCK_TYPE_CATALOGUE.map((e) => minimalBlock(e.type));
  const created = await mcp.client.callTool({name: 'create_artifact_page', arguments: {title: 'Every block type', blocks}});
  check('one artifact page holding every catalogued type is accepted', !isError(created));
  const createdId = /id (\S+)/.exec(resultText(created))?.[1] ?? '';
  const stored = await seed.getPage(createdId);
  const storedJson = JSON.stringify(stored?.data ?? {});
  for (const e of BLOCK_TYPE_CATALOGUE) {
    check(`stored page contains a "${e.type}" block`, storedJson.includes(`"type":"${e.type}"`));
  }

  console.log('\nAPI-2: unknown types are refused with a pointer at list_block_types');
  const typo = await mcp.client.callTool({name: 'create_artifact_page', arguments: {title: 'Typo', blocks: [{type: 'blink'}]}});
  check('a typo\'d type is refused naming the type', isError(typo) && /Unsupported block type "blink"/.test(resultText(typo)));
  check('the refusal points at list_block_types', /list_block_types/.test(resultText(typo)));

  console.log('\nAPI-2: the table cell-count rule holds on both write paths');
  const ragged = [{
    type: 'table',
    children: [
      {type: 'row', children: [{type: 'cell', text: 'a'}, {type: 'cell', text: 'b'}]},
      {type: 'row', children: [{type: 'cell', text: 'only'}]},
    ],
  }];
  const raggedArtifact = await mcp.client.callTool({name: 'create_artifact_page', arguments: {title: 'Ragged', blocks: ragged}});
  check('create_artifact_page refuses a ragged table', isError(raggedArtifact) && /same number of cells/.test(resultText(raggedArtifact)));
  const target = await seed.savePage({name: 'Append target', data: {editor: 'blocks', blockdoc: {blocks: [{id: 'b1', type: 'heading', text: [{t: 'seed'}], props: {level: 1}}]}, editorjs: {blocks: []}, values: [], names: []}});
  const raggedAppend = await mcp.client.callTool({name: 'append_blocks', arguments: {pageId: target.id, blocks: ragged}});
  check('append_blocks refuses a ragged table', isError(raggedAppend) && /same number of cells/.test(resultText(raggedAppend)));

  console.log('\nAPI-2: update_block_props validates declared prop VALUE types');
  const badProp = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: target.id, blockId: 'b1', props: {level: 'two'}}});
  check('a declared prop with the wrong value type is refused, naming prop and expectation',
    isError(badProp) && /"level"/.test(resultText(badProp)) && /must be a number/.test(resultText(badProp)));
  const okProp = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: target.id, blockId: 'b1', props: {level: 2, mystery: {x: 1}}}});
  check('right-typed declared props plus unknown props pass', !isError(okProp));

  console.log('\nAPI-2: plugin block types — rejected while uninstalled, accepted once installed');
  const uninstalled = await mcp.client.callTool({
    name: 'create_artifact_page',
    arguments: {title: 'Ledger too soon', blocks: [{type: 'openbook.ledger/journal-entry', props: {ledgerRows: ''}}]},
  });
  check('an uninstalled plugin\'s type is refused as not installed',
    isError(uninstalled) && /not installed/.test(resultText(uninstalled)));

  const before = resultText(await mcp.client.callTool({name: 'list_block_types', arguments: {}}));
  for (const e of BLOCK_TYPE_CATALOGUE) {
    assert.ok(before.includes(`- ${e.type} (`), `FAILED: list_block_types lists ${e.type}`);
  }
  passed += 1;
  console.log('  ✓ list_block_types lists every catalogued core + kit type');
  check('with no plugins installed, the plugin section says none', /Installed plugin blocks: none\./.test(before));

  await ownerSeed.installPlugin(ledgerPackage());
  const after = resultText(await mcp.client.callTool({name: 'list_block_types', arguments: {}}));
  check('after installing the bundled ledger plugin, its declared blocks are listed',
    after.includes('openbook.ledger/journal-entry') && after.includes('openbook.ledger/beancount-export'));
  check('plugin lines carry the plugin name', /\(plugin: Ledger/.test(after));

  const installedOk = await mcp.client.callTool({
    name: 'create_artifact_page',
    arguments: {title: 'Ledger page', blocks: [{type: 'openbook.ledger/journal-entry', props: {ledgerRows: ''}}]},
  });
  check('the installed plugin\'s namespaced type is now accepted', !isError(installedOk));

  await mcp.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\nAll ${passed} checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
