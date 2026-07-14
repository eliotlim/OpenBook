import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import type {PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp, type AppWithCollab} from './app';
import {encodeServerBlockDoc} from './collabPersist';

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

afterEach(async () => {
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

const postUpdate = (app: ReturnType<typeof createApp>, id: string, update: Uint8Array, clientId: number): Promise<Response> =>
  Promise.resolve(
    app.request(`/api/pages/${id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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

// A block-doc page snapshot with block 'a' carrying `text` (for durable seeding + versions).
const snap = (text: string): PageSnapshot => {
  const d = blockDoc('a', text);
  const s = {editor: 'blocks', blockdoc: encodeServerBlockDoc(d)} as unknown as PageSnapshot;
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

describe('Collab T9 — server-authoritative persistence (opt-in)', () => {
  it('durably persists FROM the server doc on a /updates alone (no client PUT)', async () => {
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub(), {serverPersist: true});
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
    const app = createApp(store, undefined, new PageHub(), {serverPersist: true});
    const {id, client} = await seed(store, 'T9-sync');

    const before = Y.encodeStateVector(client);
    (client.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'x');
    await postUpdate(app, id, Y.encodeStateAsUpdate(client, before), client.clientID);
    await waitFor(async () => (app as AppWithCollab).collabPersist!.savedStateVector(id) != null);

    const res = await app.request(`/api/pages/${id}/sync`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sv: ''}),
    });
    // Flag off ⇒ the /sync response is byte-identical to pre-T9: `savedSv` is omitted
    // entirely (not even a null), so the shape is exactly `{update}`.
    const body = (await res.json()) as Record<string, unknown>;
    expect('savedSv' in body).toBe(false);
    expect(Object.keys(body)).toEqual(['update']);
    client.destroy();
  });

  // PVH-8: a restore writes the old snapshot straight through `upsertPage`, bypassing the
  // /updates stream. When server-persist holds a LIVE canonical doc for that page, the
  // canonical doc must adopt the restored state — otherwise it keeps the pre-restore
  // content (and its next checkpoint would clobber the restore back).
  it('a restore reseeds a page whose canonical doc is LIVE (canonical adopts the restored state)', async () => {
    const store = await freshStore();
    const app = createApp(store, undefined, new PageHub(), {serverPersist: true});
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
      headers: {'Content-Type': 'application/json'},
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
});
