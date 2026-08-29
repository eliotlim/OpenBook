import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  AssetUploadError,
  DEFAULT_MAX_ASSET_BYTES,
  HttpDataClient,
  uploadAgentAsset,
  type PageSnapshot,
} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-assets-test';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xqg9WQAAAABJRU5ErkJggg==';
let passed = 0;
const check = (label: string, condition: boolean): void => {
  assert.ok(condition, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
};
const text = (result: {content?: unknown}): string =>
  ((result.content as Array<{type: string; text?: string}> | undefined) ?? []).map((part) => part.text ?? '').join('');
const blocks = (snapshot: PageSnapshot): Array<{id: string; type: string; props?: Record<string, unknown>}> =>
  ((snapshot.blockdoc as {blocks?: Array<{id: string; type: string; props?: Record<string, unknown>}>})?.blocks ?? []);

async function main(): Promise<void> {
  // Unit seam: the estimate is checked before the injected decoder (and before
  // either async page callback), so an attacker cannot force a huge allocation.
  let decoded = false;
  let lookedUp = false;
  await assert.rejects(
    uploadAgentAsset({pageId: 'p', mime: 'image/png', base64: 'A'.repeat(Math.ceil((DEFAULT_MAX_ASSET_BYTES + 1) * 4 / 3))}, {
      pageExists: async () => { lookedUp = true; return true; },
      canWrite: async () => true,
      put: async () => ({id: 'never'}),
    }, () => { decoded = true; return new Uint8Array(); }),
    (error: unknown) => error instanceof AssetUploadError && error.code === 'too-large',
  );
  check('oversize base64 is refused before decode or page lookup', !decoded && !lookedUp);

  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4512});
  const sdk = new HttpDataClient(server.url);
  await sdk.setInstancePolicy({agentEdits: 'direct'});
  const page = await sdk.savePage({name: 'Asset blocks', data: {editor: 'blocks', blockdoc: {blocks: []}, editorjs: {blocks: []}, values: [], names: []}});
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', 'src/bin.ts'], env: {...process.env, OPENBOOK_URL: server.url}, stderr: 'pipe'});
  const client = new Client({name: 'assets-test', version: '0'});
  await client.connect(transport);

  const png = await client.callTool({name: 'upload_asset', arguments: {pageId: page.id, mime: 'image/png', filename: 'pixel.png', base64: PNG}});
  const pngResult = JSON.parse(text(png)) as {assetId: string; bytes: number; mime: string};
  check('PNG upload returns typed metadata without payload', Boolean(pngResult.assetId) && pngResult.bytes > 0 && pngResult.mime === 'image/png' && !text(png).includes(PNG));
  await client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: [{type: 'image', props: {assetId: pngResult.assetId, alt: 'pixel', width: '40%'}}]}});
  let image = blocks((await sdk.getPage(page.id))!.data).find((block) => block.type === 'image')!;
  check('image block round-trips its uploaded assetId', image.props?.assetId === pngResult.assetId);
  await client.callTool({name: 'update_block_props', arguments: {pageId: page.id, blockId: image.id, props: {alt: 'updated pixel', width: '60%'}}});
  image = blocks((await sdk.getPage(page.id))!.data).find((block) => block.id === image.id)!;
  check('image alt and width update round-trip', image.props?.alt === 'updated pixel' && image.props?.width === '60%');

  const htmlBytes = Buffer.from('<!doctype html><p>tiny</p>').toString('base64');
  const html = await client.callTool({name: 'upload_asset', arguments: {pageId: page.id, mime: 'application/octet-stream', filename: 'tiny.html', base64: htmlBytes}});
  const htmlId = (JSON.parse(text(html)) as {assetId: string}).assetId;
  await client.callTool({name: 'append_blocks', arguments: {pageId: page.id, blocks: [{type: 'htmlArtifact', props: {assetId: htmlId, name: 'Tiny', height: 180}}]}});
  check('htmlArtifact round-trips its inert assetId', blocks((await sdk.getPage(page.id))!.data).some((block) => block.type === 'htmlArtifact' && block.props?.assetId === htmlId));

  const evil = await client.callTool({name: 'upload_asset', arguments: {pageId: page.id, mime: 'text/x-evil', base64: 'YQ=='}});
  check('disallowed MIME returns a typed error', evil.isError === true && text(evil).includes('mime-not-allowed'));
  const malformed = await client.callTool({name: 'upload_asset', arguments: {pageId: page.id, mime: 'image/png', base64: '!!!!'}});
  check('malformed base64 returns a typed error', malformed.isError === true && text(malformed).includes('malformed-base64'));
  const missing = await client.callTool({name: 'upload_asset', arguments: {pageId: '00000000-0000-0000-0000-000000000000', mime: 'image/png', base64: 'YQ=='}});
  check('missing page returns a typed error', missing.isError === true && text(missing).includes('page-not-found'));

  await sdk.setInstancePolicy({agentEdits: 'suggest'});
  const readonly = await client.callTool({name: 'upload_asset', arguments: {pageId: page.id, mime: 'image/png', base64: 'YQ=='}});
  check('suggest/read-only policy refuses immediate upload', readonly.isError === true && text(readonly).includes('read-only'));

  const mcpSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const agentSource = readFileSync(new URL('../../server/src/ai/agent.ts', import.meta.url), 'utf8');
  check('MCP and in-app agent call the shared implementation', mcpSource.includes('uploadAgentAsset(') && agentSource.includes('uploadAgentAsset('));

  await client.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n${passed} asset checks passed.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
