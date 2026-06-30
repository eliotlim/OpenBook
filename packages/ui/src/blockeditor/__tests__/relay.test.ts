import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';
import {connectPageRelay, isRemoteOrigin} from '../relay';
import {blockText, createDoc, decodeSnapshot, encodeSnapshot, findBlock} from '../model';

/**
 * Collab T2 — the client network provider (`connectPageRelay`). Pins the parts the
 * server can't see: origin discipline (only `'local'` relays; no echo loops), the
 * `clientID` echo-suppression, the late-joiner state-vector handshake, the
 * coalesce + single-in-flight backpressure, and the `'net'` save-skip contract /
 * snapshot backstop (OB-241 non-regression).
 */

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s);
};
const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * An in-memory stand-in for the server relay: holds a per-page server Y.Doc that
 * ingests posts (so {@link syncPageUpdates} can answer a state vector), and fans
 * every post out to ALL subscribers (incl. the author — mirroring the firehose
 * echo). `delayMs` makes posts slow so backpressure is observable.
 */
function fakeRelay(opts: {delayMs?: number} = {}): {
  client: DataClient;
  posts: () => number;
  maxConcurrent: () => number;
  seed: (id: string, update: Uint8Array) => void;
} {
  const subs = new Map<string, Set<(u: string, c: number) => void>>();
  const docs = new Map<string, Y.Doc>();
  const docFor = (id: string): Y.Doc => {
    let d = docs.get(id);
    if (!d) {
      d = new Y.Doc();
      docs.set(id, d);
    }
    return d;
  };
  let posts = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  const client = {
    async postPageUpdate(id: string, update: string, clientId: number): Promise<void> {
      posts += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      Y.applyUpdate(docFor(id), fromB64(update)); // server ingests
      subs.get(id)?.forEach((fn) => fn(update, clientId)); // fan out (incl. author echo)
      inFlight -= 1;
    },
    subscribePageUpdates(id: string, onUpdate: (u: string, c: number) => void): () => void {
      let set = subs.get(id);
      if (!set) {
        set = new Set();
        subs.set(id, set);
      }
      set.add(onUpdate);
      return () => set?.delete(onUpdate);
    },
    syncPageUpdates(id: string, sv: string): Promise<string | null> {
      const diff = Y.encodeStateAsUpdate(docFor(id), sv.length > 0 ? fromB64(sv) : undefined);
      return Promise.resolve(diff.length <= 2 ? null : toB64(diff));
    },
  } as unknown as DataClient;
  return {client, posts: () => posts, maxConcurrent: () => maxConcurrent, seed: (id, u) => Y.applyUpdate(docFor(id), u)};
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const twoLoaded = (): {docA: Y.Doc; docB: Y.Doc; snap: ReturnType<typeof encodeSnapshot>} => {
  const base = createDoc([{id: 'b1', type: 'paragraph', text: ''}]);
  const snap = encodeSnapshot(base);
  return {docA: decodeSnapshot(snap), docB: decodeSnapshot(snap), snap};
};
const textOf = (doc: Y.Doc): string => blockText(findBlock(doc, 'b1')!.block)!.toString();

describe('Collab T2 — connectPageRelay', () => {
  it('propagates a local edit to another doc', async () => {
    const {client} = fakeRelay();
    const {docA, docB} = twoLoaded();
    const a = connectPageRelay(docA, 'p1', client);
    const b = connectPageRelay(docB, 'p1', client);
    await wait(20); // let handshakes settle

    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'Hello'), 'local');
    await wait(120);

    expect(textOf(docB)).toBe('Hello');
    a.disconnect();
    b.disconnect();
  });

  it('coalesces a burst into one POST and never re-relays a remote update (no loop)', async () => {
    const relay = fakeRelay();
    const {docA, docB} = twoLoaded();
    const a = connectPageRelay(docA, 'p1', relay.client);
    const b = connectPageRelay(docB, 'p1', relay.client);
    await wait(20);

    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'a'), 'local');
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(1, 'b'), 'local');
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(2, 'c'), 'local');
    await wait(120);

    expect(textOf(docB)).toBe('abc');
    // docB applied as 'net' (not re-posted), docA's echo suppressed by clientID → 1 post.
    expect(relay.posts()).toBe(1);
    a.disconnect();
    b.disconnect();
  });

  it('keeps at most one POST in flight (backpressure) and coalesces the rest', async () => {
    const relay = fakeRelay({delayMs: 40});
    const {docA} = twoLoaded();
    const a = connectPageRelay(docA, 'p1', relay.client);
    await wait(20);

    // Rapid edits: the first flush starts a (slow) POST; the rest pile into one
    // follow-up POST rather than each firing its own.
    for (let i = 0; i < 8; i += 1) {
      docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(i, 'x'), 'local');
      await wait(15);
    }
    await wait(200);

    expect(relay.maxConcurrent()).toBe(1); // never more than one POST in flight
    expect(relay.posts()).toBeGreaterThan(0);
    expect(relay.posts()).toBeLessThan(8); // coalesced, not one-per-edit
    a.disconnect();
  });

  it('converges concurrent edits from both docs (CRDT union)', async () => {
    const {client} = fakeRelay();
    const {docA, docB} = twoLoaded();
    const a = connectPageRelay(docA, 'p1', client);
    const b = connectPageRelay(docB, 'p1', client);
    await wait(20);

    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'A'), 'local');
    docB.transact(() => blockText(findBlock(docB, 'b1')!.block)!.insert(0, 'B'), 'local');
    await wait(150);

    expect(textOf(docA)).toBe(textOf(docB));
    expect(textOf(docA)).toHaveLength(2);
    a.disconnect();
    b.disconnect();
  });
});

describe('Collab T2 — late-joiner handshake', () => {
  it('converges a client that joins after edits were already relayed', async () => {
    const relay = fakeRelay();
    const {docA, snap} = twoLoaded();

    // An author edits; the relay (server doc) accumulates the change.
    const a = connectPageRelay(docA, 'p1', relay.client);
    await wait(20);
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'mid-session'), 'local');
    await wait(120);

    // A late joiner loads the (stale) snapshot, then connects: the handshake must
    // pull the post-snapshot edit it never received live.
    const joiner = decodeSnapshot(snap);
    expect(textOf(joiner)).toBe(''); // stale: snapshot predates the edit
    const j = connectPageRelay(joiner, 'p1', relay.client);
    await wait(120);

    expect(textOf(joiner)).toBe('mid-session');
    a.disconnect();
    j.disconnect();
  });
});

describe('Collab T2 — origin discipline + snapshot backstop', () => {
  it('isRemoteOrigin flags exactly the non-local origins', () => {
    expect(isRemoteOrigin('net')).toBe(true);
    expect(isRemoteOrigin('server')).toBe(true);
    expect(isRemoteOrigin('bc-remote')).toBe(true);
    expect(isRemoteOrigin('local')).toBe(false);
    expect(isRemoteOrigin(undefined)).toBe(false);
  });

  it('degrades to the snapshot backstop when the relay delivers nothing (tunnel poll-mode)', async () => {
    // A relay whose live frames never arrive and whose sync is empty — the
    // *.book.pub poll-mode degrade. Edits must still converge via the snapshot path.
    const inert = {
      postPageUpdate: () => Promise.resolve(),
      subscribePageUpdates: () => () => undefined, // never fires
      syncPageUpdates: () => Promise.resolve(null),
    } as unknown as DataClient;
    let posts = 0;
    (inert as unknown as {postPageUpdate: DataClient['postPageUpdate']}).postPageUpdate = () => {
      posts += 1;
      return Promise.resolve();
    };
    const {docB, snap} = twoLoaded();
    const conn = connectPageRelay(docB, 'p1', inert);
    await wait(20);

    // The snapshot-merge path (ConnectedPageDocument's `incoming` → applyUpdate
    // 'server') is the durable backstop: build the "saved" state and apply it.
    const saved = decodeSnapshot(snap);
    saved.transact(() => blockText(findBlock(saved, 'b1')!.block)!.insert(0, 'from snapshot'), 'local');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(saved), 'server');
    await wait(80);

    expect(textOf(docB)).toBe('from snapshot');
    // A 'server'-origin update is NOT relayed (origin discipline) — no POST loop.
    expect(posts).toBe(0);
    conn.disconnect();
  });
});
