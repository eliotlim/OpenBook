import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as Y from 'yjs';
import {mintIdentityKeypair, signIdentity, type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp, type AppWithCollab} from './app';
import {encodeServerBlockDoc, ServerAuthoritativePersister} from './collabPersist';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

/**
 * Collab T9 — server-authoritative persistence wired through the real Hono app
 * (route → write-gate → persister → durable store). Proves the opt-in flag turns the
 * server into the persistence authority (a `/updates` alone durably lands, FROM the
 * server's canonical doc), the `/sync` reconciliation seam reports the checkpoint, and
 * — critically — that the DEFAULT (flag off) still writes nothing on `/updates`, so the
 * shipped T3 client-saver model is untouched (OB-241's "relay is not the system of
 * record" invariant holds).
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];
const persisters: ServerAuthoritativePersister[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-t9app-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return store;
}

function persistedApp(store: PageStore): ReturnType<typeof createApp> {
  const app = createApp(store, undefined, new PageHub(), {serverPersist: true});
  persisters.push((app as AppWithCollab).collabPersist!);
  return app;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const persister of persisters.splice(0)) await persister.close();
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

function blockDoc(id: string, text: string): Y.Doc {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>('blocks');
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('type', 'paragraph');
  const t = new Y.Text();
  if (text) t.insert(0, text);
  m.set('text', t);
  arr.push([m]);
  return doc;
}

// Seed a durable block page and return its id + a client doc forked from the seed.
async function seed(store: PageStore, name: string): Promise<{id: string; client: Y.Doc}> {
  const doc = blockDoc('a', '');
  const blockdoc = encodeServerBlockDoc(doc);
  const page = await store.upsertPage({name, data: {editor: 'blocks', blockdoc} as unknown as PageSnapshot});
  const client = new Y.Doc();
  Y.applyUpdate(client, Buffer.from(blockdoc.update, 'base64'));
  doc.destroy();
  return {id: page.id, client};
}

const postUpdate = (
  app: ReturnType<typeof createApp>,
  id: string,
  update: Uint8Array,
  clientId: number,
  headers: Record<string, string> = {},
): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/pages/${id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1', ...headers},
      body: JSON.stringify({update: Buffer.from(update).toString('base64'), clientId}),
    }),
  );

const blocksOf = async (store: PageStore, id: string): Promise<Array<{id: string; text?: unknown}>> =>
  ((await store.getPage(id))?.data as {blockdoc?: {blocks?: Array<{id: string; text?: unknown}>}} | undefined)?.blockdoc
    ?.blocks ?? [];

// The concatenated text of the page's first (block 'a') block in the durable snapshot.
const textOf = async (store: PageStore, id: string): Promise<string> => {
  const t = (await blocksOf(store, id))[0]?.text;
  return Array.isArray(t) ? (t as Array<{t: string}>).map((op) => op.t).join('') : '';
};

const authorOf = async (store: PageStore, id: string, blockId: string): Promise<string | undefined> =>
  new Map(((await store.getPage(id))?.data as {authors?: Array<[string, string]>} | undefined)?.authors ?? []).get(blockId);

const snapshotOf = (doc: Y.Doc): PageSnapshot =>
  ({editor: 'blocks', blockdoc: encodeServerBlockDoc(doc)}) as unknown as PageSnapshot;

// A block-doc page snapshot with block 'a' carrying `text` (for durable seeding + versions).
const snap = (text: string): PageSnapshot => {
  const d = blockDoc('a', text);
  const s = snapshotOf(d);
  d.destroy();
  return s;
};

// The `/updates` route feeds the persister fire-and-forget (it 204s before the ingest
// lands), and the checkpoint is debounced — so poll the durable store for the result.
async function waitFor(predicate: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for durable checkpoint');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Poll `predicate` for up to `ms`, resolving `true` the moment it holds, else `false` when the
// window elapses. Used to assert a durable write does NOT land within a generous window.
async function within(ms: number, predicate: () => Promise<boolean>): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('Collab T9 — server-authoritative persistence (opt-in)', () => {
  it('durably persists FROM the server doc on a /updates alone (no client PUT)', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const {id, client} = await seed(store, 'T9-on');

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'typed');
    const res = await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    expect(res.status).toBe(204);

    // The debounced server checkpoint lands the edit durably — no client PUT involved.
    await waitFor(async () => JSON.stringify(await blocksOf(store, id)).includes('typed'));
    expect(await blocksOf(store, id)).toEqual([{id: 'a', type: 'paragraph', text: [{t: 'typed'}]}]);
    client.destroy();
  });

  it('/sync reports the durable checkpoint state vector (savedSv reconciliation seam)', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const {id, client} = await seed(store, 'T9-sync');

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'x');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await waitFor(async () => (app as AppWithCollab).collabPersist!.savedStateVector(id) != null);

    const res = await app.request(`/api/pages/${id}/sync`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({sv: ''}),
    });
    const body = (await res.json()) as {update: string | null; savedSv: string | null};
    expect(body.savedSv).not.toBeNull(); // the server advertises how far the durable store is
    client.destroy();
  });

  it('DEFAULT (flag off): a /updates writes NOTHING durably + savedSv is null (T3 untouched)', async () => {
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub()); // no serverPersist
    const {id, client} = await seed(store, 'T9-off');
    expect((app as AppWithCollab).collabPersist).toBeNull();

    // Spy AFTER the seed so we count only what /updates does.
    let writes = 0;
    const realSave = store.saveServerDoc.bind(store);
    (store as unknown as {saveServerDoc: PageStore['saveServerDoc']}).saveServerDoc = ((...args) => {
      writes += 1;
      return realSave(...(args as Parameters<PageStore['saveServerDoc']>));
    }) as PageStore['saveServerDoc'];

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'nope');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await new Promise((r) => setTimeout(r, 50));

    expect(writes).toBe(0); // the server never persisted — the client save stays the writer
    const res = await app.request(`/api/pages/${id}/sync`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({sv: ''}),
    });
    // Flag off ⇒ the /sync response is byte-identical to pre-T9: `savedSv` is omitted
    // entirely (not even a null), so the shape is exactly `{update}`.
    const body = (await res.json()) as Record<string, unknown>;
    expect('savedSv' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['update']);
    client.destroy();
  });

  it.each([
    {persist: false, label: 'without data', data: undefined},
    {persist: false, label: 'with data:null', data: null},
    {persist: true, label: 'without data', data: undefined},
    {persist: true, label: 'with data:null', data: null},
  ])('PUT $label returns 200 when server persistence is $persist', async ({persist, data}) => {
    const store = await freshStore();
    const app = persist ? persistedApp(store) : createApp(store, undefined, new PageHub());
    const {id, client} = await seed(store, `put-optional-data-${persist}-${data === null ? 'null' : 'missing'}`);
    const body: Record<string, unknown> = {name: 'optional-data'};
    if (data === null) body.data = null;

    const res = await app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    client.destroy();
  });

  it('converges after a stale snapshot PUT and accepts the live client\'s dependent delta', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const {id, client: liveClient} = await seed(store, 'snapshot-put-convergence');
    const baseUpdate = Buffer.from(
      ((await store.getPage(id))!.data as {blockdoc: {update: string}}).blockdoc.update,
      'base64',
    );
    const staleClient = new Y.Doc();
    const expected = new Y.Doc();
    Y.applyUpdate(staleClient, baseUpdate);
    Y.applyUpdate(expected, baseUpdate);

    // C2 advances and checkpoints. C1 remains on the seed and later writes a stale
    // whole snapshot carrying a concurrent operation.
    const liveText = liveClient.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const liveBefore = Y.encodeStateVector(liveClient);
    liveText.insert(0, 'LIVE');
    const liveUpdate = Y.encodeStateAsUpdate(liveClient, liveBefore);
    Y.applyUpdate(expected, liveUpdate);
    await postUpdate(app, id, liveUpdate, liveClient.clientID);
    await waitFor(async () => (await textOf(store, id)) === 'LIVE');

    const staleText = staleClient.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    staleText.insert(0, 'STALE');
    Y.applyUpdate(expected, Y.encodeStateAsUpdate(staleClient));
    const put = await app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-put-convergence', data: snapshotOf(staleClient)}),
    });
    expect(put.status).toBe(200);

    // This delta is causally dependent on C2's earlier LIVE operations. Reseeding the
    // canonical doc from C1's stale snapshot makes Yjs pend it forever; retaining the
    // canonical union accepts it and the next checkpoint durably converges.
    const againBefore = Y.encodeStateVector(liveClient);
    liveText.insert(liveText.length, '-AGAIN');
    const againUpdate = Y.encodeStateAsUpdate(liveClient, againBefore);
    Y.applyUpdate(expected, againUpdate);
    await postUpdate(app, id, againUpdate, liveClient.clientID);
    const expectedText = (expected.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).toString();
    await waitFor(async () => (await textOf(store, id)) === expectedText);
    expect(await textOf(store, id)).toBe(expectedText);
    expect(expectedText).toContain('STALE');
    expect(expectedText).toContain('LIVE-AGAIN');

    liveClient.destroy();
    staleClient.destroy();
    expected.destroy();
  });

  it('preserves an authenticated snapshot PUT author through the live-session merge checkpoint', async () => {
    const store = await freshStore();
    const issuer = 'https://account.book.pub';
    const subject = `${issuer}#alice`;
    const keys = await mintIdentityKeypair('server-persist-author');
    await store.updateInstanceConfig({trustedIssuers: [{issuer, jwks: {keys: [keys.publicJwk]}}]});
    const app = createApp(store, undefined, new PageHub(), {
      serverPersist: true,
      identity: new IdentityService(store),
    });
    const persister = (app as AppWithCollab).collabPersist!;
    persisters.push(persister);
    const identity = await signIdentity(
      keys.privateKey,
      {iss: issuer, sub: 'alice', name: 'Alice', exp: Math.floor(Date.now() / 1000) + 3600, jti: 'put-author'},
      'server-persist-author',
    );
    const auth = {[IDENTITY_HEADER]: identity};
    const {id, client: liveClient} = await seed(store, 'snapshot-put-author');
    const staleClient = new Y.Doc();
    Y.applyUpdate(staleClient, Y.encodeStateAsUpdate(liveClient));

    // Advance and checkpoint the live canonical doc so its pending-author map is empty.
    const liveBefore = Y.encodeStateVector(liveClient);
    (liveClient.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'LIVE');
    await postUpdate(app, id, Y.encodeStateAsUpdate(liveClient, liveBefore), liveClient.clientID, auth);
    await waitFor(async () => (await textOf(store, id)).includes('LIVE'));
    expect(persister.size()).toBe(1);

    // Alice's stale snapshot contributes a concurrent operation. The direct PUT stamps
    // Alice, then the canonical-union checkpoint changes the block again by restoring
    // LIVE; that follow-up write must carry Alice's merge attribution instead of wiping it.
    (staleClient.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'PUT');
    const put = await app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1', ...auth},
      body: JSON.stringify({name: 'snapshot-put-author', data: snapshotOf(staleClient)}),
    });
    expect(put.status).toBe(200);
    expect(new Map(((await put.json()) as {data: {authors?: Array<[string, string]>}}).data.authors ?? []).get('a')).toBe(subject);

    await waitFor(async () => {
      const text = await textOf(store, id);
      return text.includes('LIVE') && text.includes('PUT') && (await authorOf(store, id, 'a')) === subject;
    });
    expect(await authorOf(store, id, 'a')).toBe(subject);
    liveClient.destroy();
    staleClient.destroy();
  });

  it('a snapshot PUT waits for an in-flight checkpoint before writing, then merges', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;
    const {id, client} = await seed(store, 'snapshot-put-fence');
    const events: string[] = [];

    // Hold the active session's checkpoint inside saveServerDoc. The PUT must reach
    // quiesce but may not enter upsertPage until this durable write has drained.
    let releaseCheckpoint!: () => void;
    const checkpointHeld = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    let checkpointReached!: () => void;
    const checkpointStarted = new Promise<void>((resolve) => {
      checkpointReached = resolve;
    });
    const realSaveServerDoc = store.saveServerDoc.bind(store);
    vi.spyOn(store, 'saveServerDoc').mockImplementation(async (pageId, blockdoc, authors) => {
      events.push('checkpoint:start');
      checkpointReached();
      await checkpointHeld;
      const page = await realSaveServerDoc(pageId, blockdoc, authors);
      events.push('checkpoint:end');
      return page;
    });

    const clientText = client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const before = Y.encodeStateVector(client);
    clientText.insert(0, 'server');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await checkpointStarted;
    expect(persister.size()).toBe(1); // active canonical session + checkpoint in flight

    // The whole snapshot comes from this same client lineage: it replaces `server`
    // with `CLIENT`, and the fence must merge those Yjs operations into the canonical doc.
    clientText.delete(0, clientText.length);
    clientText.insert(0, 'CLIENT');

    const realQuiesce = persister.quiesce.bind(persister);
    vi.spyOn(persister, 'quiesce').mockImplementation(async (pageId) => {
      events.push('quiesce:start');
      await realQuiesce(pageId);
      events.push('quiesce:end');
    });
    const reseed = vi.spyOn(persister, 'reseed');
    const realUpsertPage = store.upsertPage.bind(store);
    vi.spyOn(store, 'upsertPage').mockImplementation(async (input, author, opts) => {
      events.push('snapshot:write');
      return realUpsertPage(input, author, opts);
    });

    const put = app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-put-fence', data: snapshotOf(client)}),
    });
    await waitFor(async () => events.includes('quiesce:start'));
    expect(events).not.toContain('snapshot:write'); // quiesce is still draining the held checkpoint

    releaseCheckpoint();
    const res = await put;
    expect(res.status).toBe(200);
    expect(events).toEqual([
      'checkpoint:start',
      'quiesce:start',
      'checkpoint:end',
      'quiesce:end',
      'snapshot:write',
    ]);
    expect(reseed).not.toHaveBeenCalled();
    expect(await textOf(store, id)).toBe('CLIENT');
    expect(persister.size()).toBe(1); // merge intent retains the canonical doc
    client.destroy();
  });

  it('releases the merge fence after a failed snapshot PUT without dropping the canonical doc', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;
    const {id, client} = await seed(store, 'snapshot-put-failure');

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'active');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await waitFor(async () => (await textOf(store, id)) === 'active');

    const events: string[] = [];
    const realQuiesce = persister.quiesce.bind(persister);
    vi.spyOn(persister, 'quiesce').mockImplementation(async (pageId) => {
      await realQuiesce(pageId);
      events.push('quiesce');
    });
    const reseed = vi.spyOn(persister, 'reseed');
    vi.spyOn(store, 'upsertPage').mockImplementation(async () => {
      events.push('snapshot:failure');
      throw new Error('injected snapshot write failure');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-put-failure', data: snap('FAIL')}),
    });
    expect(res.status).toBe(500);
    expect(events).toEqual(['quiesce', 'snapshot:failure']);
    expect(reseed).not.toHaveBeenCalled();
    expect(persister.size()).toBe(1);

    // A later live edit checkpoints, proving the failed PUT's freeze was released.
    const clientText = client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const afterFailure = Y.encodeStateVector(client);
    clientText.insert(clientText.length, '-AFTER');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, afterFailure), client.clientID);
    await waitFor(async () => (await textOf(store, id)) === 'active-AFTER');
    client.destroy();
  });

  it('the POST /pages upsert arm uses the same snapshot fence for an existing page', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;
    const {id, client} = await seed(store, 'snapshot-post-fence');

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'active');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await waitFor(async () => (await textOf(store, id)) === 'active');
    const quiesce = vi.spyOn(persister, 'quiesce');
    const reseed = vi.spyOn(persister, 'reseed');

    const clientText = client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    clientText.delete(0, clientText.length);
    clientText.insert(0, 'POST');

    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({id, name: 'snapshot-post-fence', data: snapshotOf(client)}),
    });
    expect(res.status).toBe(201);
    expect(quiesce).toHaveBeenCalledOnce();
    expect(quiesce).toHaveBeenCalledWith(id);
    expect(reseed).not.toHaveBeenCalled();
    expect(await textOf(store, id)).toBe('POST');
    expect(persister.size()).toBe(1);
    client.destroy();
  });

  it('serializes same-page snapshot PUT fences through the first canonical merge', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;
    const {id, client} = await seed(store, 'snapshot-same-page');
    const events: string[] = [];

    const fence = vi.spyOn(persister, 'withSnapshotWriteFence');
    const realQuiesce = persister.quiesce.bind(persister);
    let quiesceCall = 0;
    vi.spyOn(persister, 'quiesce').mockImplementation(async (pageId) => {
      events.push(`quiesce:${++quiesceCall}`);
      await realQuiesce(pageId);
    });

    // Hold the first fence after its DB write but before its canonical merge. The
    // second route has entered withSnapshotWriteFence, yet may not begin quiescing.
    const mergeSeam = persister as unknown as {
      mergeSnapshot(pageId: string, update: Uint8Array | null, subject: string): Promise<void>;
    };
    const realMerge = mergeSeam.mergeSnapshot.bind(persister);
    let releaseMerge!: () => void;
    const mergeHeld = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    let mergeCall = 0;
    vi.spyOn(mergeSeam, 'mergeSnapshot').mockImplementation(async (pageId, update, subject) => {
      const call = ++mergeCall;
      events.push(`merge:${call}:start`);
      if (call === 1) await mergeHeld;
      await realMerge(pageId, update, subject);
      events.push(`merge:${call}:end`);
    });

    const first = app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-same-page', data: snap('FIRST')}),
    });
    await waitFor(async () => events.includes('merge:1:start'));
    const second = app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-same-page', data: snap('SECOND')}),
    });
    await waitFor(async () => fence.mock.calls.length === 2);
    expect(events.filter((event) => event.startsWith('quiesce:'))).toEqual(['quiesce:1']);

    releaseMerge();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(events.indexOf('merge:1:end')).toBeLessThan(events.indexOf('quiesce:2'));
    client.destroy();
  });

  it('does not serialize snapshot PUT fences across different pages', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;
    const firstPage = await seed(store, 'snapshot-page-one');
    const secondPage = await seed(store, 'snapshot-page-two');
    const quiesced: string[] = [];
    const realQuiesce = persister.quiesce.bind(persister);
    vi.spyOn(persister, 'quiesce').mockImplementation(async (pageId) => {
      quiesced.push(pageId);
      await realQuiesce(pageId);
    });

    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWriteReached!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteReached = resolve;
    });
    const realUpsert = store.upsertPage.bind(store);
    vi.spyOn(store, 'upsertPage').mockImplementation(async (input, author, opts) => {
      if (input.id === firstPage.id) {
        firstWriteReached();
        await firstHeld;
      }
      return realUpsert(input, author, opts);
    });

    const first = app.request(`/api/pages/${firstPage.id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-page-one', data: snap('FIRST')}),
    });
    await firstWriteStarted;
    const second = await app.request(`/api/pages/${secondPage.id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-page-two', data: snap('SECOND')}),
    });

    expect(second.status).toBe(200); // completes while page one's fence is still held
    expect(quiesced).toContain(firstPage.id);
    expect(quiesced).toContain(secondPage.id);
    releaseFirst();
    expect((await first).status).toBe(200);
    firstPage.client.destroy();
    secondPage.client.destroy();
  });

  it('persist off: PUT and POST upsert retain the direct path without quiesce/reseed', async () => {
    const quiesce = vi.spyOn(ServerAuthoritativePersister.prototype, 'quiesce');
    const reseed = vi.spyOn(ServerAuthoritativePersister.prototype, 'reseed');
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub());
    const {id, client} = await seed(store, 'snapshot-off');

    const put = await app.request(`/api/pages/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({name: 'snapshot-off', data: snap('OFF-PUT')}),
    });
    const post = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({id, name: 'snapshot-off', data: snap('OFF-POST')}),
    });

    expect(put.status).toBe(200);
    expect(post.status).toBe(201);
    expect(quiesce).not.toHaveBeenCalled();
    expect(reseed).not.toHaveBeenCalled();
    expect(await textOf(store, id)).toBe('OFF-POST');
    client.destroy();
  });

  // PVH-8: a restore writes the old snapshot straight through `upsertPage`, bypassing the
  // /updates stream. When server-persist holds a LIVE canonical doc for that page, the
  // canonical doc must adopt the restored state — otherwise it keeps the pre-restore
  // content (and its next checkpoint would clobber the restore back).
  it('a restore reseeds a page whose canonical doc is LIVE (canonical adopts the restored state)', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;

    // Durable history: create 'RESTORED', then change to 'LIVE' — the change captures the
    // 'RESTORED' state as the (only) version we'll roll back to.
    const created = await store.upsertPage({name: 'restore-reseed', data: snap('RESTORED')});
    const id = created.id;
    await store.upsertPage({id, name: 'restore-reseed', data: snap('LIVE')});
    const versions = await store.listPageVersions(id);
    expect(versions).toHaveLength(1);
    const vid = versions[0].id;

    // Make the canonical doc LIVE: fork a client from the durable 'LIVE' state, type into
    // it, and drive one /updates so the persister seeds + holds the canonical doc.
    const liveBytes = Buffer.from(
      ((await store.getPage(id))!.data as {blockdoc: {update: string}}).blockdoc.update,
      'base64',
    );
    const client = new Y.Doc();
    Y.applyUpdate(client, liveBytes);
    const clientText = client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const before = Y.encodeStateVector(client);
    clientText.insert(clientText.length, '-EDIT');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await waitFor(async () => (await textOf(store, id)).includes('-EDIT'));
    expect(persister.size()).toBe(1); // precondition: a live canonical doc is loaded

    // Restore the 'RESTORED' version through the real route.
    const res = await app.request(`/api/pages/${id}/versions/${vid}/restore`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: '{}',
    });
    expect(res.status).toBe(200);

    // The reseed dropped the stale canonical doc, and the durable snapshot is the restore.
    expect(persister.size()).toBe(0);
    expect(await textOf(store, id)).toBe('RESTORED');

    // Convergence: a fresh /updates forked from the RESTORED state reseeds the canonical
    // doc from the restore (not the stale 'LIVE-EDIT' content) and checkpoints on top of
    // it — so the durable state stays 'RESTORED'-derived, never reverting toward 'LIVE'.
    const restoredBytes = Buffer.from(
      ((await store.getPage(id))!.data as {blockdoc: {update: string}}).blockdoc.update,
      'base64',
    );
    const client2 = new Y.Doc();
    Y.applyUpdate(client2, restoredBytes);
    const client2Text = client2.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const before2 = Y.encodeStateVector(client2);
    client2Text.insert(client2Text.length, '-AGAIN');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client2, before2), client2.clientID);
    await waitFor(async () => (await textOf(store, id)).includes('-AGAIN'));
    expect(await textOf(store, id)).toBe('RESTORED-AGAIN'); // reseeded from the restore, no 'LIVE' clobber

    client.destroy();
    client2.destroy();
  });

  // PVH-8 (review BLOCK): the DOMINANT race the liveness fence alone missed. A checkpoint of
  // PRE-restore content that is armed and IN FLIGHT while the restore runs would — unfenced —
  // capture the pre-restore blockdoc, pass the liveness fence (the canonical doc is still live
  // because the drop hasn't happened yet), and queue its `saveServerDoc` (W2) BEHIND the
  // restore's `upsertPage` (W1) on the single-connection PGlite write mutex, committing LAST
  // and durably clobbering the restore. `quiesce` (called BEFORE the restore write) DRAINS that
  // in-flight checkpoint so it lands FIRST and FREEZES new checkpoints — so the restore write
  // is the LAST durable write for the page. This test forces the interleaving DETERMINISTICALLY:
  // it holds a pre-restore checkpoint write open, then proves the restore's own write is blocked
  // BEHIND it (never races ahead + gets clobbered), and that a late edit during the frozen window
  // can't arm a checkpoint either.
  it('a pre-restore checkpoint IN FLIGHT during a restore does NOT clobber it (quiesce drains + freezes)', async () => {
    const store = await freshStore();
    const app = persistedApp(store);
    const persister = (app as AppWithCollab).collabPersist!;

    // Durable history: RESTORED (the version we roll back to), then LIVE (current content).
    const created = await store.upsertPage({name: 'restore-race', data: snap('RESTORED')});
    const id = created.id;
    await store.upsertPage({id, name: 'restore-race', data: snap('LIVE')});
    const vid = (await store.listPageVersions(id))[0].id;

    // Gate the FIRST server checkpoint write so it is held IN FLIGHT (persistChain pending)
    // when the restore fires — a pre-restore ('LIVE-EDIT') write that, unquiesced, would race
    // the restore write on the mutex. Later checkpoints (post-restore convergence) run ungated.
    let releaseCheckpoint!: () => void;
    const checkpointHeld = new Promise<void>((r) => (releaseCheckpoint = r));
    let reachedCheckpoint!: () => void;
    const checkpointStarted = new Promise<void>((r) => (reachedCheckpoint = r));
    const realSaveServerDoc = store.saveServerDoc.bind(store);
    let gated = false;
    (store as unknown as {saveServerDoc: PageStore['saveServerDoc']}).saveServerDoc = (async (...args) => {
      if (!gated) {
        gated = true;
        reachedCheckpoint();
        await checkpointHeld; // hold the pre-restore checkpoint write open
      }
      return realSaveServerDoc(...(args as Parameters<PageStore['saveServerDoc']>));
    }) as PageStore['saveServerDoc'];

    // Arm the pre-restore checkpoint: fork the durable LIVE doc, type '-EDIT', drive /updates.
    const liveBytes = Buffer.from(((await store.getPage(id))!.data as {blockdoc: {update: string}}).blockdoc.update, 'base64');
    const client = new Y.Doc();
    Y.applyUpdate(client, liveBytes);
    const clientText = client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const origin = Y.encodeStateVector(client);
    clientText.insert(clientText.length, '-EDIT');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, origin), client.clientID);

    // The debounce fires and the pre-restore checkpoint write reaches the store — now held.
    await checkpointStarted;
    expect(persister.size()).toBe(1); // a live canonical doc + its pre-restore write in flight

    // Fire the restore WHILE that pre-restore checkpoint write is in flight. On the fixed path
    // `quiesce` blocks the restore route here DRAINING that write (await persistChain), so the
    // restore's own `upsertPage` cannot run yet.
    const restoreP = app.request(`/api/pages/${id}/versions/${vid}/restore`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: '{}',
    });

    // A late /updates carrying MORE pre-restore-derived content arrives during the frozen
    // quiesce window — `schedule`'s frozen guard must refuse to arm a clobbering checkpoint.
    clientText.insert(clientText.length, '-CLOBBER');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, origin), client.clientID);

    // DETERMINISTIC DISCRIMINATOR: while the pre-restore checkpoint write is still held, the
    // restore's durable write must NOT have landed. On the buggy ordering the restore's
    // `upsertPage` is unquiesced and commits RESTORED immediately (then the held pre-restore
    // write clobbers it on release); on the fixed path the restore write is drained BEHIND the
    // checkpoint and can't land while it's held. Poll for a generous window — RESTORED landing
    // here is the bug.
    const landedWhileHeld = await within(500, async () => (await textOf(store, id)) === 'RESTORED');
    expect(landedWhileHeld).toBe(false); // the restore write waits for the drained checkpoint

    // Release the held pre-restore write: it lands FIRST (drained), THEN the restore's
    // upsertPage commits — the restore is the last durable write, not the checkpoint.
    releaseCheckpoint();
    const res = await restoreP;
    expect(res.status).toBe(200);

    // Invariant: the durable snapshot is the RESTORE, never the pre-restore ('LIVE-EDIT') nor
    // the frozen-blocked ('-CLOBBER') content — no checkpoint write committed after the restore.
    expect(await textOf(store, id)).toBe('RESTORED');

    // Convergence: a fresh /updates forked from RESTORED reseeds the canonical doc from the
    // restore and checkpoints on top — the durable state stays RESTORED-derived.
    const restoredBytes = Buffer.from(((await store.getPage(id))!.data as {blockdoc: {update: string}}).blockdoc.update, 'base64');
    const client2 = new Y.Doc();
    Y.applyUpdate(client2, restoredBytes);
    const client2Text = client2.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text;
    const before2 = Y.encodeStateVector(client2);
    client2Text.insert(client2Text.length, '-AGAIN');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client2, before2), client2.clientID);
    await waitFor(async () => (await textOf(store, id)).includes('-AGAIN'));
    expect(await textOf(store, id)).toBe('RESTORED-AGAIN'); // reseeded from the restore, no clobber

    client.destroy();
    client2.destroy();
  });
});
