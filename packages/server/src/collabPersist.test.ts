import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import type {PageSnapshot, StoredPage} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {
  ServerAuthoritativePersister,
  docToBlocksJSON,
  encodeServerBlockDoc,
  type ServerBlockDoc,
} from './collabPersist';

/**
 * Collab T9 — server-authoritative Yjs persistence. These pin the durability crux
 * (the server persists the CRDT-MERGED doc, so a stale client can't overwrite; nothing
 * is lost on eviction/shutdown) and the attribution crux (each block is credited to the
 * principal whose ingested update actually changed it, never "the server", never forged).
 * Persistence flows through `PageStore.saveServerDoc` → `upsertPageTx`, so OB-241's
 * mtimes / mirror / no-op-skip all still apply.
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-t9-${process.pid}-${seq}`);
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

// A block-editor doc: `doc.getArray('blocks')` of Y.Map blocks with id/type/text.
function blockDoc(blocks: Array<{id: string; type?: string; text?: string}>): Y.Doc {
  const doc = new Y.Doc();
  const arr = doc.getArray<Y.Map<unknown>>('blocks');
  for (const b of blocks) {
    const m = new Y.Map<unknown>();
    m.set('id', b.id);
    m.set('type', b.type ?? 'paragraph');
    const t = new Y.Text();
    if (b.text) t.insert(0, b.text);
    m.set('text', t);
    arr.push([m]);
  }
  return doc;
}

/** The incremental Yjs update carrying only what changed since `beforeSV`. */
function increment(doc: Y.Doc, beforeSV: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, beforeSV);
}

// Seed a page whose durable snapshot is a block doc — the persister's seed base.
// Page names are globally unique, so each seed gets a fresh name.
let pageSeq = 0;
async function seedBlockPage(store: PageStore, blocks: Array<{id: string; text?: string}>): Promise<string> {
  const doc = blockDoc(blocks);
  const blockdoc = encodeServerBlockDoc(doc);
  pageSeq += 1;
  const page = await store.upsertPage({
    name: `P${pageSeq}`,
    data: {editor: 'blocks', blockdoc} as unknown as PageSnapshot,
  });
  doc.destroy();
  return page.id;
}

const loadBaseFor = (store: PageStore) => async (pageId: string): Promise<Uint8Array | null> => {
  const page = await store.getPage(pageId);
  const update = (page?.data as {blockdoc?: {update?: string}} | undefined)?.blockdoc?.update;
  return typeof update === 'string' && update.length > 0 ? Buffer.from(update, 'base64') : null;
};

function makePersister(
  store: PageStore,
  opts: {
    debounceMs?: number;
    maxPages?: number;
    ttlMs?: number;
    onPersisted?: (p: StoredPage) => void;
    // Override the write to inject failures / timing (defaults to the real store write).
    saveDoc?: (id: string, blockdoc: ServerBlockDoc, authors: ReadonlyMap<string, string>) => Promise<StoredPage | null>;
  } = {},
): ServerAuthoritativePersister {
  return new ServerAuthoritativePersister({
    loadBase: loadBaseFor(store),
    saveDoc: opts.saveDoc ?? ((pageId, blockdoc, authors) => store.saveServerDoc(pageId, blockdoc, authors)),
    onPersisted: opts.onPersisted,
    debounceMs: opts.debounceMs ?? 20,
    maxPages: opts.maxPages,
    ttlMs: opts.ttlMs,
  });
}

const readBlockdoc = (page: StoredPage | null): ServerBlockDoc | undefined =>
  (page?.data as {blockdoc?: ServerBlockDoc} | undefined)?.blockdoc;

const authorsOf = (page: StoredPage | null): Map<string, string> =>
  new Map((page?.data as {authors?: Array<[string, string]>} | undefined)?.authors ?? []);

const blocksOf = async (store: PageStore, id: string): Promise<Array<{id: string; type?: string; text?: unknown}>> =>
  ((await store.getPage(id))?.data as {blockdoc?: {blocks?: Array<{id: string; type?: string; text?: unknown}>}} | undefined)
    ?.blockdoc?.blocks ?? [];

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll a (sync or async) predicate until true — for the debounced/fire-and-forget paths.
async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('docToBlocksJSON / encodeServerBlockDoc', () => {
  it('projects the canonical doc to the durable block-document shape', () => {
    const doc = blockDoc([{id: 'a', text: 'hello'}]);
    const blockdoc = encodeServerBlockDoc(doc);
    expect(blockdoc.v).toBe(1);
    expect(blockdoc.blocks).toEqual([{id: 'a', type: 'paragraph', text: [{t: 'hello'}]}]);
    // The `update` round-trips back to the same projection.
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, Buffer.from(blockdoc.update, 'base64'));
    expect(docToBlocksJSON(rebuilt)).toEqual(blockdoc.blocks);
    doc.destroy();
    rebuilt.destroy();
  });

  it('does NOT throw on an adversarial-but-valid update (skips/coerces bad nodes)', () => {
    // A hostile writer crafts a valid Yjs doc with mistyped nodes. If the projection
    // threw, `dirty` would never be set again and server-persist would silently stop for
    // the page (denial-of-durability). It must skip/degrade instead.
    const doc = new Y.Doc();
    const arr = doc.getArray<unknown>('blocks');
    const good = new Y.Map<unknown>();
    good.set('id', 'a');
    good.set('type', 'paragraph');
    const gt = new Y.Text();
    gt.insert(0, 'ok');
    good.set('text', gt);
    const bad = new Y.Map<unknown>();
    bad.set('id', 'b');
    bad.set('type', 'paragraph');
    bad.set('text', new Y.Map()); // text is not a Y.Text
    bad.set('props', new Y.Text()); // props is not a Y.Map
    bad.set('children', new Y.Text()); // children is not a Y.Array
    arr.push([good, bad, new Y.Text()]); // + a non-Y.Map node directly in `blocks`

    expect(() => docToBlocksJSON(doc)).not.toThrow();
    expect(() => encodeServerBlockDoc(doc)).not.toThrow();
    // The good block projects fully; the mistyped block degrades to id/type only; the
    // non-Map top-level node is skipped entirely.
    expect(docToBlocksJSON(doc)).toEqual([
      {id: 'a', type: 'paragraph', text: [{t: 'ok'}]},
      {id: 'b', type: 'paragraph'},
    ]);
    doc.destroy();
  });
});

describe('ServerAuthoritativePersister', () => {
  it('persists the durable snapshot FROM the canonical doc on a debounce', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: 'hi'}]);
    const persister = makePersister(store);

    // An author types past the seed and relays the increment.
    const author = new Y.Doc();
    Y.applyUpdate(author, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const before = Y.encodeStateVector(author);
    (author.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(2, ' there');
    await persister.ingest(id, increment(author, before), 'iss#alice');

    await tick();
    const blocks = readBlockdoc(await store.getPage(id))!.blocks;
    expect(blocks).toEqual([{id: 'a', type: 'paragraph', text: [{t: 'hi there'}]}]);
    await persister.close();
    author.destroy();
  });

  it('persists the CRDT MERGE of two writers — a stale update never overwrites', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}, {id: 'b', text: ''}]);
    const persister = makePersister(store);
    const seed = Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64');

    // Two clients fork from the same seed and edit DIFFERENT blocks concurrently.
    const alice = new Y.Doc();
    Y.applyUpdate(alice, seed);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, seed);

    const aBefore = Y.encodeStateVector(alice);
    (alice.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'ALICE');
    const bBefore = Y.encodeStateVector(bob);
    (bob.getArray<Y.Map<unknown>>('blocks').get(1).get('text') as Y.Text).insert(0, 'BOB');

    // Bob ingests first, then a "stale" Alice (who never saw Bob's edit) ingests hers.
    await persister.ingest(id, increment(bob, bBefore), 'iss#bob');
    await persister.ingest(id, increment(alice, aBefore), 'iss#alice');
    await tick();

    // The durable doc holds BOTH edits — Alice's stale ingest merged, it did not clobber Bob's.
    const blocks = readBlockdoc(await store.getPage(id))!.blocks;
    expect(blocks).toEqual([
      {id: 'a', type: 'paragraph', text: [{t: 'ALICE'}]},
      {id: 'b', type: 'paragraph', text: [{t: 'BOB'}]},
    ]);
    await persister.close();
    alice.destroy();
    bob.destroy();
  });

  it('attributes each changed block to the ingesting principal (not one writer for all)', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}, {id: 'b', text: ''}]);
    const persister = makePersister(store);
    const seed = Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64');

    const alice = new Y.Doc();
    Y.applyUpdate(alice, seed);
    const bob = new Y.Doc();
    Y.applyUpdate(bob, seed);
    const aBefore = Y.encodeStateVector(alice);
    (alice.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'A');
    const bBefore = Y.encodeStateVector(bob);
    (bob.getArray<Y.Map<unknown>>('blocks').get(1).get('text') as Y.Text).insert(0, 'B');

    await persister.ingest(id, increment(alice, aBefore), 'issuer#alice');
    await persister.ingest(id, increment(bob, bBefore), 'issuer#bob');
    await tick();

    const authors = authorsOf(await store.getPage(id));
    expect(authors.get('a')).toBe('issuer#alice');
    expect(authors.get('b')).toBe('issuer#bob');
    await persister.close();
    alice.destroy();
    bob.destroy();
  });

  it('leaves a guest/unverified edit un-attributed (never forges an author)', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const persister = makePersister(store);
    const seed = Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64');

    const guest = new Y.Doc();
    Y.applyUpdate(guest, seed);
    const before = Y.encodeStateVector(guest);
    (guest.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'g');
    await persister.ingest(id, increment(guest, before), ''); // '' = guest/unverified
    await tick();

    expect(authorsOf(await store.getPage(id)).has('a')).toBe(false);
    await persister.close();
    guest.destroy();
  });

  it('checkpoints a dirty doc BEFORE evicting it (no lost edit on LRU eviction)', async () => {
    const store = await freshStore();
    const id1 = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const id2 = await seedBlockPage(store, [{id: 'a', text: ''}]);
    // A long debounce so the edit is still un-checkpointed when eviction fires.
    const persister = makePersister(store, {debounceMs: 100_000, maxPages: 1});

    const d1 = new Y.Doc();
    Y.applyUpdate(d1, Buffer.from(readBlockdoc(await store.getPage(id1))!.update, 'base64'));
    const before = Y.encodeStateVector(d1);
    (d1.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'kept');
    await persister.ingest(id1, increment(d1, before), 'iss#a');

    // Touching a SECOND page over the cap evicts id1 — which must checkpoint first.
    await persister.ingest(id2, new Uint8Array([0, 0]), 'iss#a');

    const blocks = readBlockdoc(await store.getPage(id1))!.blocks;
    expect(blocks[0].text).toEqual([{t: 'kept'}]);
    expect(persister.size()).toBe(1); // id1 evicted, id2 live
    await persister.close();
    d1.destroy();
  });

  it('checkpoints every dirty doc on shutdown (flushAll / close) — no lost edit', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const persister = makePersister(store, {debounceMs: 100_000}); // never fires on its own

    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const before = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'flushed');
    await persister.ingest(id, increment(d, before), 'iss#a');

    await persister.flushAll(); // shutdown flush before the store closes
    expect(readBlockdoc(await store.getPage(id))!.blocks[0].text).toEqual([{t: 'flushed'}]);
    await persister.close();
    d.destroy();
  });

  it('publishes each checkpoint (drives the OB-241 mirror + live fan-out)', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const published: string[] = [];
    const persister = makePersister(store, {onPersisted: (p) => published.push(p.id)});

    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const before = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'x');
    await persister.ingest(id, increment(d, before), 'iss#a');
    await tick();

    expect(published).toEqual([id]);
    expect(persister.savedStateVector(id)).not.toBeNull();
    await persister.close();
    d.destroy();
  });

  it('stamps OB-241 per-block mtimes on the server-persisted snapshot', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const persister = makePersister(store);
    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const before = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'm');
    await persister.ingest(id, increment(d, before), 'iss#a');
    await tick();

    const data = (await store.getPage(id))!.data as {mtimes?: Array<[string, string]>};
    expect(new Map(data.mtimes ?? []).has('a')).toBe(true);
    await persister.close();
    d.destroy();
  });

  it('does not resurrect a page deleted mid-session', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const persister = makePersister(store);
    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const before = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'z');
    await persister.ingest(id, increment(d, before), 'iss#a');

    await store.deletePage(id); // deleted before the debounce checkpoint fires
    await tick();

    expect(await store.getPage(id)).toBeNull();
    await persister.close();
    d.destroy();
  });

  // ── Quinn's durability holes (must never regress) ────────────────────────────

  it('does NOT drop a dirty doc when the eviction checkpoint WRITE FAILS (retained + retried)', async () => {
    const store = await freshStore();
    const id1 = await seedBlockPage(store, [{id: 'a', text: ''}]);
    const id2 = await seedBlockPage(store, [{id: 'a', text: ''}]);
    let failWrites = true;
    const persister = makePersister(store, {
      debounceMs: 100_000, // never auto-fires; eviction drives the (failing) checkpoint
      maxPages: 1,
      saveDoc: (pid, bd, au) =>
        failWrites ? Promise.reject(new Error('store temporarily down')) : store.saveServerDoc(pid, bd, au),
    });

    const d1 = new Y.Doc();
    Y.applyUpdate(d1, Buffer.from(readBlockdoc(await store.getPage(id1))!.update, 'base64'));
    const before = Y.encodeStateVector(d1);
    (d1.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'kept');
    await persister.ingest(id1, increment(d1, before), 'iss#a');

    // Touch id2 over the cap → eviction of id1 → its checkpoint WRITE FAILS. The old code
    // would drop id1 anyway (silent loss); it must instead be retained for retry.
    await persister.ingest(id2, new Uint8Array([0, 0]), 'iss#a');
    expect(persister.size()).toBe(2); // over-cap accepted rather than lose id1's edit

    // The store recovers; the retained edit checkpoints on the next flush.
    failWrites = false;
    await persister.flushAll();
    expect((await blocksOf(store, id1))[0]?.text).toEqual([{t: 'kept'}]);
    await persister.close();
    d1.destroy();
  });

  it('does NOT lose an ingest that lands DURING the checkpoint write', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: ''}]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const persister = makePersister(store, {
      debounceMs: 20,
      // Hold the FIRST write open so a second ingest can race into the checkpoint window.
      saveDoc: async (pid, bd, au) => {
        if (!held) {
          held = true;
          await gate;
        }
        return store.saveServerDoc(pid, bd, au);
      },
    });

    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const sv0 = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(0, 'A');
    await persister.ingest(id, increment(d, sv0), 'iss#a'); // debounce → persist → saveDoc holds

    await waitFor(() => held); // the first checkpoint write is now in flight
    // Second edit lands WHILE the first write is held (dirty=false was set at capture).
    const sv1 = Y.encodeStateVector(d);
    (d.getArray<Y.Map<unknown>>('blocks').get(0).get('text') as Y.Text).insert(1, 'B');
    await persister.ingest(id, increment(d, sv1), 'iss#a');
    release(); // let the first write complete (it persisted only 'A')

    // The second persist (debounced by edit2) must still land — 'B' is not lost.
    await waitFor(async () => JSON.stringify(await blocksOf(store, id)).includes('AB'));
    expect((await blocksOf(store, id))[0]?.text).toEqual([{t: 'AB'}]);
    await persister.close();
    d.destroy();
  });

  it('persists a pure top-level REORDER (same ids + hashes, different order)', async () => {
    const store = await freshStore();
    const id = await seedBlockPage(store, [{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]);
    const persister = makePersister(store);

    const d = new Y.Doc();
    Y.applyUpdate(d, Buffer.from(readBlockdoc(await store.getPage(id))!.update, 'base64'));
    const arr = d.getArray<Y.Map<unknown>>('blocks');
    const a = arr.get(0);
    const aId = a.get('id') as string;
    const aType = a.get('type') as string;
    const aText = (a.get('text') as Y.Text).toString();
    const before = Y.encodeStateVector(d);
    // Move block `a` to the end (delete + re-insert an identical clone) — a pure reorder:
    // no block's content hash changes, only the top-level order.
    arr.delete(0, 1);
    const clone = new Y.Map<unknown>();
    clone.set('id', aId);
    clone.set('type', aType);
    const t = new Y.Text();
    t.insert(0, aText);
    clone.set('text', t);
    arr.push([clone]);
    await persister.ingest(id, increment(d, before), 'iss#a');

    await waitFor(async () => (await blocksOf(store, id))[0]?.id === 'b');
    expect((await blocksOf(store, id)).map((x) => x.id)).toEqual(['b', 'a']);
    await persister.close();
    d.destroy();
  });
});
