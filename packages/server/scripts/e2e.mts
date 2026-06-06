/**
 * End-to-end integration test for the OpenBook server + SDK.
 *
 * Exercises the real client (`@open-book/sdk` `HttpDataClient`) against a live
 * server, covering both database backends and durability:
 *
 *   1. Embedded mode   — server opens embedded PGlite under a data dir.
 *   2. Persistence     — data survives a full server stop + restart.
 *   3. Headless mode   — server connects to Postgres over the wire (provided
 *                        here by pglite-socket so no external server is needed).
 *
 * Run: pnpm --filter @open-book/server test:e2e
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {
  applyView,
  defaultDatabaseSchema,
  HttpDataClient,
  TITLE_PROPERTY_ID,
  type PageSnapshot,
} from '@open-book/sdk';
import {startServer} from '../src/server';

const ROOT = '/tmp/openbook-e2e';
const EMBEDDED_DIR = `${ROOT}/embedded`;

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const sampleSnapshot = (n: number): PageSnapshot => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `hello ${n}`}}]},
  values: [['c1', n]],
  names: [['x', 'c1']],
});

async function exerciseCrud(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] CRUD via HttpDataClient`);

  const created = await client.savePage({name: `page-${mode}`, data: sampleSnapshot(42)});
  check('create returns a uuid', /^[0-9a-f-]{36}$/.test(created.id));
  check('create round-trips name', created.name === `page-${mode}`);
  check('create round-trips values', JSON.stringify(created.data.values) === JSON.stringify([['c1', 42]]));
  check('create round-trips names', JSON.stringify(created.data.names) === JSON.stringify([['x', 'c1']]));
  check('create sets timestamps', Boolean(created.createdAt) && Boolean(created.updatedAt));

  const fetched = await client.getPage(created.id);
  check('get returns the page', fetched !== null && fetched.id === created.id);
  check('get round-trips data', JSON.stringify(fetched?.data) === JSON.stringify(created.data));

  const missing = await client.getPage('00000000-0000-0000-0000-000000000000');
  check('get of unknown id -> null', missing === null);

  const list = await client.listPages();
  check('list includes the page', list.some((p) => p.id === created.id));
  check('list items carry no data payload', !('data' in (list.find((p) => p.id === created.id) ?? {})));

  const updated = await client.savePage({id: created.id, name: created.name, data: sampleSnapshot(99)});
  check('update keeps id', updated.id === created.id);
  check('update replaces values', JSON.stringify(updated.data.values) === JSON.stringify([['c1', 99]]));
  check('update bumps updatedAt', updated.updatedAt >= created.updatedAt);

  await assert.rejects(
    () => client.savePage({name: `page-${mode}`, data: sampleSnapshot(1)}),
    /already exists/,
    'duplicate name should be rejected',
  );
  check('duplicate name rejected (409)', true);

  const renamed = await client.renamePage(created.id, `renamed-${mode}`);
  check('rename changes the name', renamed.name === `renamed-${mode}`);
  check('rename preserves data', JSON.stringify(renamed.data.values) === JSON.stringify([['c1', 99]]));

  check('delete returns true', (await client.deletePage(created.id)) === true);
  check('get after delete -> null', (await client.getPage(created.id)) === null);
  check('second delete returns false', (await client.deletePage(created.id)) === false);
}

// A row snapshot whose reactive store exports a named `total` cell — exercises
// the `expr`/exports projection that powers reactive database columns.
const rowSnapshot = (total: number): PageSnapshot => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `row total ${total}`}}]},
  values: [['cell-total', total]],
  names: [['total', 'cell-total']],
});

async function exerciseNesting(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Nested pages via HttpDataClient`);

  const parent = await client.savePage({name: `parent-${mode}`, data: sampleSnapshot(1)});
  const child = await client.savePage({name: `child-${mode}`, data: sampleSnapshot(2), parentId: parent.id});
  const grandchild = await client.savePage({name: `gc-${mode}`, data: sampleSnapshot(3), parentId: child.id});
  check('child records its parent', child.parentId === parent.id);
  check('grandchild records its parent', grandchild.parentId === child.id);
  check('top-level page has no parent', parent.parentId === null);

  const list = await client.listPages();
  check('nested pages appear in the list with parentId', list.find((p) => p.id === child.id)?.parentId === parent.id);

  // A content save (no parentId) must not detach the page from its parent.
  const resaved = await client.savePage({id: child.id, name: child.name, data: sampleSnapshot(99)});
  check('content save preserves the parent', resaved.parentId === parent.id);

  // Deleting the parent cascades through the whole subtree.
  check('delete parent', (await client.deletePage(parent.id)) === true);
  check('child removed by cascade', (await client.getPage(child.id)) === null);
  check('grandchild removed by cascade', (await client.getPage(grandchild.id)) === null);
}

async function exerciseDatabase(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Notion-style database via HttpDataClient`);

  // Host page (a regular page that will point at a database).
  const host = await client.savePage({name: `db-host-${mode}`, data: sampleSnapshot(0)});
  const schema = defaultDatabaseSchema();
  const db = await client.createDatabase({pageId: host.id, name: `Tasks ${mode}`, schema});
  check('create database returns id', /^[0-9a-f-]{36}$/.test(db.id));
  check('database is linked to its host page', db.pageId === host.id);
  check('database round-trips schema', db.schema.properties.length === schema.properties.length);

  const hostAfter = await client.getPage(host.id);
  check('host page reports hostedDatabaseId', hostAfter?.hostedDatabaseId === db.id);
  check('host page keeps its own content', JSON.stringify(hostAfter?.data.values) === JSON.stringify([['c1', 0]]));

  const viaPage = await client.getPageDatabase(host.id);
  check('database is reachable via its host page', viaPage?.id === db.id);

  const list = await client.listPages();
  check('host page appears in the page list', list.some((p) => p.id === host.id && p.hostedDatabaseId === db.id));

  // Rows are pages tagged with the database id, hidden from the page list.
  const notesProp = schema.properties.find((p) => p.type === 'text')!;
  const r1 = await client.createRow(db.id, {
    name: 'Alpha',
    properties: {[notesProp.id]: 'first note'},
    data: rowSnapshot(10),
  });
  const r2 = await client.createRow(db.id, {name: 'Bravo', data: rowSnapshot(30)});
  check('row create returns a page id', /^[0-9a-f-]{36}$/.test(r1.id));
  check('row carries its database membership', r1.databaseId === db.id);

  const afterRows = await client.listPages();
  check('rows are excluded from the page list', !afterRows.some((p) => p.id === r1.id || p.id === r2.id));

  const rows = await client.listRows(db.id);
  check('listRows returns both rows', rows.length === 2);
  const alpha = rows.find((r) => r.name === 'Alpha');
  check('row round-trips manual property', alpha?.properties[notesProp.id] === 'first note');
  check('row projects exported cell value', alpha?.exports.total === 10);

  // Editing a row's content (a page write) updates its projected exports.
  await client.savePage({id: r1.id, name: 'Alpha', data: rowSnapshot(99)});
  const rowsAfterEdit = await client.listRows(db.id);
  check('exports refresh after a content save', rowsAfterEdit.find((r) => r.id === r1.id)?.exports.total === 99);

  // updateRow changes title + manual properties without touching content.
  const renamed = await client.updateRow(db.id, r1.id, {name: 'Alpha Prime', properties: {[notesProp.id]: 'edited'}});
  check('updateRow changes the title', renamed.name === 'Alpha Prime');
  check('updateRow changes a property', renamed.properties[notesProp.id] === 'edited');
  check('updateRow leaves exports intact', renamed.exports.total === 99);

  // Pure view evaluation: filter + sort run identically here and in the UI.
  const sorted = applyView(rowsAfterEdit, {
    id: 'v', name: 'v', type: 'table', filters: [], sorts: [{propertyId: TITLE_PROPERTY_ID, direction: 'asc'}],
  }, schema.properties);
  check('applyView sorts by title ascending', sorted[0].name === 'Alpha Prime' || sorted[0].name === 'Alpha');

  // Deleting the host page cascades to the database and its row pages.
  check('delete host page', (await client.deletePage(host.id)) === true);
  check('database removed by cascade', (await client.getDatabase(db.id)) === null);
  check('row page removed by cascade', (await client.getPage(r1.id)) === null);
}

async function main(): Promise<void> {
  rmSync(ROOT, {recursive: true, force: true});

  // ---- 1. Embedded mode (PGlite) ----
  console.log('\n=== 1. EMBEDDED MODE (embedded PGlite) ===');
  let server = await startServer({dataDir: EMBEDDED_DIR, host: '127.0.0.1', port: 4401});
  console.log(`  server up at ${server.url}`);
  const embeddedClient = new HttpDataClient(server.url);

  const health = await fetch(`${server.url}/health`).then((r) => r.text());
  check('health endpoint returns ok', health === 'ok');

  await exerciseCrud(embeddedClient, 'embedded');
  await exerciseDatabase(embeddedClient, 'embedded');
  await exerciseNesting(embeddedClient, 'embedded');

  // ---- 2. Persistence across restart ----
  console.log('\n=== 2. PERSISTENCE ACROSS RESTART ===');
  const durable = await embeddedClient.savePage({name: 'durable', data: sampleSnapshot(7)});
  check('seeded a page before restart', durable.id.length === 36);
  await server.close();
  console.log('  server stopped');

  server = await startServer({dataDir: EMBEDDED_DIR, host: '127.0.0.1', port: 4401});
  console.log(`  server restarted at ${server.url}`);
  const survivor = await new HttpDataClient(server.url).getPage(durable.id);
  check('page survived restart', survivor !== null && survivor.id === durable.id);
  check('data survived restart', JSON.stringify(survivor?.data.values) === JSON.stringify([['c1', 7]]));
  await server.close();

  // ---- 3. Headless mode (Postgres over the wire via pglite-socket) ----
  console.log('\n=== 3. HEADLESS MODE (Postgres wire protocol) ===');
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({db: pglite, host: '127.0.0.1', port: 5599});
  await socket.start();
  console.log('  postgres-compatible socket up at 127.0.0.1:5599');
  const headless = await startServer({
    databaseUrl: 'postgres://postgres@127.0.0.1:5599/postgres',
    host: '127.0.0.1',
    port: 4402,
    poolMax: 1,
  });
  console.log(`  headless server up at ${headless.url}`);
  await exerciseCrud(new HttpDataClient(headless.url), 'headless');
  await exerciseDatabase(new HttpDataClient(headless.url), 'headless');
  await exerciseNesting(new HttpDataClient(headless.url), 'headless');
  await headless.close();
  await socket.stop();
  await pglite.close();

  rmSync(ROOT, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — embedded, persistence, and headless flows verified.`);
}

main().catch((err) => {
  console.error('\n❌ E2E FAILED:', err);
  process.exit(1);
});
