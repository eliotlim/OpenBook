import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import {Awareness, applyAwarenessUpdate, encodeAwarenessUpdate} from 'y-protocols/awareness';
import type {DataClient} from '@book.dev/sdk';
import {AWARENESS_MIN_INTERVAL_MS, awarenessUpdateClients, blockSelection, connectPageAwareness} from '../awareness';
import {createDoc, decodeSnapshot, encodeSnapshot} from '../model';

/**
 * Collab T4 — the client presence provider (`connectPageAwareness`). Pins the parts
 * the server can't see: two clients round-trip identity + selection over the
 * transport, a peer is cleaned up on disconnect (no ghost cursor), and the live
 * awareness instance T5 reads is exposed/updated. Uses distinct BroadcastChannel
 * names per connection so the test exercises the NETWORK path, not the same-tab BC.
 */

/** An in-memory stand-in for the server awareness relay: stores the latest update
 *  per client (the late-joiner snapshot) and fans every post out to all subscribers
 *  (incl. the author echo). It does NOT re-stamp identity — that's the real server's
 *  job, covered by the server suite; here the provider's self-set identity flows. */
function fakeAwareness(): {
  client: DataClient;
  posts: (clientId: number) => number;
  syncCalls: () => number;
  setDelivery: (on: boolean) => void;
  /** Drop a client from the stored snapshot without notifying subscribers — the server
   *  GC'ing a departed peer's presence while a client is disconnected. */
  dropFromSnapshot: (id: string, clientId: number) => void;
  reconnect: () => void;
  } {
  const subs = new Map<string, Set<(u: string, c: number) => void>>();
  const snap = new Map<string, Map<number, string>>();
  const reconnectListeners = new Set<() => void>();
  const postCounts = new Map<number, number>();
  let syncCalls = 0;
  let delivering = true;
  const client = {
    postPageAwareness(id: string, update: string, clientId: number): Promise<void> {
      postCounts.set(clientId, (postCounts.get(clientId) ?? 0) + 1);
      let page = snap.get(id);
      if (!page) {
        page = new Map();
        snap.set(id, page);
      }
      page.set(clientId, update);
      if (delivering) subs.get(id)?.forEach((fn) => fn(update, clientId));
      return Promise.resolve();
    },
    subscribePageAwareness(id: string, onUpdate: (u: string, c: number) => void): () => void {
      let set = subs.get(id);
      if (!set) {
        set = new Set();
        subs.set(id, set);
      }
      set.add(onUpdate);
      return () => set?.delete(onUpdate);
    },
    syncPageAwareness(id: string): Promise<string[]> {
      syncCalls += 1;
      return Promise.resolve([...(snap.get(id)?.values() ?? [])]);
    },
    subscribeReconnect(onReconnect: () => void): () => void {
      reconnectListeners.add(onReconnect);
      return () => reconnectListeners.delete(onReconnect);
    },
  } as unknown as DataClient;
  return {
    client,
    posts: (clientId) => postCounts.get(clientId) ?? 0,
    syncCalls: () => syncCalls,
    setDelivery: (on) => {
      delivering = on;
    },
    dropFromSnapshot: (id, clientId) => {
      snap.get(id)?.delete(clientId);
    },
    reconnect: () => reconnectListeners.forEach((fn) => fn()),
  };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Two docs sharing one CRDT history (as the relay converges them), so a relative
 *  position created in one resolves in the other. */
function twoLoaded(text = 'hello'): {docA: Y.Doc; docB: Y.Doc} {
  const snap = encodeSnapshot(createDoc([{id: 'b1', type: 'paragraph', text}]));
  return {docA: decodeSnapshot(snap), docB: decodeSnapshot(snap)};
}

describe('Collab T4 — connectPageAwareness', () => {
  it('round-trips identity + selection between two clients', async () => {
    const {client} = fakeAwareness();
    const {docA, docB} = twoLoaded('hello');

    const a = connectPageAwareness(docA, 'p1', client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    const b = connectPageAwareness(docB, 'p1', client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(100); // initial announces + coalesced flush

    // B's awareness shows A as a present peer with A's identity.
    const aInB = b.awareness.getStates().get(docA.clientID);
    expect((aInB?.user as {name: string} | undefined)?.name).toBe('Ada');

    // A moves its caret into block b1 at offset 2 → B sees the selection.
    a.setSelection(blockSelection(docA, 'b1', 2));
    await wait(100);
    const sel = b.awareness.getStates().get(docA.clientID)?.selection as {blockId: string} | undefined;
    expect(sel?.blockId).toBe('b1');
    // And it round-trips back as a real Y position T5 can resolve to an absolute index.
    const head = (b.awareness.getStates().get(docA.clientID)?.selection as {anchor: unknown})?.anchor;
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), docB);
    expect(abs?.index).toBe(2);

    a.disconnect();
    b.disconnect();
  });

  it('cleans a peer up on disconnect (no ghost cursor)', async () => {
    const {client} = fakeAwareness();
    const {docA, docB} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    const b = connectPageAwareness(docB, 'p1', client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true);

    a.disconnect(); // announces departure
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(false); // gone, not a ghost

    b.disconnect();
  });

  it('gives a late joiner the current presence snapshot at once', async () => {
    const {client} = fakeAwareness();
    const {docA, docB} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    await wait(80);

    // A joiner connecting later sees Ada immediately via the snapshot (no wait for refresh).
    const b = connectPageAwareness(docB, 'p1', client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(80);
    expect((b.awareness.getStates().get(docA.clientID)?.user as {name: string} | undefined)?.name).toBe('Ada');

    a.disconnect();
    b.disconnect();
  });

  it('rate-caps sustained presence POSTs to ~10Hz on a fast (zero-latency) transport (Collab T8)', async () => {
    // Record the wall-clock time of each network POST. The fake client resolves
    // instantly, so WITHOUT the rate ceiling the one-in-flight guard would let the
    // 50ms coalesce window fire at ~20Hz on this zero-latency transport — exactly the
    // sustained cursor-motion firehose T8 hardens against (fan-out is O(editors²)).
    const posts: number[] = [];
    const client = {
      postPageAwareness(): Promise<void> {
        posts.push(Date.now());
        return Promise.resolve();
      },
      subscribePageAwareness(): () => void {
        return () => undefined;
      },
      syncPageAwareness(): Promise<string[]> {
        return Promise.resolve([]);
      },
    } as unknown as DataClient;

    const doc = decodeSnapshot(encodeSnapshot(createDoc([{id: 'b1', type: 'paragraph', text: 'hello world'}])));
    const a = connectPageAwareness(doc, 'p1', client, {name: 'Ada', id: 'ada'}, {channelName: 'solo'});

    // Drive sustained cursor motion (~400ms of a fresh selection every 10ms).
    const end = Date.now() + 400;
    let offset = 0;
    while (Date.now() < end) {
      a.setSelection(blockSelection(doc, 'b1', offset % 11));
      offset += 1;
      await wait(10);
    }
    await wait(AWARENESS_MIN_INTERVAL_MS + 40); // let the final coalesced batch flush

    a.disconnect(); // sends a terminal departure POST immediately (bypasses the cap)

    // Drop the departure POST before measuring the sustained cadence.
    const sustained = posts.slice(0, -1);
    expect(sustained.length).toBeGreaterThan(1); // it does still send presence
    // Every consecutive pair of POST starts is spaced by the rate floor (minus a small
    // scheduler/measurement skew). Without the ceiling these gaps would be ~50ms.
    for (let i = 1; i < sustained.length; i += 1) {
      expect(sustained[i] - sustained[i - 1]).toBeGreaterThanOrEqual(AWARENESS_MIN_INTERVAL_MS - 25);
    }
  });
});

describe('Collab T7 — reconnect re-announce + reconcile', () => {
  it('re-announces local presence on reconnect so peers see the returning client', async () => {
    const fake = fakeAwareness();
    const {docA, docB} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', fake.client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    const b = connectPageAwareness(docB, 'p1', fake.client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(80);
    const before = fake.posts(docA.clientID);

    fake.reconnect();
    await wait(80);
    // A re-POSTs its own presence on reopen (so peers/server re-register it after the drop).
    expect(fake.posts(docA.clientID)).toBeGreaterThan(before);

    a.disconnect();
    b.disconnect();
  });

  it('prunes a peer that departed while we were disconnected (authoritative snapshot)', async () => {
    const fake = fakeAwareness();
    const {docA, docB} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', fake.client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    const b = connectPageAwareness(docB, 'p1', fake.client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true);

    // B's stream drops; A leaves for good and the server GC's it — but B, being offline,
    // never sees A's departure frame.
    fake.setDelivery(false);
    a.disconnect(); // A's departure POST isn't delivered to the offline B
    fake.dropFromSnapshot('p1', docA.clientID); // server drops the departed peer's presence
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true); // stale/ghost — B missed it

    // B reopens → the reconcile treats the snapshot as authoritative and prunes the gone A.
    fake.setDelivery(true);
    fake.reconnect();
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(false); // pruned — no ghost cursor

    b.disconnect();
  });

  it('keeps a still-present peer through a reconnect (does not over-prune)', async () => {
    const fake = fakeAwareness();
    const {docA, docB} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', fake.client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    const b = connectPageAwareness(docB, 'p1', fake.client, {name: 'Boris', id: 'boris'}, {channelName: 'tab-b'});
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true);

    // A is still present in the snapshot; a reconnect must not prune it.
    fake.reconnect();
    await wait(80);
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true);

    a.disconnect();
    b.disconnect();
  });

  it('coalesces a flapping reconnect into at most one follow-up snapshot fetch (no storm)', async () => {
    const fake = fakeAwareness();
    const {docA} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', fake.client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    await wait(80);
    const before = fake.syncCalls();

    for (let i = 0; i < 6; i += 1) fake.reconnect(); // a burst of (already-debounced) signals
    await wait(80);
    // The in-flight guard collapses them — not one snapshot fetch per signal.
    expect(fake.syncCalls() - before).toBeLessThanOrEqual(2);

    a.disconnect();
  });

  it('does not re-announce after disconnect (unsubscribed from the reconnect signal)', async () => {
    const fake = fakeAwareness();
    const {docA} = twoLoaded('');
    const a = connectPageAwareness(docA, 'p1', fake.client, {name: 'Ada', id: 'ada'}, {channelName: 'tab-a'});
    await wait(80);
    a.disconnect();
    const after = fake.syncCalls();

    fake.reconnect(); // a late signal after teardown must be ignored
    await wait(40);
    expect(fake.syncCalls()).toBe(after);
  });
});

describe('Collab T7 — awarenessUpdateClients', () => {
  it('reads the client ids straight off a real awareness update (single, large id)', () => {
    const doc = new Y.Doc();
    doc.clientID = 4000000000; // near the 32-bit ceiling — exercises the multi-byte varint
    const aw = new Awareness(doc);
    aw.setLocalStateField('user', {name: 'x'});
    expect(awarenessUpdateClients(encodeAwarenessUpdate(aw, [doc.clientID]))).toEqual([doc.clientID]);
    aw.destroy();
  });

  it('reads every client id from a multi-client update (skips clock + state correctly)', () => {
    const docA = new Y.Doc();
    docA.clientID = 7;
    const docB = new Y.Doc();
    docB.clientID = 987654321;
    const a = new Awareness(docA);
    a.setLocalStateField('user', {name: 'A'});
    const b = new Awareness(docB);
    b.setLocalStateField('user', {name: 'a-much-longer-name-to-vary-the-state-length'});
    // Merge B's state into A so a single update can encode both clients.
    applyAwarenessUpdate(a, encodeAwarenessUpdate(b, [docB.clientID]), 'test');
    const both = encodeAwarenessUpdate(a, [docA.clientID, docB.clientID]);
    expect(new Set(awarenessUpdateClients(both))).toEqual(new Set([docA.clientID, docB.clientID]));
    a.destroy();
    b.destroy();
  });
});
