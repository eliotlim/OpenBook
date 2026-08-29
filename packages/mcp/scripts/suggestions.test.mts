/**
 * AGED-3: the MCP write tools honor the resolved AGENT-EDITS POLICY PER WRITE
 * (page override + instance mode via `resolveAgentEdits`), replacing the retired
 * static `OPENBOOK_MCP_ALLOW_DIRECT_EDITS` env grant.
 *
 * Boots a real OpenBook server (AGED-1 routes: `GET/PUT /api/pages/:id/agent-edits`
 * + instance `agentEdits`) and drives `src/bin.ts` over stdio across the policy
 * matrix:
 *  - resolved suggest → a StoredSuggestion, no mutation;
 *  - resolved direct  → an immediate mutation, no suggestion;
 *  - a PAGE override beats the INSTANCE mode in BOTH directions;
 *  - the retired env var alone does NOT enable direct (and logs a deprecation);
 *  - a fail-safe: an older server (the policy route 404s) → suggest, even when the
 *    underlying instance mode is `direct`.
 *
 * Run: pnpm --filter @book.dev/mcp test
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
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

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn `src/bin.ts` over stdio. Returns the connected client plus a live reader of
 *  the connector's stderr (so we can assert the retirement deprecation line). */
async function connect(url: string, opts: {directEnv?: boolean} = {}): Promise<{client: Client; stderr: () => string; close: () => Promise<void>}> {
  const env: Record<string, string> = {...(process.env as Record<string, string>), OPENBOOK_URL: url};
  if (opts.directEnv) env.OPENBOOK_MCP_ALLOW_DIRECT_EDITS = '1';
  const transport = new StdioClientTransport({command: process.execPath, args: ['--import', 'tsx', 'src/bin.ts'], env, stderr: 'pipe'});
  const client = new Client({name: 'openbook-mcp-suggestions-test', version: '0.0.0'});
  await client.connect(transport);
  let err = '';
  transport.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  return {client, stderr: () => err, close: () => client.close()};
}

/**
 * A forwarding proxy that stands in for a PRE-AGED-1 server: it forwards every
 * request to the real server EXCEPT `GET …/agent-edits`, which it 404s (the route
 * didn't exist before AGED-1). Everything else — getPage, getInstanceInfo,
 * createSuggestion, savePage — passes through unchanged.
 */
function startPolicyBlindProxy(targetUrl: string, port: number): Promise<{url: string; close: () => Promise<void>}> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (req.method === 'GET' && /\/agent-edits(\?|$)/.test(path)) {
      res.writeHead(404, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: 'not found'}));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
      if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
      // Relay the STAB-8 first-party-client marker verbatim, exactly as the real
      // forwarding tunnel does (it is not in the tunnel's strip-list). Without it the
      // server's guest-write gate 403s the forwarded suggestion write as a drive-by,
      // which would mask the fail-safe path we're actually exercising here.
      if (req.headers['x-openbook-client']) headers['x-openbook-client'] = String(req.headers['x-openbook-client']);
      fetch(targetUrl + path, {method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined})
        .then(async (r) => {
          const buf = Buffer.from(await r.arrayBuffer());
          const ct = r.headers.get('content-type');
          res.writeHead(r.status, ct ? {'content-type': ct} : {});
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(502);
          res.end();
        });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r()))}),
    ),
  );
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

  // ── RESOLVED SUGGEST (instance suggest default + page inherit): suggestions. ───
  console.log('\nResolved suggest (instance suggest, page inherit) — writes create suggestions');
  const dflt = await connect(server.url);

  const upd = await dflt.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'edited by mcp'}});
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

  const readBack = await dflt.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('the page text was NOT mutated (still original)', resultText(readBack).includes('original text') && !resultText(readBack).includes('edited by mcp'));

  const cell = await dflt.client.callTool({name: 'set_db_cell', arguments: {pageId: dbHost.id, rowId: row.id, propertyId: textProp.id, value: 'cell via mcp'}});
  check('set_db_cell returns a "Suggested for review" result', resultText(cell).includes('Suggested for review'));
  const cellSuggs = await seed.listSuggestions(dbHost.id);
  const cellSugg = cellSuggs.find((s) => s.kind === 'set-cell');
  check('set_db_cell recorded a set-cell suggestion on the host page', Boolean(cellSugg));
  check('set-cell suggestion targets the db/row/property', cellSugg?.target.databaseId === database.id && cellSugg?.target.rowId === row.id && cellSugg?.target.propertyId === textProp.id);
  const rowAfter = await seed.listRows(database.id);
  check('the database cell was NOT mutated', (rowAfter.find((r) => r.id === row.id)?.properties?.[textProp.id] ?? null) === null);

  const dbSuggestCalls = [
    await dflt.client.callTool({name: 'create_database', arguments: {title: 'Suggested database'}}),
    await dflt.client.callTool({name: 'update_database', arguments: {pageId: dbHost.id, name: 'Suggested rename'}}),
    await dflt.client.callTool({name: 'create_property', arguments: {pageId: dbHost.id, name: 'Suggested property', type: 'number'}}),
    await dflt.client.callTool({name: 'update_property', arguments: {pageId: dbHost.id, propertyId: textProp.id, name: 'Suggested text'}}),
    await dflt.client.callTool({name: 'update_row', arguments: {pageId: dbHost.id, rowId: row.id, name: 'Suggested row'}}),
    await dflt.client.callTool({name: 'delete_row', arguments: {pageId: dbHost.id, rowId: row.id}}),
  ];
  check('all six API-9 database writes suggest under suggest policy', dbSuggestCalls.every((result) => resultText(result).includes('Suggested for review')));
  const dbDescription = await dflt.client.callTool({name: 'describe_database', arguments: {pageId: dbHost.id}});
  check('describe_database remains a read under suggest policy', resultText(dbDescription).includes(database.id));
  check('suggested update/delete row did not mutate', (await seed.listRows(database.id)).some((candidate) => candidate.id === row.id && candidate.name === 'A task'));

  // Creation stays immediate regardless of policy (non-destructive, no target page).
  const created = await dflt.client.callTool({name: 'create_page', arguments: {title: 'New note', content: 'hi'}});
  const createdId = /id ([0-9a-f-]{36})/.exec(resultText(created))?.[1];
  check('create_page applies immediately (page exists)', Boolean(createdId) && Boolean(await seed.getPage(createdId!)));
  check('create_page recorded no suggestion', (await seed.listSuggestions(createdId!)).length === 0);

  await dflt.close();

  // ── RESOLVED DIRECT (instance mode = direct): immediate mutation. ─────────────
  console.log('\nResolved direct (instance policy = direct) — writes mutate directly');
  await seed.setInstancePolicy({agentEdits: 'direct'});
  const suggestionsBeforeDirect = (await seed.listSuggestions(page.id)).length;
  const direct = await connect(server.url);

  const directDbHost = await seed.savePage({name: 'Direct DB', data: {editorjs: {blocks: []}, values: [], names: []}});
  const directDb = await seed.createDatabase({pageId: directDbHost.id, name: 'Direct DB', schema: defaultDatabaseSchema()});
  const directRow = await seed.createRow(directDb.id, {name: 'Direct row'});
  const directText = directDb.schema.properties.find((property) => property.type === 'text')!;
  const directCalls = [
    await direct.client.callTool({name: 'create_database', arguments: {title: 'Direct created DB'}}),
    await direct.client.callTool({name: 'update_database', arguments: {pageId: directDbHost.id, name: 'Direct renamed DB'}}),
    await direct.client.callTool({name: 'create_property', arguments: {pageId: directDbHost.id, name: 'Points', type: 'number'}}),
    await direct.client.callTool({name: 'update_property', arguments: {pageId: directDbHost.id, propertyId: directText.id, name: 'Direct text'}}),
    await direct.client.callTool({name: 'update_row', arguments: {pageId: directDbHost.id, rowId: directRow.id, name: 'Direct updated row'}}),
    await direct.client.callTool({name: 'delete_row', arguments: {pageId: directDbHost.id, rowId: directRow.id}}),
  ];
  check('all six API-9 database writes apply under direct policy', directCalls.every((result) => result.isError !== true && !resultText(result).includes('Suggested for review')));
  check('direct delete_row moved the row to trash', (await seed.listRows(directDb.id)).length === 0 && (await seed.listTrash()).some((candidate) => candidate.id === directRow.id));

  const updD = await direct.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'edited by instance direct'}});
  check('update_block confirms a direct write', resultText(updD).includes('Updated block') && resultText(updD).includes('directly'));
  const readD = await direct.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('the page text WAS mutated under instance=direct', resultText(readD).includes('edited by instance direct'));
  check('direct write recorded NO new suggestion', (await seed.listSuggestions(page.id)).length === suggestionsBeforeDirect);

  await direct.close();

  // ── PAGE OVERRIDE beats INSTANCE — direction 1: page suggest over instance direct.
  console.log('\nPage override (suggest) beats instance (direct)');
  await seed.setPageAgentEdits(page.id, 'suggest'); // instance is still direct
  const suggestionsBeforeOv1 = (await seed.listSuggestions(page.id)).length;
  const ov1 = await connect(server.url);
  const updOv1 = await ov1.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'should be suggested not applied'}});
  check('page suggest override → a suggestion despite instance direct', resultText(updOv1).includes('Suggested for review'));
  const readOv1 = await ov1.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('page suggest override did NOT mutate', !resultText(readOv1).includes('should be suggested not applied'));
  check('page suggest override recorded a new suggestion', (await seed.listSuggestions(page.id)).length === suggestionsBeforeOv1 + 1);
  await ov1.close();

  // ── PAGE OVERRIDE beats INSTANCE — direction 2: page direct over instance suggest.
  console.log('\nPage override (direct) beats instance (suggest)');
  await seed.setInstancePolicy({agentEdits: 'suggest'});
  await seed.setPageAgentEdits(page.id, 'direct');
  const suggestionsBeforeOv2 = (await seed.listSuggestions(page.id)).length;
  const ov2 = await connect(server.url);
  const updOv2 = await ov2.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'edited by page direct'}});
  check('page direct override → a direct write despite instance suggest', resultText(updOv2).includes('Updated block') && resultText(updOv2).includes('directly'));
  const readOv2 = await ov2.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('page direct override mutated the page', resultText(readOv2).includes('edited by page direct'));
  check('page direct override recorded NO new suggestion', (await seed.listSuggestions(page.id)).length === suggestionsBeforeOv2);
  await ov2.close();

  // ── RETIRED ENV VAR: it does NOT enable direct; a deprecation is logged. ──────
  console.log('\nRetired OPENBOOK_MCP_ALLOW_DIRECT_EDITS — never enables direct, logs a deprecation');
  await seed.setInstancePolicy({agentEdits: 'suggest'});
  await seed.setPageAgentEdits(page.id, 'inherit'); // resolves to instance suggest
  const suggestionsBeforeEnv = (await seed.listSuggestions(page.id)).length;
  const envConn = await connect(server.url, {directEnv: true});
  const updEnv = await envConn.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'env should not apply'}});
  check('env var set + policy suggest → still a suggestion', resultText(updEnv).includes('Suggested for review'));
  const readEnv = await envConn.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('env var did NOT force a direct write', !resultText(readEnv).includes('env should not apply'));
  check('env var write recorded a suggestion (not a mutation)', (await seed.listSuggestions(page.id)).length === suggestionsBeforeEnv + 1);
  await tick();
  check('the connector logged a deprecation for the retired env var',
    /OPENBOOK_MCP_ALLOW_DIRECT_EDITS/.test(envConn.stderr()) && /no longer grant/i.test(envConn.stderr()));
  await envConn.close();

  // ── FAIL-SAFE: an older server (policy route 404s) → suggest, even if instance=direct.
  console.log('\nFail-safe: older server (agent-edits route absent) → suggest even under instance=direct');
  await seed.setInstancePolicy({agentEdits: 'direct'}); // underlying instance WOULD be direct
  const proxy = await startPolicyBlindProxy(server.url, 4407);
  const suggestionsBeforeFs = (await seed.listSuggestions(page.id)).length;
  const fs = await connect(proxy.url);
  const updFs = await fs.client.callTool({name: 'update_block', arguments: {pageId: page.id, blockId: 'b1', text: 'must not apply on old server'}});
  check('policy fetch failing (404) → a suggestion, not a direct write', resultText(updFs).includes('Suggested for review'));
  const readFs = await fs.client.callTool({name: 'read_page', arguments: {pageId: page.id}});
  check('fail-safe did NOT mutate despite instance=direct', !resultText(readFs).includes('must not apply on old server'));
  check('fail-safe recorded a suggestion', (await seed.listSuggestions(page.id)).length === suggestionsBeforeFs + 1);
  await fs.close();
  await proxy.close();

  const readOnly = await connect(server.url);
  await seed.setInstancePolicy({guestAccess: 'read'});
  const readOnlyCalls = [
    await readOnly.client.callTool({name: 'create_database', arguments: {title: 'Refused DB'}}),
    await readOnly.client.callTool({name: 'update_database', arguments: {pageId: dbHost.id, name: 'Refused rename'}}),
    await readOnly.client.callTool({name: 'create_property', arguments: {pageId: dbHost.id, name: 'Refused property', type: 'text'}}),
    await readOnly.client.callTool({name: 'update_property', arguments: {pageId: dbHost.id, propertyId: textProp.id, name: 'Refused text'}}),
    await readOnly.client.callTool({name: 'update_row', arguments: {pageId: dbHost.id, rowId: row.id, name: 'Refused row'}}),
    await readOnly.client.callTool({name: 'delete_row', arguments: {pageId: dbHost.id, rowId: row.id}}),
  ];
  check('all six API-9 database writes return typed refusals on a read-only instance', readOnlyCalls.every((result) =>
    result.isError === true && resultText(result).includes('[permission_denied]')));
  await readOnly.close();

  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — MCP writes honor the resolved agent-edits policy per write (env grant retired).`);
}

main().catch((err: unknown) => {
  console.error('\n❌ MCP suggestions test failed:', err);
  process.exit(1);
});
