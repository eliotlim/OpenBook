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
import {HttpDataClient, type PageSnapshot} from '@open-book/sdk';
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
