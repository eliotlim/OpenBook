import {describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {CollabRelay} from './collab';

/**
 * Collab T1 — the late-joiner catch-up memory. These pin the sync handshake (a
 * client's state vector → exactly the ops it's missing), snapshot seeding, and the
 * memory bounds (LRU + TTL + forget). The relay never persists; losing a doc only
 * costs a re-seed from the durable snapshot.
 */

const baseDoc = (text: string): Uint8Array => {
  const d = new Y.Doc();
  d.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(d);
};

describe('CollabRelay', () => {
  it('seeds a sync from the durable snapshot when no updates were relayed', async () => {
    const relay = new CollabRelay();
    const base = baseDoc('hello');
    const loadBase = async (): Promise<Uint8Array> => base;

    // A brand-new joiner (empty state vector) gets the whole snapshot back.
    const diff = await relay.sync('p1', new Uint8Array(), loadBase);
    expect(diff).not.toBeNull();
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, diff!);
    expect(joiner.getText('t').toString()).toBe('hello');
  });

  it('serves a post-snapshot edit to a late joiner that already has the base', async () => {
    const relay = new CollabRelay();
    const base = baseDoc('hello');
    const loadBase = async (): Promise<Uint8Array> => base;

    // An author edits past the snapshot and relays just the increment.
    const author = new Y.Doc();
    Y.applyUpdate(author, base);
    const beforeSV = Y.encodeStateVector(author);
    author.getText('t').insert(5, ' world');
    const increment = Y.encodeStateAsUpdate(author, beforeSV);
    await relay.ingest('p1', increment, loadBase);

    // A joiner that loaded the snapshot (so it has 'hello') syncs to converge.
    const joiner = new Y.Doc();
    Y.applyUpdate(joiner, base);
    const diff = await relay.sync('p1', Y.encodeStateVector(joiner), loadBase);
    expect(diff).not.toBeNull();
    Y.applyUpdate(joiner, diff!);
    expect(joiner.getText('t').toString()).toBe('hello world');
  });

  it('returns null when the joiner is already up to date', async () => {
    const relay = new CollabRelay();
    const base = baseDoc('hello');
    const loadBase = async (): Promise<Uint8Array> => base;
    await relay.ingest('p1', base, loadBase);

    const upToDate = new Y.Doc();
    Y.applyUpdate(upToDate, base);
    const diff = await relay.sync('p1', Y.encodeStateVector(upToDate), loadBase);
    expect(diff).toBeNull();
  });

  it('dedupes a concurrent seed (ingest racing sync) onto one base load', async () => {
    let loads = 0;
    const base = baseDoc('hi');
    const loadBase = async (): Promise<Uint8Array> => {
      loads += 1;
      return base;
    };
    const relay = new CollabRelay();
    await Promise.all([relay.ingest('p1', baseDoc('hi'), loadBase), relay.sync('p1', new Uint8Array(), loadBase)]);
    expect(loads).toBe(1);
  });

  it('evicts the least-recently-used page past the cap', async () => {
    const relay = new CollabRelay({maxPages: 2});
    const loadBase = async (): Promise<null> => null;
    await relay.sync('a', new Uint8Array(), loadBase);
    await relay.sync('b', new Uint8Array(), loadBase);
    await relay.sync('a', new Uint8Array(), loadBase); // touch 'a' so 'b' is LRU
    await relay.sync('c', new Uint8Array(), loadBase); // over cap → evict 'b'
    expect(relay.size()).toBe(2);
  });

  it('drops a relay doc on forget()', async () => {
    const relay = new CollabRelay();
    await relay.sync('p1', new Uint8Array(), async () => baseDoc('x'));
    expect(relay.size()).toBe(1);
    relay.forget('p1');
    expect(relay.size()).toBe(0);
  });

  it('evicts entries idle past the TTL on the next access', async () => {
    const relay = new CollabRelay({ttlMs: 10});
    const loadBase = async (): Promise<null> => null;
    await relay.sync('a', new Uint8Array(), loadBase);
    await relay.sync('b', new Uint8Array(), loadBase);
    expect(relay.size()).toBe(2);

    await new Promise((r) => setTimeout(r, 30)); // both go idle past the 10ms TTL

    // The next access sweeps the expired entries (lazy, no background timer), so
    // only the freshly-touched page survives.
    await relay.sync('c', new Uint8Array(), loadBase);
    expect(relay.size()).toBe(1);
  });
});
