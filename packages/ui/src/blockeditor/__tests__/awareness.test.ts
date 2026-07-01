import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';
import {AWARENESS_MIN_INTERVAL_MS, blockSelection, connectPageAwareness} from '../awareness';
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
function fakeAwareness(): {client: DataClient} {
  const subs = new Map<string, Set<(u: string, c: number) => void>>();
  const snap = new Map<string, Map<number, string>>();
  const client = {
    postPageAwareness(id: string, update: string, clientId: number): Promise<void> {
      let page = snap.get(id);
      if (!page) {
        page = new Map();
        snap.set(id, page);
      }
      page.set(clientId, update);
      subs.get(id)?.forEach((fn) => fn(update, clientId));
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
      return Promise.resolve([...(snap.get(id)?.values() ?? [])]);
    },
  } as unknown as DataClient;
  return {client};
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
