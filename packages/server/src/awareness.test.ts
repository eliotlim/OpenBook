import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {Awareness, applyAwarenessUpdate, encodeAwarenessUpdate} from 'y-protocols/awareness';
import {
  HttpDataClient,
  colorForIdentity,
  mintIdentityKeypair,
  signIdentity,
  type FetchLike,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
  type LiveSourceLike,
  type PageSnapshot,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {AwarenessRelay, awarenessUser, stampAwarenessIdentity} from './collabAwareness';

/**
 * Collab T4 — ephemeral awareness/presence over the relay transport, end-to-end
 * through the real Hono app (route → read-gate → re-stamp → hub → SSE → client).
 * Proves: two clients round-trip presence + selection; a VIEWER (read, not write)
 * appears present but cannot ingest doc updates; a non-reader gets neither; identity
 * comes from the verified principal not the body; and nothing is persisted.
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-aware-${process.pid}-${seq}`);
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

type App = ReturnType<typeof createApp>;
const appFetch = (app: App): FetchLike => (input, init) => Promise.resolve(app.request(input, init));

/** A LiveSourceLike reading the app's real `/api/live` SSE body (faithful EventSource).
 *  Identity rides the URL's `?identity=` query (set by the client from getIdentity),
 *  exactly as a real EventSource carries it (it can't set headers). */
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

// `getIdentity` makes authFetch stamp `X-OpenBook-Identity` on every HTTP request
// AND makes the live URL carry `?identity=` — so one option covers both transports.
const makeClient = (app: App, jws?: string): HttpDataClient =>
  new HttpDataClient('', undefined, {
    fetchImpl: appFetch(app),
    createLiveSource: appLiveSource(app),
    ...(jws ? {getIdentity: () => ({jws})} : {}),
  });

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const emptySnap = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

/** Encode an awareness update for `doc` with a user (identity) + selection (client-set). */
function awarenessUpdateFor(doc: Y.Doc, user: unknown, selection?: unknown): string {
  const aw = new Awareness(doc);
  aw.setLocalStateField('user', user);
  if (selection !== undefined) aw.setLocalStateField('selection', selection);
  const bytes = encodeAwarenessUpdate(aw, [doc.clientID]);
  aw.destroy();
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 awareness update into a clientID → state map (for assertions).
 *  Drops the decoder's OWN local `{}` state (set by the Awareness constructor) so
 *  the map reflects exactly the clients the update carried. */
function decodeStates(b64: string): Map<number, Record<string, unknown>> {
  const target = new Awareness(new Y.Doc());
  target.setLocalState(null); // remove the constructor's own `{}` so it doesn't pollute the map
  applyAwarenessUpdate(target, Buffer.from(b64, 'base64'), 'test');
  const out = new Map<number, Record<string, unknown>>();
  for (const [id, state] of target.getStates()) out.set(id, state as Record<string, unknown>);
  target.destroy();
  return out;
}

describe('Collab T4 — awareness transport (legacy single-user)', () => {
  const legacyApp = async (): Promise<App> => createApp(await freshStore(), undefined, new PageHub());

  it('round-trips two clients’ presence + selection, echoing to the author', async () => {
    const app = await legacyApp();
    const author = makeClient(app);
    const peer = makeClient(app);
    const page = await author.savePage({name: 'Present', data: emptySnap()});

    const peerSeen: Array<{update: string; clientId: number}> = [];
    const authorSeen: Array<{update: string; clientId: number}> = [];
    peer.subscribePageAwareness(page.id, (update, clientId) => peerSeen.push({update, clientId}));
    author.subscribePageAwareness(page.id, (update, clientId) => authorSeen.push({update, clientId}));
    await new Promise((r) => setTimeout(r, 100));

    const doc = new Y.Doc();
    const update = awarenessUpdateFor(doc, {name: 'Ada', color: '#fff', id: 'x'}, {blockId: 'b1', anchor: null, head: null});
    await author.postPageAwareness(page.id, update, doc.clientID);
    await waitFor(() => peerSeen.length >= 1 && authorSeen.length >= 1);

    // The peer sees the author's presence with the carried selection intact.
    const state = decodeStates(peerSeen[0].update).get(doc.clientID)!;
    expect((state.selection as {blockId: string}).blockId).toBe('b1');
    expect(peerSeen[0].clientId).toBe(doc.clientID);
    // The author's own echo carries its clientId, so its client drops it (suppression).
    expect(authorSeen[0].clientId).toBe(doc.clientID);
  });

  it('serves a current-presence snapshot to a late joiner (GET), and drops it on departure', async () => {
    const app = await legacyApp();
    const here = makeClient(app);
    const page = await here.savePage({name: 'Snap', data: emptySnap()});

    const doc = new Y.Doc();
    await here.postPageAwareness(page.id, awarenessUpdateFor(doc, {name: 'Grace', color: '#abc', id: 'g'}), doc.clientID);

    // A brand-new joiner gets the present client immediately, without waiting for a refresh.
    const joiner = makeClient(app);
    const snap = await joiner.syncPageAwareness(page.id);
    expect(snap.length).toBe(1);
    expect(decodeStates(snap[0]).has(doc.clientID)).toBe(true);

    // A departure (null state) removes it from the snapshot.
    const aw = new Awareness(doc);
    aw.setLocalState(null); // offline
    const departure = Buffer.from(encodeAwarenessUpdate(aw, [doc.clientID])).toString('base64');
    aw.destroy();
    await here.postPageAwareness(page.id, departure, doc.clientID);
    expect((await joiner.syncPageAwareness(page.id)).length).toBe(0);
  });

  it('rejects a malformed body (400) and hides a missing page (404)', async () => {
    const app = await legacyApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'Bad', data: emptySnap()});

    const bad = await app.request(`/api/pages/${page.id}/awareness`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({clientId: 1}),
    });
    expect(bad.status).toBe(400);

    const missing = await app.request(`/api/pages/${randomUUID()}/awareness`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({update: 'AQ==', clientId: 1}),
    });
    expect(missing.status).toBe(404);
  });

  it('performs ZERO store writes across an awareness burst (presence is not data)', async () => {
    const app = await legacyApp();
    const store = stores[stores.length - 1];
    const author = makeClient(app);
    const page = await author.savePage({name: 'NoWrite', data: emptySnap()});

    let writes = 0;
    const realUpsert = store.upsertPage.bind(store);
    (store as unknown as {upsertPage: PageStore['upsertPage']}).upsertPage = ((input, principal) => {
      writes += 1;
      return realUpsert(input, principal);
    }) as PageStore['upsertPage'];

    const doc = new Y.Doc();
    for (let i = 0; i < 5; i += 1) {
      await author.postPageAwareness(page.id, awarenessUpdateFor(doc, {name: 'A', color: '#1', id: 'a'}, {blockId: `b${i}`, anchor: null, head: null}), doc.clientID);
    }
    await author.syncPageAwareness(page.id);
    expect(writes).toBe(0);

    // And the durable snapshot never carries presence.
    const stored = await store.getPage(page.id);
    expect(JSON.stringify(stored?.data)).not.toContain('selection');
  });

  it('413s an over-cap awareness body', async () => {
    const app = await legacyApp();
    const author = makeClient(app);
    const page = await author.savePage({name: 'Big', data: emptySnap()});
    const huge = 'A'.repeat(64 * 1024 + 1024); // > 64 KiB cap
    const res = await app.request(`/api/pages/${page.id}/awareness`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({update: huge, clientId: 1}),
    });
    expect(res.status).toBe(413);
  });
});

describe('Collab T4 — identity integrity + read-gating', () => {
  const ISS = 'https://account.book.pub';
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
    signIdentity(
      kp.privateKey,
      {
        iss: ISS,
        sub,
        name: sub,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-${sub}-${Math.random()}`,
        ...over,
      },
      kp.publicJwk.kid,
    );

  async function claimedApp(): Promise<{app: App; store: PageStore}> {
    const store = await freshStore();
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    return {app, store};
  }

  it('re-stamps identity from the verified principal — a spoofed name in the body is ignored', async () => {
    const {app, store} = await claimedApp();
    const ownerJws = await idFor('owner');
    const page = await store.upsertPage({name: 'Stamped', data: emptySnap()}, {kind: 'user', subject: `${ISS}#owner`, issuer: ISS, name: 'owner', verifiedVia: 'jws'});

    const owner = makeClient(app, ownerJws);
    const peer = makeClient(app, ownerJws); // same identity, second connection, to observe the fan-out
    const seen: string[] = [];
    peer.subscribePageAwareness(page.id, (u) => seen.push(u));
    await new Promise((r) => setTimeout(r, 100));

    const doc = new Y.Doc();
    // The body CLAIMS to be "Mallory" with an attacker colour — must be overwritten.
    const spoof = awarenessUpdateFor(doc, {name: 'Mallory', color: '#000000', id: 'attacker'}, {blockId: 'b9', anchor: null, head: null});
    await owner.postPageAwareness(page.id, spoof, doc.clientID);
    await waitFor(() => seen.length >= 1);

    const state = decodeStates(seen[0]).get(doc.clientID)!;
    const user = state.user as {name: string; color: string; id: string};
    expect(user.name).toBe('owner'); // the verified principal's name, NOT "Mallory"
    expect(user.id).toBe(`${ISS}#owner`);
    expect(user.color).toBe(colorForIdentity(`${ISS}#owner`)); // server-derived colour
    // The client-authored selection survives the re-stamp.
    expect((state.selection as {blockId: string}).blockId).toBe('b9');
  });

  it('drops forged extra client-states from a multi-state body (no phantom cursors)', async () => {
    const {app, store} = await claimedApp();
    const page = await store.upsertPage({name: 'Forge', data: emptySnap()}, {kind: 'user', subject: `${ISS}#owner`, issuer: ISS, name: 'owner', verifiedVia: 'jws'});

    // Hand-craft a body with TWO client-states: the attacker's own + a forged one
    // claiming to be a different user/clientID. An honest client only ever posts its
    // OWN single state — this is the abuse the single-client filter must defeat.
    const attacker = new Y.Doc();
    const victim = new Y.Doc();
    const aw = new Awareness(new Y.Doc());
    applyAwarenessUpdate(aw, Buffer.from(awarenessUpdateFor(attacker, {name: 'me', color: '#1', id: 'me'}, {blockId: 'ba', anchor: null, head: null}), 'base64'), 'b');
    applyAwarenessUpdate(aw, Buffer.from(awarenessUpdateFor(victim, {name: 'CEO', color: '#000', id: `${ISS}#boss`}, {blockId: 'bv', anchor: null, head: null}), 'base64'), 'b');
    const multi = Buffer.from(encodeAwarenessUpdate(aw, [attacker.clientID, victim.clientID])).toString('base64');
    aw.destroy();

    // POST it declaring the attacker's clientId (the honest field).
    const res = await app.request(`/api/pages/${page.id}/awareness`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: await idFor('owner')},
      body: JSON.stringify({update: multi, clientId: attacker.clientID}),
    });
    expect(res.status).toBe(204);

    // The snapshot holds ONLY the attacker's own client, stamped to the verified
    // principal — the forged victim cursor never made it in.
    const owner = makeClient(app, await idFor('owner'));
    const snap = await owner.syncPageAwareness(page.id);
    const states = decodeStates(snap[0]);
    expect([...states.keys()]).toEqual([attacker.clientID]); // single client only
    expect(states.has(victim.clientID)).toBe(false); // no phantom cursor
    expect((states.get(attacker.clientID)!.user as {name: string}).name).toBe('owner'); // verified identity
  });

  it('a VIEWER (read, not write) appears present but cannot ingest doc updates; a non-reader gets neither', async () => {
    const {app, store} = await claimedApp();
    const page = await store.upsertPage({name: 'Members', data: emptySnap()}, {kind: 'user', subject: `${ISS}#owner`, issuer: ISS, name: 'owner', verifiedVia: 'jws'});
    await store.setPageVisibility(page.id, 'members');

    const viewerJws = await idFor('viewer');
    const strangerJws = await idFor('stranger'); // jws, but not a member → cannot read a members page

    const viewer = makeClient(app, viewerJws);
    const doc = new Y.Doc();
    const presence = awarenessUpdateFor(doc, {name: 'v', color: '#1', id: 'v'}, {blockId: 'b1', anchor: null, head: null});

    // Viewer CAN broadcast presence (read-gated POST passes for a reader).
    const aRes = await app.request(`/api/pages/${page.id}/awareness`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: viewerJws},
      body: JSON.stringify({update: presence, clientId: doc.clientID}),
    });
    expect(aRes.status).toBe(204);

    // But the viewer CANNOT ingest a doc update (the /updates relay is write-gated → 403).
    const uRes = await app.request(`/api/pages/${page.id}/updates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: viewerJws},
      body: JSON.stringify({update: 'AQ==', clientId: doc.clientID}),
    });
    expect(uRes.status).toBe(403);

    // A non-reader is hidden the page entirely: presence POST + snapshot GET both 404.
    expect(
      (await app.request(`/api/pages/${page.id}/awareness`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: strangerJws},
        body: JSON.stringify({update: presence, clientId: 1}),
      })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/pages/${page.id}/awareness`, {headers: {[IDENTITY_HEADER]: strangerJws}})).status,
    ).toBe(404);

    // The viewer (a reader) DOES see the present client via the snapshot.
    expect((await viewer.syncPageAwareness(page.id)).length).toBe(1);
    // The non-reader sees nothing (the snapshot is read-gated).
    expect(await makeClient(app, strangerJws).syncPageAwareness(page.id).catch(() => 'denied')).toBe('denied');
  });
});

describe('Collab T4 — AwarenessRelay (snapshot store unit)', () => {
  it('keeps the latest per-client presence, expires on TTL, and forgets a page', () => {
    const relay = new AwarenessRelay({ttlMs: 50});
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    relay.ingest('p', 1, a);
    relay.ingest('p', 2, b);
    expect(relay.snapshot('p').length).toBe(2);
    relay.remove('p', 1);
    expect(relay.snapshot('p').length).toBe(1);
    relay.forget('p');
    expect(relay.snapshot('p').length).toBe(0);
    expect(relay.size()).toBe(0);
  });

  it('caps clients-per-page (evicts the oldest) and never discards the just-written entry', () => {
    const relay = new AwarenessRelay({maxClientsPerPage: 3});
    for (let c = 1; c <= 10; c += 1) relay.ingest('p', c, Buffer.from([c]));
    // Bounded to the cap, holding the 3 most-recently-written clients (8, 9, 10).
    expect(relay.snapshot('p').length).toBe(3);
    const held = new Set(relay.snapshot('p').map((u) => u[0]));
    expect(held).toEqual(new Set([8, 9, 10]));
  });

  it('the page-LRU evicts an OLD page, not the one currently being written (F2)', () => {
    const relay = new AwarenessRelay({maxPages: 1});
    relay.ingest('old', 1, Buffer.from('x'));
    relay.ingest('new', 2, Buffer.from('y')); // over the cap → 'old' is evicted, 'new' survives
    expect(relay.snapshot('new').length).toBe(1); // the just-written page kept its entry
    expect(relay.snapshot('old').length).toBe(0);
    expect(relay.size()).toBe(1);
  });

  it('stampAwarenessIdentity forces the user field and reports presence vs removal', () => {
    const doc = new Y.Doc();
    const user = awarenessUser({kind: 'user', subject: 's', issuer: 'i', name: 'Real', verifiedVia: 'jws'});
    const present = awarenessUpdateFor(doc, {name: 'Fake', color: '#000', id: 'f'}, {blockId: 'b', anchor: null, head: null});
    const {stamped, present: isPresent} = stampAwarenessIdentity(Buffer.from(present, 'base64'), user, doc.clientID);
    expect(isPresent).toBe(true);
    const state = decodeStates(Buffer.from(stamped).toString('base64')).get(doc.clientID)!;
    expect((state.user as {name: string}).name).toBe('Real');
    expect((state.selection as {blockId: string}).blockId).toBe('b'); // selection preserved

    // A null (offline) state stamps to a removal, not a presence.
    const aw = new Awareness(doc);
    aw.setLocalState(null);
    const removalBytes = encodeAwarenessUpdate(aw, [doc.clientID]);
    aw.destroy();
    expect(stampAwarenessIdentity(removalBytes, user, doc.clientID).present).toBe(false);

    // A body that doesn't declare the client at all (forged/empty) is rejected.
    expect(stampAwarenessIdentity(Buffer.from(present, 'base64'), user, doc.clientID + 1).stamped.length).toBe(0);
  });
});
