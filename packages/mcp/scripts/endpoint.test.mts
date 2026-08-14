/**
 * Endpoint-unification + instance-verification test for the OpenBook MCP connector
 * (STAB-5).
 *
 * The bug: with local MCP enabled the connector defaulted to `http://127.0.0.1:4319`
 * but the packaged desktop sidecar was socket-only, so NOTHING of the app listened
 * there — the connector would silently adopt any FOREIGN responder on 4319 (a stale
 * `pnpm dev` with its own data dir) and report the real library's pages as
 * "nonexistent".
 *
 * This proves the two halves of the fix:
 *  1. A single sidecar bound on BOTH the socket and loopback TCP over ONE data dir
 *     serves, through the connector (src/bin.ts), the SAME pages its own HTTP API
 *     shows.
 *  2. The connector VERIFIES instance identity: pointed at a foreign/mismatched
 *     responder it refuses with an explicit mismatch error (never silently serves
 *     another instance's empty data); pointed at a dead port it surfaces a clear
 *     reachability error. Both exit non-zero.
 *
 * Run: pnpm --filter @book.dev/mcp test:endpoint
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {HttpDataClient} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

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

/** Run src/bin.ts once with the given env and collect its exit code + stderr. Used
 *  for the REFUSAL paths, where the connector exits at startup before any stdio
 *  handshake. */
function runConnector(env: Record<string, string>): Promise<{code: number | null; stderr: string}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts'], {
      env: {...process.env, ...env},
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('exit', (code) => resolve({code, stderr}));
  });
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ob-mcp-endpoint-'));
  const foreignDir = mkdtempSync(join(tmpdir(), 'ob-mcp-foreign-'));
  const socketPath = join(dataDir, 'openbook.sock');

  // (1) ONE sidecar, ONE data dir, bound on BOTH the socket AND loopback TCP —
  // exactly what the desktop host does when the local-MCP toggle is on.
  const server = await startServer({dataDir, socketPath, host: '127.0.0.1', port: 4409});
  console.log(`\nOpenBook sidecar up (socket + TCP) at ${server.url}`);

  const api = new HttpDataClient(server.url);
  const seeded = await api.savePage({
    name: 'Endpoint verification note',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Reachable over the unified endpoint.'}}]}, values: [], names: []},
  });
  const discoveryToken = 'mcp-listed-enforcement-token';
  const discoverable = await api.savePage({
    name: 'Discoverable MCP note',
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: discoveryToken}}]}, values: [], names: []},
  });
  const hidden = await api.savePage({
    name: 'Unlisted MCP note',
    listed: false,
    data: {editorjs: {blocks: [{type: 'paragraph', data: {text: discoveryToken}}]}, values: [], names: []},
  });
  const info = await api.getInstanceInfo();
  check('the server advertises a stable instanceId', typeof info.instanceId === 'string' && info.instanceId.length > 0);
  const instanceId = info.instanceId!;

  // A second, INDEPENDENT library — a stand-in for the stale `pnpm dev` on the port.
  const foreign = await startServer({dataDir: foreignDir, host: '127.0.0.1', port: 4410});
  const foreignInfo = await new HttpDataClient(foreign.url).getInstanceInfo();
  check('the foreign server has a DIFFERENT instanceId', foreignInfo.instanceId !== instanceId);

  console.log('\nHappy path: connector over the unified endpoint lists the SAME pages');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...process.env, OPENBOOK_URL: server.url, OPENBOOK_INSTANCE_ID: instanceId},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-endpoint', version: '0.0.0'});
  await client.connect(transport);
  const list = await client.callTool({name: 'list_pages', arguments: {}});
  check(
    'connector lists the page the server API shows',
    resultText(list).includes('Endpoint verification note') && resultText(list).includes(seeded.id),
  );
  check(
    'list_pages inherits the client list filter (no MCP-side reimplementation)',
    resultText(list).includes(discoverable.id) && !resultText(list).includes(hidden.id),
  );
  const search = await client.callTool({name: 'search_notes', arguments: {query: discoveryToken}});
  check(
    'search_notes inherits the client search filter',
    resultText(search).includes(discoverable.id) && !resultText(search).includes(hidden.id),
  );
  const direct = await client.callTool({name: 'read_page', arguments: {pageId: hidden.id}});
  check('an unlisted page remains directly readable', resultText(direct).includes('Unlisted MCP note'));
  await client.close();

  console.log('\nRefusal: foreign responder on the target endpoint');
  // Point the connector at the FOREIGN server but tell it to expect OUR library id.
  const mismatch = await runConnector({OPENBOOK_URL: foreign.url, OPENBOOK_INSTANCE_ID: instanceId});
  check('connector exits non-zero on an identity mismatch', mismatch.code === 1);
  check(
    'the error names the mismatch (never silently adopts the foreign server)',
    /identity mismatch/i.test(mismatch.stderr) && mismatch.stderr.includes(instanceId),
  );

  console.log('\nRefusal: nothing listening on the target port');
  const unreachable = await runConnector({OPENBOOK_URL: 'http://127.0.0.1:4599', OPENBOOK_INSTANCE_ID: instanceId});
  check('connector exits non-zero when the endpoint is unreachable', unreachable.code === 1);
  check('the error is a clear reachability message', /cannot reach an OpenBook server/i.test(unreachable.stderr));

  await server.close();
  await foreign.close();
  rmSync(dataDir, {recursive: true, force: true});
  rmSync(foreignDir, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — unified endpoint + instance verification.`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP endpoint test failed:', err);
  process.exit(1);
});
