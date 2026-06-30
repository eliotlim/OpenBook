import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';
import {connectPageRelay} from '../relay';
import {blockText, createDoc, decodeSnapshot, encodeSnapshot, findBlock} from '../model';

/**
 * Collab T0 spike — the UI relay (`connectPageRelay`) converges two real Y.Docs
 * over a minimal in-memory stand-in for the server firehose. This pins the parts
 * the server can't see: origin filtering (only `'local'` is relayed — no loops),
 * echo-to-author suppression by `clientID`, outgoing batch coalescing, and that an
 * applied remote update is NOT re-relayed.
 */

/** A tiny relay hub that fans every post out to ALL subscribers (incl. the author —
 *  mirroring the real firehose echo), counting posts to assert batching/no-loop. */
function fakeRelay(): {client: DataClient; posts(): number} {
  const subs = new Map<string, Set<(u: string, c: number) => void>>();
  let posts = 0;
  const client = {
    postPageUpdate(id: string, update: string, clientId: number): Promise<void> {
      posts += 1;
      subs.get(id)?.forEach((fn) => fn(update, clientId));
      return Promise.resolve();
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
  } as unknown as DataClient;
  return {client, posts: () => posts};
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

/** Two docs loaded from the SAME page snapshot, so they share block structure. */
function twoLoadedDocs(): {docA: Y.Doc; docB: Y.Doc} {
  const base = createDoc([{id: 'b1', type: 'paragraph', text: ''}]);
  const snap = encodeSnapshot(base);
  return {docA: decodeSnapshot(snap), docB: decodeSnapshot(snap)};
}

const textOf = (doc: Y.Doc): string => blockText(findBlock(doc, 'b1')!.block)!.toString();

describe('Collab T0 — connectPageRelay convergence', () => {
  it('propagates a local edit on one doc to the other', async () => {
    const {client} = fakeRelay();
    const {docA, docB} = twoLoadedDocs();
    const a = connectPageRelay(docA, 'p1', client);
    const b = connectPageRelay(docB, 'p1', client);

    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'Hello'), 'local');
    await flush();

    expect(textOf(docB)).toBe('Hello');
    a.disconnect();
    b.disconnect();
  });

  it('coalesces a burst of local edits into a single POST and does not loop', async () => {
    const relay = fakeRelay();
    const {docA, docB} = twoLoadedDocs();
    const a = connectPageRelay(docA, 'p1', relay.client);
    const b = connectPageRelay(docB, 'p1', relay.client);

    // A burst within one flush window → one merged POST.
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'a'), 'local');
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(1, 'b'), 'local');
    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(2, 'c'), 'local');
    await flush();

    expect(textOf(docB)).toBe('abc');
    // docB applied the update with origin 'net' → it must NOT have re-posted, and
    // docA's own echo (clientID match) is suppressed → exactly ONE post total.
    expect(relay.posts()).toBe(1);
    a.disconnect();
    b.disconnect();
  });

  it('converges concurrent edits from both docs (CRDT union)', async () => {
    const {client} = fakeRelay();
    const {docA, docB} = twoLoadedDocs();
    const a = connectPageRelay(docA, 'p1', client);
    const b = connectPageRelay(docB, 'p1', client);

    docA.transact(() => blockText(findBlock(docA, 'b1')!.block)!.insert(0, 'A'), 'local');
    docB.transact(() => blockText(findBlock(docB, 'b1')!.block)!.insert(0, 'B'), 'local');
    await flush();

    // Both ends see the same merged text (order is deterministic per Yjs, but the
    // point is convergence — both docs agree).
    expect(textOf(docA)).toBe(textOf(docB));
    expect(textOf(docA)).toHaveLength(2);
    a.disconnect();
    b.disconnect();
  });
});
