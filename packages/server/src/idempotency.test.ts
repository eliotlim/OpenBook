import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {HttpDataClient, type ImportRequest, type PageSnapshot, type Principal, type StoredPage} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';

// ER-6 (import idempotency) + ER-7 (client write-replay idempotency). Re-applying
// the SAME bundle / replaying the SAME create must be a no-op (the OB-241 family of
// replay storms), while distinct bundles/creates are unaffected — and the ER-7
// dedup is scoped per-principal so one user's key can't touch another's write.

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-idem-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const ISS = 'https://account.book.pub';
const principal = (sub: string): Principal => ({kind: 'user', subject: sub, issuer: ISS, name: sub, verifiedVia: 'jws'});

const snapshot = (text?: string, author?: string): PageSnapshot => ({
  editorjs: {blocks: text ? [{id: 'b1', type: 'paragraph', data: {text}}] : []},
  values: [],
  names: [],
  ...(author ? {authors: [['b1', author]] as Array<[string, string]>} : {}),
});

const pageFixture = (over: Partial<StoredPage> & {id: string}): StoredPage => ({
  name: null,
  data: snapshot(),
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe('ER-6 — /api/import idempotency (content-hash dedup)', () => {
  it('re-applying the same bundle is a no-op: no duplicate pages, no duplicate page.synced rows', async () => {
    const store = await freshStore();
    const authored = pageFixture({
      id: 'p-1',
      name: `er6-${seq}`,
      data: snapshot('hi', `${ISS}#alice`),
    });
    const bundle: ImportRequest = {pages: [authored], databases: [], mode: 'copy'};

    const r1 = await store.importBundle(bundle);
    expect(r1.created).toBe(1);
    expect(r1.deduped).toBeFalsy();

    const r2 = await store.importBundle(bundle); // exact replay
    expect(r2.deduped).toBe(true);

    // Copy mode would otherwise re-ID + re-INSERT the whole bundle each call.
    const named = (await store.listPages()).filter((p) => p.name === `er6-${seq}`);
    expect(named).toHaveLength(1);

    // recordSyncedAttribution must not pile up duplicate credits.
    const synced = (await store.listEdits()).filter((e) => e.kind === 'page.synced');
    expect(synced).toHaveLength(1);
  });

  it('a genuinely different bundle still imports normally', async () => {
    const store = await freshStore();
    await store.importBundle({pages: [pageFixture({id: 'a', name: `er6-a-${seq}`})], databases: [], mode: 'copy'});
    const r = await store.importBundle({pages: [pageFixture({id: 'b', name: `er6-b-${seq}`})], databases: [], mode: 'copy'});
    expect(r.deduped).toBeFalsy();
    expect(r.created).toBe(1);
    const names = (await store.listPages()).map((p) => p.name);
    expect(names).toContain(`er6-a-${seq}`);
    expect(names).toContain(`er6-b-${seq}`);
  });

  it('re-importing overlapping pages by id does not duplicate the synced attribution (skip-guard)', async () => {
    const store = await freshStore();
    // Overwrite mode keeps the page's own id, so it must be a real UUID.
    const id = randomUUID();
    const p = pageFixture({id, name: `er6-ov-${seq}`, data: snapshot('x', `${ISS}#bob`)});
    await store.importBundle({pages: [p], databases: [], mode: 'overwrite'});

    // A DISTINCT bundle (different timestamp → different content hash) overwriting
    // the SAME page id: it imports (not deduped), but the (page, bob) credit already
    // exists, so the synced-attribution guard prevents a second row.
    const p2 = {...p, updatedAt: new Date(Date.now() + 1000).toISOString()};
    const r = await store.importBundle({pages: [p2], databases: [], mode: 'overwrite'});
    expect(r.deduped).toBeFalsy();
    expect(r.overwritten).toBe(1);

    const synced = (await store.listEdits(id)).filter((e) => e.kind === 'page.synced');
    expect(synced).toHaveLength(1);
  });

  it('two concurrent imports of the same bundle apply exactly one page-set (TOCTOU guard)', async () => {
    const store = await freshStore();
    const bundle: ImportRequest = {pages: [pageFixture({id: 'c-1', name: `conc-${seq}`})], databases: [], mode: 'copy'};

    // Fire both before either commits. With the old check-then-act (a separate
    // SELECT then a separate import txn) both would miss the ledger and both
    // copy-import (fresh UUIDs → no page-level conflict) → a duplicated workspace.
    // Claim-first inside one transaction means exactly one wins; the other dedupes.
    const [r1, r2] = await Promise.all([store.importBundle(bundle), store.importBundle(bundle)]);
    expect([r1, r2].filter((r) => r.deduped)).toHaveLength(1);

    const matching = (await store.listPages()).filter((p) => p.name?.startsWith(`conc-${seq}`));
    expect(matching).toHaveLength(1);
  });

  it('the route skips the space.import provenance entry on a deduped re-apply', async () => {
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    const bundle = {pages: [pageFixture({id: 'r-1', name: `er6-route-${seq}`})], databases: [], mode: 'copy'};
    const post = () =>
      app.request('/api/import', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
        body: JSON.stringify(bundle),
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200); // replay

    // Let the fire-after-commit edit-log writes flush.
    await new Promise((r) => setTimeout(r, 25));
    const imports = (await store.listEdits()).filter((e) => e.kind === 'space.import');
    expect(imports).toHaveLength(1);
  });
});

describe('ER-7 — client write-replay idempotency (per-principal key)', () => {
  it('a replayed keyless create with the same idempotency key yields exactly one page', async () => {
    const store = await freshStore();
    const alice = principal(`${ISS}#alice`);
    const input = {name: `er7-${seq}`, data: snapshot(), idempotencyKey: 'k-1'};

    const p1 = await store.upsertPage(input, alice);
    const p2 = await store.upsertPage(input, alice); // replay
    expect(p2.id).toBe(p1.id);

    const mine = (await store.listPages()).filter((p) => p.id === p1.id);
    expect(mine).toHaveLength(1);
  });

  it('honours the original write on replay, ignoring the replay payload', async () => {
    const store = await freshStore();
    const alice = principal(`${ISS}#alice`);
    const p1 = await store.upsertPage({name: `er7-orig-${seq}`, data: snapshot('first'), idempotencyKey: 'k-2'}, alice);
    // Same key, different content → returns the original page, not a second one.
    const p2 = await store.upsertPage({name: `er7-changed-${seq}`, data: snapshot('second'), idempotencyKey: 'k-2'}, alice);
    expect(p2.id).toBe(p1.id);
    expect(p2.name).toBe(`er7-orig-${seq}`);
    expect((await store.listPages()).filter((p) => p.name?.startsWith('er7-'))).toHaveLength(1);
  });

  it('distinct creates (different keys) are unaffected', async () => {
    const store = await freshStore();
    const alice = principal(`${ISS}#alice`);
    const a = await store.upsertPage({name: `er7-d1-${seq}`, data: snapshot(), idempotencyKey: 'k-a'}, alice);
    const b = await store.upsertPage({name: `er7-d2-${seq}`, data: snapshot(), idempotencyKey: 'k-b'}, alice);
    expect(a.id).not.toBe(b.id);
    expect((await store.listPages()).filter((p) => p.name?.startsWith('er7-d'))).toHaveLength(2);
  });

  it('the key is scoped per-principal: A cannot dedupe or overwrite B (and vice versa)', async () => {
    const store = await freshStore();
    const alice = principal(`${ISS}#alice`);
    const bob = principal(`${ISS}#bob`);

    const pa = await store.upsertPage({name: `er7-pp-a-${seq}`, data: snapshot(), idempotencyKey: 'shared'}, alice);
    // SAME key string, different principal → its OWN page (no collision, no overwrite).
    const pb = await store.upsertPage({name: `er7-pp-b-${seq}`, data: snapshot(), idempotencyKey: 'shared'}, bob);
    expect(pb.id).not.toBe(pa.id);

    const names = (await store.listPages()).map((p) => p.name);
    expect(names).toContain(`er7-pp-a-${seq}`);
    expect(names).toContain(`er7-pp-b-${seq}`);

    // Alice's replay still resolves to HER page, never Bob's.
    const replay = await store.upsertPage({name: `er7-pp-a-${seq}`, data: snapshot(), idempotencyKey: 'shared'}, alice);
    expect(replay.id).toBe(pa.id);
  });

  it('SDK savePage pre-mints + sends an id for a keyless create, so a transport replay is a no-op', async () => {
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    let lastBody: string | undefined;
    const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') lastBody = init.body as string;
      return Promise.resolve(app.request(input, init));
    };
    const client = new HttpDataClient('', undefined, {fetchImpl});

    const page = await client.savePage({name: `er7-sdk-${seq}`, data: snapshot()});
    const sent = JSON.parse(lastBody!) as {id?: string};
    expect(sent.id).toBeTruthy(); // the client minted + sent the id
    expect(page.id).toBe(sent.id);

    // Simulate a transport-level retry: re-POST the byte-identical request the
    // client built. The server's ON CONFLICT no-op means no duplicate page.
    const replay = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: lastBody!,
    });
    expect(replay.status).toBe(201);
    expect((await store.listPages()).filter((p) => p.name === `er7-sdk-${seq}`)).toHaveLength(1);
  });
});
