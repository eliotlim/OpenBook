import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {HttpDataClient, localPrincipal, type FetchLike, type LiveSourceLike, type PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {streamGates} from './access';

/**
 * Collab T1 — the live relay + late-joiner sync, end-to-end through the real Hono
 * app (route → gate → hub/relay → SSE framing → client dispatch). The relay carries
 * opaque bytes, so the transport tests use arbitrary blobs; the late-joiner test
 * uses real Yjs to prove a mid-session client converges to the CURRENT doc.
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-relay-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return store;
}

async function freshApp(): Promise<{app: ReturnType<typeof createApp>; store: PageStore}> {
  const store = await freshStore();
  // No identity provider ⇒ legacy single-user: a full-access guest, so the relay's
  // write/read gates pass once the page exists.
  return {app: createApp(store, undefined, new PageHub()), store};
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

type App = ReturnType<typeof createApp>;
const appFetch = (app: App): FetchLike => (input, init) => Promise.resolve(app.request(input, init));

/** A LiveSourceLike that reads the app's real `/api/live` SSE body, firing handlers
 *  by event name — a faithful stand-in for the browser EventSource. */
function appLiveSource(app: App): (url: string) => LiveSourceLike {
  return (url) => {
    const handlers = new Map<string, Array<(e: {data?: string}) => void>>();
    const fire = (type: string, data?: string): void => {
      for (const h of handlers.get(type) ?? []) h({data});
    };
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    void (async () => {
      const res = await app.request(url);
      fire('open');
      if (!res.body) return;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let event = 'message';
      let data = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done || cancelled) break;
        buf += decoder.decode(value, {stream: true});
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
          else if (line === '') {
            if (data.length > 0 || event !== 'message') fire(event, data);
            event = 'message';
            data = '';
          }
        }
      }
    })();
    return {
      addEventListener(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      close() {
        cancelled = true;
        void reader?.cancel().catch(() => undefined);
      },
    };
  };
}

const makeClient = (app: App): HttpDataClient =>
  new HttpDataClient('', undefined, {fetchImpl: appFetch(app), createLiveSource: appLiveSource(app)});

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const emptySnap = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

describe('Collab T1 — live relay', () => {
  it('relays an opaque update to a peer and echoes to the author (clientId discriminates)', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const peer = makeClient(app);
    const page = await author.savePage({name: 'Shared', data: emptySnap()});

    const peerSeen: Array<{update: string; clientId: number}> = [];
    const authorSeen: Array<{update: string; clientId: number}> = [];
    peer.subscribePageUpdates(page.id, (update, clientId) => peerSeen.push({update, clientId}));
    author.subscribePageUpdates(page.id, (update, clientId) => authorSeen.push({update, clientId}));
    await new Promise((r) => setTimeout(r, 100));

    const payload = Buffer.from('opaque-update').toString('base64');
    await author.postPageUpdate(page.id, payload, 4242);
    await waitFor(() => peerSeen.length >= 1 && authorSeen.length >= 1);

    expect(peerSeen).toEqual([{update: payload, clientId: 4242}]);
    expect(authorSeen).toEqual([{update: payload, clientId: 4242}]); // suppression is the clientId match
  });

  it('preserves order across a burst', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const peer = makeClient(app);
    const page = await author.savePage({name: 'Burst', data: emptySnap()});
    const seen: string[] = [];
    peer.subscribePageUpdates(page.id, (u) => seen.push(u));
    await new Promise((r) => setTimeout(r, 100));

    const payloads = ['one', 'two', 'three'].map((s) => Buffer.from(s).toString('base64'));
    for (const p of payloads) await author.postPageUpdate(page.id, p, 1);
    await waitFor(() => seen.length >= payloads.length);
    expect(seen).toEqual(payloads);
  });

  it('rejects a malformed body (400) and hides a missing page (404)', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'Bad', data: emptySnap()});

    const bad = await app.request(`/api/pages/${page.id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({clientId: 1}),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request(`/api/pages/${randomUUID()}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({update: Buffer.from('x').toString('base64'), clientId: 1}),
    });
    expect(missing.status).toBe(404);
  });
});

describe('Collab T1 — late-joiner sync', () => {
  it('converges a client that joins mid-session to the current doc (state-vector handshake)', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);

    // The durable snapshot the page is saved with (the relay seeds from this).
    const base = new Y.Doc();
    base.getText('t').insert(0, 'hello');
    const baseUpdate = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64');
    const page = await author.savePage({
      name: 'Live',
      data: {...emptySnap(), editor: 'blocks', blockdoc: {v: 1, update: baseUpdate, blocks: []}} as PageSnapshot,
    });

    // The author edits PAST the snapshot and relays just the increment — exactly
    // the gap a late joiner would miss without the handshake.
    const authorDoc = new Y.Doc();
    Y.applyUpdate(authorDoc, Y.encodeStateAsUpdate(base));
    const beforeSV = Y.encodeStateVector(authorDoc);
    authorDoc.getText('t').insert(5, ' world');
    const increment = Buffer.from(Y.encodeStateAsUpdate(authorDoc, beforeSV)).toString('base64');
    await author.postPageUpdate(page.id, increment, authorDoc.clientID);
    await new Promise((r) => setTimeout(r, 50)); // let the best-effort relay.ingest land

    // A fresh joiner loads the snapshot, then syncs its state vector.
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, Y.encodeStateAsUpdate(base)); // == loading page.data.blockdoc
    const client = makeClient(app);
    const diffB64 = await client.syncPageUpdates(page.id, Buffer.from(Y.encodeStateVector(joiner)).toString('base64'));
    expect(diffB64).not.toBeNull();
    Y.applyUpdate(joiner, Buffer.from(diffB64!, 'base64'));

    expect(joiner.getText('t').toString()).toBe('hello world');
  });

  it('syncs the snapshot itself to a brand-new joiner when nothing was relayed', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const base = new Y.Doc();
    base.getText('t').insert(0, 'seeded');
    const baseUpdate = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64');
    const page = await author.savePage({
      name: 'Seed',
      data: {...emptySnap(), editor: 'blocks', blockdoc: {v: 1, update: baseUpdate, blocks: []}} as PageSnapshot,
    });

    const client = makeClient(app);
    const diffB64 = await client.syncPageUpdates(page.id, ''); // empty SV → whole doc
    expect(diffB64).not.toBeNull();
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, Buffer.from(diffB64!, 'base64'));
    expect(joiner.getText('t').toString()).toBe('seeded');
  });
});

describe('Collab T1 — live read-gate cache', () => {
  it('caches canListPage per page and re-evaluates only when the access epoch bumps', async () => {
    const store = await freshStore();
    const page = await store.upsertPage({name: 'Gated', data: emptySnap()}, localPrincipal());

    // Count real authorization calls under the gate's cache.
    let calls = 0;
    const realCanList = store.canListPage.bind(store);
    (store as unknown as {canListPage: PageStore['canListPage']}).canListPage = ((p, id, b) => {
      calls += 1;
      return realCanList(p, id, b);
    }) as PageStore['canListPage'];

    const gates = streamGates(store, localPrincipal());
    const frame = {type: 'yupdate', pageId: page.id, update: 'x', clientId: 1} as const;

    await gates.live(frame);
    await gates.live(frame);
    expect(calls).toBe(1); // second frame served from the per-connection cache

    // A visibility change bumps the store's access epoch → cache invalidated.
    await store.setPageVisibility(page.id, 'public');
    await gates.live(frame);
    expect(calls).toBe(2); // re-authorized after the bump
  });
});

describe('Collab T1 — safety invariants (the ones the epic rests on)', () => {
  it('performs ZERO store writes across a relay burst + sync (OB-241: the relay is not the system of record)', async () => {
    const {app, store} = await freshApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'NoWrite', data: emptySnap()});

    // Spy AFTER the page is created, so we count only what the relay does. Note:
    // the conflictNested (OB-241) suite does NOT exercise the relay — THIS is what
    // proves the live relay never touches the durable store.
    let writes = 0;
    const realUpsert = store.upsertPage.bind(store);
    (store as unknown as {upsertPage: PageStore['upsertPage']}).upsertPage = ((input, principal) => {
      writes += 1;
      return realUpsert(input, principal);
    }) as PageStore['upsertPage'];

    for (let i = 0; i < 10; i += 1) {
      await author.postPageUpdate(page.id, Buffer.from(`u${i}`).toString('base64'), 1);
    }
    await author.syncPageUpdates(page.id, '');
    await new Promise((r) => setTimeout(r, 50)); // let the best-effort ingests settle

    expect(writes).toBe(0); // relay never persists — the snapshot PUT is the sole writer
  });

  it('413s an over-cap update body (relay-doc inflation guard)', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'Big', data: emptySnap()});

    const huge = 'A'.repeat(1024 * 1024 + 1024); // > 1 MiB cap
    const res = await app.request(`/api/pages/${page.id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({update: huge, clientId: 1}),
    });
    expect(res.status).toBe(413);
  });

  it('treats a malformed sync state vector as empty rather than 500ing', async () => {
    const {app} = await freshApp();
    const author = makeClient(app);
    const base = new Y.Doc();
    base.getText('t').insert(0, 'safe');
    const baseUpdate = Buffer.from(Y.encodeStateAsUpdate(base)).toString('base64');
    const page = await author.savePage({
      name: 'BadSV',
      data: {...emptySnap(), editor: 'blocks', blockdoc: {v: 1, update: baseUpdate, blocks: []}} as PageSnapshot,
    });

    // A garbage base64 "state vector" must not throw → 500; it falls back to full state.
    const res = await app.request(`/api/pages/${page.id}/sync`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({sv: Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f]).toString('base64')}),
    });
    expect(res.status).toBe(200);
    const {update} = (await res.json()) as {update: string | null};
    expect(update).not.toBeNull();
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, Buffer.from(update!, 'base64'));
    expect(joiner.getText('t').toString()).toBe('safe'); // got the full state back
  });
});
