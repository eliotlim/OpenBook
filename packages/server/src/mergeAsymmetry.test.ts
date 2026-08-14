import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {emptyPageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {createApp} from './app';
import {PageHub} from './hub';
import {externalPgUrl, provisionPostgres} from './ledgerFixtureSeed';

const PG_URL = externalPgUrl();
if (!PG_URL) {
  console.warn(
    '[CWD-3] updateRow concurrency: external-Postgres case SKIPPED — set OPENBOOK_TEST_DATABASE_URL ' +
      'to a Postgres server on which scratch databases may be created.',
  );
}

let store: PageStore;

beforeEach(async () => {
  store = new PageStore(await PgliteDb.create('memory://'));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
});

async function createTestRow(properties: Record<string, unknown>) {
  const host = await store.upsertPage({name: 'Merge asymmetry', data: emptyPageSnapshot()});
  const database = await store.createDatabase({pageId: host.id, name: 'Merge asymmetry'});
  const row = await store.createRow(database.id, {properties});
  return {database, row};
}

const patchRow = (databaseId: string, rowId: string, body: unknown) =>
  createApp(store, undefined, new PageHub()).request(`/api/databases/${databaseId}/rows/${rowId}`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify(body),
  });

describe('updateRow property patches (CWD-3)', () => {
  it('preserves keys from sequential partial writes to different properties', async () => {
    const {database, row} = await createTestRow({seed: true});

    await store.updateRow(database.id, row.id, {properties: {left: 'L'}});
    const updated = await store.updateRow(database.id, row.id, {properties: {right: 'R'}});

    expect(updated?.properties).toEqual({seed: true, left: 'L', right: 'R'});
  });

  it('deletes a property whose patch value is null', async () => {
    const {database, row} = await createTestRow({keep: 'yes', remove: 'me'});

    const updated = await store.updateRow(database.id, row.id, {properties: {remove: null}});

    expect(updated?.properties).toEqual({keep: 'yes'});
    expect(updated?.properties).not.toHaveProperty('remove');
  });

  it('treats a null properties bag as a no-op at the store boundary', async () => {
    const {database, row} = await createTestRow({keep: 'yes', count: 3});

    const updated = await store.updateRow(database.id, row.id, {properties: null});

    expect(updated?.properties).toEqual({keep: 'yes', count: 3});
  });

  it('treats an empty properties bag as a deliberate no-op', async () => {
    const {database, row} = await createTestRow({keep: 'yes', count: 3});

    const updated = await store.updateRow(database.id, row.id, {properties: {}});

    expect(updated?.properties).toEqual({keep: 'yes', count: 3});
  });

  it('applies stale property bags per key instead of replacing the stored blob', async () => {
    const {database, row} = await createTestRow({seed: true});
    const stale = {...row.properties};

    await store.updateRow(database.id, row.id, {properties: {...stale, left: true}});
    const updated = await store.updateRow(database.id, row.id, {properties: {...stale, right: true}});

    expect(updated?.properties).toEqual({seed: true, left: true, right: true});
  });

  it('applies concurrent same-key PGlite patches in FIFO last-writer order', async () => {
    const {database, row} = await createTestRow({keep: true, shared: 'seed'});

    await Promise.all([
      store.updateRow(database.id, row.id, {properties: {shared: 'first'}}),
      store.updateRow(database.id, row.id, {properties: {shared: 'second'}}),
    ]);

    expect((await store.listRows(database.id))[0]?.properties).toEqual({keep: true, shared: 'second'});
  });

  it('PATCH with a null properties bag returns 200 and leaves the row unchanged', async () => {
    const {database, row} = await createTestRow({keep: 'wire', count: 3});

    const response = await patchRow(database.id, row.id, {properties: null});

    expect(response.status).toBe(200);
    expect(((await response.json()) as {properties: Record<string, unknown>}).properties).toEqual({keep: 'wire', count: 3});
  });

  it('keeps other cells across an MCP-shaped single-key PATCH', async () => {
    const {database, row} = await createTestRow({status: 'todo', owner: 'Ada', estimate: 5});

    // This is the exact wire shape emitted by set_db_cell at packages/mcp/src/server.ts:1718.
    const response = await patchRow(database.id, row.id, {properties: {status: 'done'}});

    expect(response.status).toBe(200);
    expect(((await response.json()) as {properties: Record<string, unknown>}).properties).toEqual({
      status: 'done',
      owner: 'Ada',
      estimate: 5,
    });
  });
});

it.skipIf(!PG_URL)('serializes concurrent different-key updateRow writes with FOR UPDATE on real Postgres', async () => {
  if (!PG_URL) throw new Error('test must be skipped without OPENBOOK_TEST_DATABASE_URL');
  const provisioned = await provisionPostgres(PG_URL);
  try {
    const pgStore = new PageStore(provisioned.db);
    const host = await pgStore.upsertPage({name: 'Postgres merge', data: emptyPageSnapshot()});
    const database = await pgStore.createDatabase({pageId: host.id, name: 'Postgres merge'});
    const row = await pgStore.createRow(database.id, {properties: {seed: true}});

    await Promise.all([
      pgStore.updateRow(database.id, row.id, {properties: {left: 'L'}}),
      pgStore.updateRow(database.id, row.id, {properties: {right: 'R'}}),
    ]);

    expect((await pgStore.listRows(database.id))[0]?.properties).toEqual({seed: true, left: 'L', right: 'R'});
  } finally {
    await provisioned.destroy();
  }
});

describe('updateInstanceConfig merge transaction (CWD-3)', () => {
  it('keeps concurrent PGlite patches together by enclosing the merge in one transaction', async () => {
    await Promise.all([
      store.updateInstanceConfig({guestAccess: 'off'}),
      store.updateInstanceConfig({agentEdits: 'direct'}),
    ]);

    expect(await store.getInstanceConfig()).toMatchObject({
      guestAccess: 'off',
      agentEdits: 'direct',
    });
  });
});
