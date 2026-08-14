import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {emptyPageSnapshot, type PageSnapshot} from '@book.dev/sdk';
import {externalPgUrl, provisionPostgres, type ProvisionedPostgresDb} from './ledgerFixtureSeed';
import {PageStore} from './store';
import {createBarrier, runConcurrently, withQueryBarrier} from './testUtils/concurrency';

const PG_URL = externalPgUrl();
const PG_REQUIRED = process.env.OPENBOOK_REQUIRE_CONCURRENCY_PG === '1';
const harnessFaults: unknown[] = [];
const RENDEZVOUS_TIMEOUT_MS = 5_000;

if (!PG_URL && !PG_REQUIRED) {
  console.warn(
    '[CWD-11] Postgres concurrency suite SKIPPED — set OPENBOOK_TEST_DATABASE_URL to a Postgres server ' +
      'that permits scratch database creation (for example, run docker-compose.test-pg.yml). ' +
      'CI sets OPENBOOK_REQUIRE_CONCURRENCY_PG=1 so this coverage cannot disappear silently.',
  );
}

test('the real-Postgres backend is present when required by CI', () => {
  if (PG_REQUIRED) {
    expect(
      PG_URL,
      'OPENBOOK_REQUIRE_CONCURRENCY_PG=1 but OPENBOOK_TEST_DATABASE_URL is unset',
    ).not.toBeNull();
  }
});

const snapshot = (text = ''): PageSnapshot => ({
  editorjs: {blocks: text ? [{id: 'b1', type: 'paragraph', data: {text}}] : []},
  values: [],
  names: [],
});

const snapshotText = (value: PageSnapshot): string | undefined =>
  (value.editorjs as {blocks?: Array<{data?: {text?: string}}>} | undefined)?.blocks?.[0]?.data?.text;

describe.skipIf(PG_URL === null)('PageStore write races on real Postgres', () => {
  let provisioned: ProvisionedPostgresDb | undefined;

  beforeEach(async () => {
    if (!PG_URL) throw new Error('Postgres describe block ran without OPENBOOK_TEST_DATABASE_URL');
    provisioned = await provisionPostgres(PG_URL);
  });

  afterEach(async () => {
    await provisioned?.destroy();
    provisioned = undefined;
  });

  // CWD-2: when flipping to `test`, re-point the rendezvous at the fixed SQL shape and hard-assert
  // `snapshotsRead.arrived === snapshotsRead.parties`; otherwise a missed race can pass silently.
  test.fails('CWD-2: concurrent updateRow whole-blob writes lose one property key', {timeout: 5_000}, async () => {
    const store = new PageStore(provisioned!.db);
    const host = await store.upsertPage({name: 'CWD-2 database', data: emptyPageSnapshot()});
    const database = await store.createDatabase({pageId: host.id});
    const row = await store.createRow(database.id, {properties: {seed: true}});
    const snapshotsRead = createBarrier(2);

    const writer = (key: 'left' | 'right') => async (): Promise<void> => {
      const current = (await store.listRows(database.id)).find((candidate) => candidate.id === row.id);
      if (!current) throw new Error('CWD-2 fixture row disappeared');
      await snapshotsRead.arriveAndWait();
      await store.updateRow(database.id, row.id, {
        properties: {...current.properties, [key]: true},
      });
    };

    await runConcurrently([writer('left'), writer('right')], harnessFaults);

    const final = (await store.listRows(database.id)).find((candidate) => candidate.id === row.id);
    expect(final?.properties).toEqual({seed: true, left: true, right: true});
  });

  // CWD-3: when flipping to `test`, re-point the matcher at the fixed SQL (including `FOR UPDATE`)
  // and hard-assert `barrier.arrived === barrier.parties`; otherwise a missed race can pass silently.
  test.fails('CWD-3: concurrent instance-config patches lose one policy key', {timeout: 5_000}, async () => {
    const store = new PageStore(
      withQueryBarrier(provisioned!.db, {
        parties: 2,
        matches: (sql) =>
          sql.includes('SELECT value FROM settings WHERE key = \'instance\'') && !sql.includes('FOR UPDATE'),
        rendezvousTimeoutMs: RENDEZVOUS_TIMEOUT_MS,
        harnessFaults,
      }),
    );

    await runConcurrently([
      () => store.updateInstanceConfig({guestAccess: 'off'}),
      () => store.updateInstanceConfig({agentEdits: 'direct'}),
    ], harnessFaults);

    expect(await store.getInstanceConfig()).toMatchObject({
      guestAccess: 'off',
      agentEdits: 'direct',
    });
  });

  // CWD-4: when flipping to `test`, re-point the matcher at the fixed lock/merge SQL and hard-assert
  // `barrier.arrived === barrier.parties`; otherwise a missed race can pass silently.
  test.fails('CWD-4: concurrent page-property patches lose one property key', {timeout: 5_000}, async () => {
    const setupStore = new PageStore(provisioned!.db);
    const page = await setupStore.upsertPage({name: 'CWD-4 page', data: emptyPageSnapshot()});
    await setupStore.setPageProperties(page.id, {seed: true});

    const store = new PageStore(
      withQueryBarrier(provisioned!.db, {
        parties: 2,
        matches: (sql) => sql.includes('SELECT properties FROM pages WHERE id = $1'),
        rendezvousTimeoutMs: RENDEZVOUS_TIMEOUT_MS,
        harnessFaults,
      }),
    );

    await runConcurrently([
      () => store.setPageProperties(page.id, {left: true}),
      () => store.setPageProperties(page.id, {right: true}),
    ], harnessFaults);

    expect((await store.getPage(page.id))?.properties).toEqual({seed: true, left: true, right: true});
  });

  test('setPageProperties stays disjoint from concurrent rename and content upsert', {timeout: 5_000}, async () => {
    const setupStore = new PageStore(provisioned!.db);
    const page = await setupStore.upsertPage({name: 'before', data: snapshot('before')});
    const [propertiesDb, renameDb, contentDb] = await provisioned!.participants(3);
    const propertiesStore = new PageStore(propertiesDb);
    const renameStore = new PageStore(renameDb);
    const contentStore = new PageStore(contentDb);

    await runConcurrently([
      () => propertiesStore.setPageProperties(page.id, {tag: 'kept'}),
      () => renameStore.renamePage(page.id, 'renamed'),
      () => contentStore.upsertPage({id: page.id, name: 'renamed', data: snapshot('after')}),
    ], harnessFaults);

    const final = await setupStore.getPage(page.id);
    expect(final).not.toBeNull();
    expect(final?.name).toBe('renamed');
    expect(final?.properties).toEqual({tag: 'kept'});
    expect(snapshotText(final!.data)).toBe('after');
  });
});

test('harness observed no infrastructure fault', () => expect(harnessFaults).toEqual([]));
