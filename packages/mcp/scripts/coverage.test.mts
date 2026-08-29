/**
 * API-6: executable drift guard for every SDK-catalogued block type and every
 * block declared by the bundled ledger plugin. Also owns the generated matrix
 * at docs/audits/block-api-coverage.md.
 */
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BLOCK_TYPE_CATALOGUE,
  CHILD_ONLY_PARENT,
  HttpDataClient,
  LOCAL_OWNER_HEADER,
  type BlockPropType,
  type BlockTypeInfo,
  type PluginManifest,
} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DATA_DIR = '/tmp/openbook-mcp-coverage-test';
const DOC = join(ROOT, 'docs', 'audits', 'block-api-coverage.md');
const LOCAL_OWNER_SECRET = 'mcp-coverage-local-owner';

/** Deliberate gaps belong here, with a reviewable and type-specific reason. */
const EXEMPT: Record<string, string> = {
};

const resultText = (res: {content?: unknown}): string =>
  ((res.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
const isError = (res: {isError?: unknown}): boolean => res.isError === true;

async function connect(url: string): Promise<{client: Client; close: () => Promise<void>}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...(process.env as Record<string, string>), OPENBOOK_URL: url},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-coverage-test', version: '0.0.0'});
  await client.connect(transport);
  return {client, close: () => client.close()};
}

function ledgerPackage(): {manifest: PluginManifest; files: Record<string, string>} {
  const dir = join(ROOT, 'examples', 'plugins', 'ledger');
  const manifest = JSON.parse(readFileSync(join(dir, 'openbook.json'), 'utf8')) as PluginManifest;
  const files: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|json)$/.test(entry) && entry !== 'openbook.json') {
        files[relative(dir, full)] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return {manifest, files};
}

const validValue = (kind: BlockPropType): unknown => ({
  string: 'coverage', number: 1, boolean: true, array: [], object: {},
})[kind];
const invalidValue = (kind: BlockPropType): unknown => ({
  string: 7, number: 'wrong', boolean: 'wrong', array: {}, object: [],
})[kind];

type WireBlock = {type: string; text?: string; props?: Record<string, unknown>; children?: WireBlock[]};

function targetBlock(info: BlockTypeInfo, marker: string): WireBlock {
  const props: Record<string, unknown> = {_coverage: marker};
  if (info.kitValue) {
    props.name = `coverage_${info.type}`;
    if (info.props?.value) props.value = validValue(info.props.value);
    if (info.props?.selected) props.selected = [];
    if (info.props?.runs) props.runs = [];
  }
  const block: WireBlock = {type: info.type, props};
  if (info.nature === 'text') block.text = 'created';
  if (info.nature === 'container') {
    if (info.type === 'table') block.children = [{type: 'row', children: [{type: 'cell', text: 'cell'}]}];
    else if (info.type === 'columns') block.children = [{type: 'column', props: {span: 12}, children: [{type: 'paragraph', text: 'child'}]}];
    else if (info.type === 'tabs') block.children = [{type: 'tab', props: {label: 'Tab'}, children: [{type: 'paragraph', text: 'child'}]}];
    else if (info.type === 'accordion') block.children = [{type: 'accordionsection', props: {label: 'Section'}, children: [{type: 'paragraph', text: 'child'}]}];
    else if (info.type === 'row') block.children = [{type: 'cell', text: 'cell'}];
    else block.children = [{type: 'paragraph', text: 'child'}];
  }
  return block;
}

function wrappedBlock(info: BlockTypeInfo, marker: string): WireBlock {
  let block = targetBlock(info, marker);
  for (let type = info.type; CHILD_ONLY_PARENT[type]; type = CHILD_ONLY_PARENT[type]) {
    block = {type: CHILD_ONLY_PARENT[type], children: [block]};
  }
  return block;
}

type StoredBlock = {id?: string; type?: string; props?: Record<string, unknown>; text?: unknown; children?: StoredBlock[]};
function allBlocks(blocks: StoredBlock[]): StoredBlock[] {
  return blocks.flatMap((block) => [block, ...allBlocks(block.children ?? [])]);
}

function matrix(pluginTypes: string[]): string {
  const rows = BLOCK_TYPE_CATALOGUE.map((info) => {
    const mark = (applicable = true): string => applicable ? '✅' : '➖';
    const kit = info.kitValue ? (EXEMPT[info.type] ? `exempt: ${EXEMPT[info.type]}` : '✅') : '➖';
    return `| ${info.type} | ${mark()} | ${mark()} | ${mark(info.nature === 'text')} | ${mark()} | ${kit} | ➖ |`;
  });
  rows.push(...pluginTypes.map((type) => `| ${type} | ✅ | ✅ | ➖ | ✅ | ➖ | ✅ |`));
  return [
    '<!-- GENERATED by packages/mcp/scripts/coverage.test.mts — do not edit. -->',
    '# Block API coverage', '',
    '| Block type | Create | Props | Text | Delete | Kit value | Plugin |',
    '| --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
  ].join('\n');
}

async function main(): Promise<void> {
  for (const [type, reason] of Object.entries(EXEMPT)) {
    assert.ok(BLOCK_TYPE_CATALOGUE.some((entry) => entry.type === type), `EXEMPT names unknown type: ${type}`);
    assert.ok(reason.trim().length >= 12, `EXEMPT requires a specific justification: ${type}`);
    console.log(`EXEMPT: ${type} — ${reason}`);
  }
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4426, localOwnerSecret: LOCAL_OWNER_SECRET});
  const seed = new HttpDataClient(server.url);
  const ownerSeed = new HttpDataClient(server.url, undefined, {fetchImpl: (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(LOCAL_OWNER_HEADER, LOCAL_OWNER_SECRET);
    return fetch(input, {...init, headers});
  }});
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const page = await seed.savePage({name: 'API coverage', data: {editor: 'blocks', blockdoc: {blocks: []}, editorjs: {blocks: []}, values: [], names: []}});
  const mcp = await connect(server.url);
  const run = async (type: string, step: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (error) {
      throw new Error(`API coverage gap: ${type} — ${step} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const callOk = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await mcp.client.callTool({name, arguments: args});
    assert.ok(!isError(result), resultText(result));
    return resultText(result);
  };
  const findTarget = async (marker: string): Promise<StoredBlock> => {
    const stored = await seed.getPage(page.id);
    const roots = ((stored?.data.blockdoc as {blocks?: StoredBlock[]})?.blocks ?? []);
    const target = allBlocks(roots).find((block) => block.props?._coverage === marker);
    assert.ok(target?.id, `created block marker ${marker} not found in stored page`);
    return target;
  };

  try {
    for (const [index, info] of BLOCK_TYPE_CATALOGUE.entries()) {
      const marker = `${index}-${info.type}`;
      await run(info.type, 'create', async () => { await callOk('append_blocks', {pageId: page.id, blocks: [wrappedBlock(info, marker)]}); });
      const target = await findTarget(marker);
      await run(info.type, 'props', async () => {
        const declared = Object.entries(info.props ?? {}).find(([key]) =>
          !(info.type === 'form' && key === 'submissionKey') && !(info.kitValue && key === 'name'));
        const props = declared ? {[declared[0]]: validValue(declared[1])} : {bg: 'coverage'};
        await callOk('update_block_props', {pageId: page.id, blockId: target.id, props});
        if (declared) {
          const bad = await mcp.client.callTool({name: 'update_block_props', arguments: {pageId: page.id, blockId: target.id, props: {[declared[0]]: invalidValue(declared[1])}}});
          assert.ok(isError(bad) && resultText(bad).includes(`"${declared[0]}"`), `invalid ${declared[0]} was not a typed error naming the prop: ${resultText(bad)}`);
        }
      });
      if (info.nature === 'text') await run(info.type, 'text', async () => {
        await callOk('update_block', {pageId: page.id, blockId: target.id, text: `updated ${info.type}`});
        const updated = await findTarget(marker);
        assert.ok(JSON.stringify(updated.text).includes(`updated ${info.type}`));
      });
      if (info.kitValue && !EXEMPT[info.type]) await run(info.type, 'kit-value', async () => {
        const name = `coverage_${info.type}`;
        const before = await callOk('get_kit_values', {pageId: page.id});
        assert.ok(before.includes(`${name} =`), before);
        const value = info.type === 'slider' || info.type === 'number' ? 2
          : info.type === 'toggle' ? false
          : info.type === 'checklist' || info.type === 'tagfield' ? ['round-trip']
          : info.type === 'location' ? {lat: 1.3521, lng: 103.8198, label: 'Singapore'}
          : 'round-trip';
        await callOk('set_kit_value', {pageId: page.id, name, value});
        const after = await callOk('get_kit_values', {pageId: page.id});
        assert.ok(after.includes(`${name} = ${JSON.stringify(value)}`), after);
      });
      await run(info.type, 'delete', async () => {
        await callOk('delete_block', {pageId: page.id, blockId: target.id});
        const stored = await seed.getPage(page.id);
        const roots = ((stored?.data.blockdoc as {blocks?: StoredBlock[]})?.blocks ?? []);
        assert.ok(!allBlocks(roots).some((block) => block.id === target.id), 'block still exists');
      });
      console.log(`  ✓ ${info.type}`);
    }

    const ledger = ledgerPackage();
    await ownerSeed.installPlugin(ledger);
    const pluginTypes = (ledger.manifest.blocks ?? []).map((block) => `${ledger.manifest.id}/${block.type}`);
    for (const [index, type] of pluginTypes.entries()) {
      const marker = `plugin-${index}`;
      await run(type, 'plugin create', async () => { await callOk('append_blocks', {pageId: page.id, blocks: [{type, props: {_coverage: marker}}]}); });
      const target = await findTarget(marker);
      await run(type, 'plugin props', async () => { await callOk('update_block_props', {pageId: page.id, blockId: target.id, props: {coverage: true}}); });
      await run(type, 'plugin delete', async () => { await callOk('delete_block', {pageId: page.id, blockId: target.id}); });
      console.log(`  ✓ ${type}`);
    }

    const generated = matrix(pluginTypes);
    let committed = '';
    try { committed = readFileSync(DOC, 'utf8'); } catch { /* generated below */ }
    if (committed !== generated) {
      writeFileSync(DOC, generated);
      const offender = BLOCK_TYPE_CATALOGUE.find((entry) => !committed.includes(`| ${entry.type} |`))?.type ?? 'coverage-matrix';
      throw new Error(`API coverage gap: ${offender} — matrix failed: regenerated stale ${relative(ROOT, DOC)}; commit it and rerun`);
    }
    console.log(`\nAll ${BLOCK_TYPE_CATALOGUE.length} catalogue types + ${pluginTypes.length} plugin blocks have MCP API coverage; exemptions: ${Object.keys(EXEMPT).length || 'none'}.`);
  } finally {
    await mcp.close();
    await server.close();
    rmSync(DATA_DIR, {recursive: true, force: true});
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
