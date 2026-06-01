/**
 * End-to-end integration test for the OpenBook server + SDK.
 *
 * Exercises the REAL client (`@open-book/sdk` `HttpDataClient`) against a live
 * server, in both deployment modes, plus durability across a restart:
 *
 *   1. Embedded mode  — server boots its own Postgres under a data dir.
 *   2. Persistence    — data survives a full server stop + restart.
 *   3. Headless mode  — server connects to a separately-started Postgres URL.
 *
 * Run: pnpm --filter @open-book/server test:e2e
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {HttpDataClient, type PageSnapshot} from '@open-book/sdk';
import {startEmbeddedPostgres} from '../src/embedded';
import {startServer} from '../src/server';

const ROOT = '/tmp/openbook-e2e';
const EMBEDDED_DIR = `${ROOT}/embedded`;
const HEADLESS_DIR = `${ROOT}/headless`;

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

/** Full CRUD + error-path exercise against a client. Returns nothing. */
async function exerciseCrud(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] CRUD via HttpDataClient`);

  // create
  const created = await client.savePage({name: `page-${mode}`, data: sampleSnapshot(42)});
  check('create returns a uuid', /^[0-9a-f-]{36}$/.test(created.id));
  check('create round-trips name', created.name === `page-${mode}`);
  check('create round-trips values', JSON.stringify(created.data.values) === JSON.stringify([['c1', 42]]));
  check('create round-trips names', JSON.stringify(created.data.names) === JSON.stringify([['x', 'c1']]));
  check('create sets timestamps', Boolean(created.createdAt) && Boolean(created.updatedAt));

  // get
  const fetched = await client.getPage(created.id);
  check('get returns the page', fetched !== null && fetched.id === created.id);
  check('get round-trips data', JSON.stringify(fetched?.data) === JSON.stringify(created.data));

  // get missing → null
  const missing = await client.getPage('00000000-0000-0000-0000-000000000000');
  check('get of unknown id → null', missing === null);

  // list (metadata only)
  const list = await client.listPages();
  check('list includes the page', list.some((p) => p.id === created.id));
  check('list items carry no data payload', !('data' in (list.find((p) => p.id === created.id) ?? {})));

  // update (upsert by id) bumps updatedAt and replaces data
  const updated = await client.savePage({id: created.id, name: created.name, data: sampleSnapshot(99)});
  check('update keeps id', updated.id === created.id);
  check('update replaces values', JSON.stringify(updated.data.values) === JSON.stringify([['c1', 99]]));
  check('update bumps updatedAt', updated.updatedAt >= created.updatedAt);

  // name-uniqueness → server 409 → client throws
  await assert.rejects(
    () => client.savePage({name: `page-${mode}`, data: sampleSnapshot(1)}),
    /already exists/,
    'duplicate name should be rejected',
  );
  check('duplicate name rejected (409)', true);

  // delete
  check('delete returns true', (await client.deletePage(created.id)) === true);
  check('get after delete → null', (await client.getPage(created.id)) === null);
  check('second delete returns false', (await client.deletePage(created.id)) === false);
}

async function main(): Promise<void> {
  rmSync(ROOT, {recursive: true, force: true});

  // ---- 1. Embedded mode ----
  console.log('\n=== 1. EMBEDDED MODE (server boots its own Postgres) ===');
  let server = await startServer({
    dataDir: EMBEDDED_DIR,
    embeddedPort: 5455,
    host: '127.0.0.1',
    port: 4401,
  });
  console.log(`  server up at ${server.url}`);
  const embeddedClient = new HttpDataClient(server.url);

  // health
  const health = await fetch(`${server.url}/health`).then((r) => r.text());
  check('health endpoint returns ok', health === 'ok');

  await exerciseCrud(embeddedClient, 'embedded');

  // ---- 2. Persistence across restart ----
  console.log('\n=== 2. PERSISTENCE ACROSS RESTART ===');
  const durable = await embeddedClient.savePage({name: 'durable', data: sampleSnapshot(7)});
  check('seeded a page before restart', durable.id.length === 36);
  await server.close();
  console.log('  server stopped (embedded Postgres stopped)');

  server = await startServer({dataDir: EMBEDDED_DIR, embeddedPort: 5455, host: '127.0.0.1', port: 4401});
  console.log(`  server restarted at ${server.url}`);
  const afterRestart = new HttpDataClient(server.url);
  const survivor = await afterRestart.getPage(durable.id);
  check('page survived restart', survivor !== null && survivor.id === durable.id);
  check('data survived restart', JSON.stringify(survivor?.data.values) === JSON.stringify([['c1', 7]]));
  await server.close();

  // ---- 3. Headless mode (external Postgres URL) ----
  console.log('\n=== 3. HEADLESS MODE (connect to a provided DATABASE_URL) ===');
  const pg = await startEmbeddedPostgres(HEADLESS_DIR, 5456);
  console.log(`  standalone Postgres at ${pg.url}`);
  const headless = await startServer({databaseUrl: pg.url, host: '127.0.0.1', port: 4402});
  console.log(`  headless server up at ${headless.url}`);
  await exerciseCrud(new HttpDataClient(headless.url), 'headless');
  await headless.close();
  await pg.stop();

  rmSync(ROOT, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — embedded, persistence, and headless flows verified.`);
}

main().catch((err) => {
  console.error('\n❌ E2E FAILED:', err);
  process.exit(1);
});
