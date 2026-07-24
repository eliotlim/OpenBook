/**
 * Asset garbage-collection, storage budget, and dedup (Assets A6).
 *
 * Builds on the A1 content-addressed store. The safety property under test: the GC
 * decides "unreferenced" by scanning the actual live page **documents** for the
 * asset id (the source of truth — an `image` block's `props.assetId` lands in the
 * blockdoc JSON projection as plain text), NEVER by trusting `asset_refs` alone.
 * `asset_refs` can be stale (a block that moves to another page keeps only the
 * original page's ref), so a GC that trusted it would reap an asset a moved block
 * on a different page still renders. These tests pin:
 *  - dedup (byte-identical uploads collapse to one row / no double-counted bytes);
 *  - the GC reaps a truly-orphaned asset (no live doc references it, past grace);
 *  - the GC KEEPS a referenced asset;
 *  - the GC KEEPS an asset used by a live document even when its `asset_refs` is 0
 *    (the block-move-safe property — the whole point);
 *  - the grace period (a just-uploaded, not-yet-saved asset is never reaped);
 *  - the per-instance storage budget rejects an over-budget upload (507), while a
 *    dedup re-upload of already-stored content is always allowed;
 *  - a soak: many upload/ref/unref/delete-page cycles converge.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore, AssetBudgetError} from './store';
import {PageHub} from './hub';
import {createApp} from './app';

let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-asset-gc-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

/** An empty page document — references no assets. */
const emptySnap = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

/**
 * A page document whose block-editor projection references `assetId` — exactly the
 * shape the editor persists for an `image` block (`props.assetId`). The id lands in
 * `data::text`, which is what the GC's live-document scan reads.
 */
const snapWithAsset = (assetId: string): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
  editor: 'blocks',
  blockdoc: {v: 1, update: '', blocks: [{id: 'img1', type: 'image', props: {assetId}}]},
});

/** Distinct bytes per index so each upload is a distinct content hash. */
const bytesFor = (n: number, len = 8): Uint8Array => {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) b[i] = (n * 31 + i) & 0xff;
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  return b;
};

describe('asset dedup (A1 confirmation)', () => {
  it('byte-identical uploads collapse to one row and count once toward storage', async () => {
    const bytes = bytesFor(1, 100);
    const {id: a} = await store.putAsset(bytes, 'image/png');
    const {id: b} = await store.putAsset(new Uint8Array(bytes), 'image/png');
    expect(b).toBe(a);
    expect(await store.assetStorageBytes()).toBe(100); // NOT 200 — deduped
    const {id: c} = await store.putAsset(bytesFor(2, 100), 'image/png');
    expect(c).not.toBe(a);
    expect(await store.assetStorageBytes()).toBe(200); // two distinct assets now
  });
});

describe('gcUnreferencedAssets — the blockdoc-usage-safe GC', () => {
  it('reaps a truly-orphaned asset (no live document references it) past the grace', async () => {
    const {id} = await store.putAsset(bytesFor(1), 'image/png'); // never ref'd, in no doc
    const {reaped, bytes, ids} = await store.gcUnreferencedAssets({graceMs: 0});
    expect(reaped).toBe(1);
    expect(ids).toEqual([id]);
    expect(bytes).toBeGreaterThan(0);
    expect(await store.getAsset(id)).toBeNull(); // gone
  });

  it('KEEPS an asset a live page document references (ref present + in the doc)', async () => {
    const {id} = await store.putAsset(bytesFor(1), 'image/png');
    const page = await store.upsertPage({name: `p-${seq}`, data: snapWithAsset(id)});
    await store.refAsset(id, page.id);
    const {reaped} = await store.gcUnreferencedAssets({graceMs: 0});
    expect(reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
  });

  it('KEEPS an asset used by a live document even when its asset_refs is 0 (block-move-safe)', async () => {
    // Simulate a block that MOVED: uploaded (ref'd) on page A, then the block moved
    // to page B (whose document now references the asset) while page A dropped its
    // ref. `asset_refs` is now EMPTY, but page B's live document still renders it.
    const {id} = await store.putAsset(bytesFor(1), 'image/png');
    const pageA = await store.upsertPage({name: `a-${seq}`, data: emptySnap()});
    await store.refAsset(id, pageA.id);
    const pageB = await store.upsertPage({name: `b-${seq}`, data: snapWithAsset(id)});
    await store.unrefAsset(id, pageA.id); // the stale-ref hazard: 0 refs remain
    expect(await store.pagesReferencingAsset(id)).toEqual([]); // proven: no refs
    expect(pageB.id).toBeTruthy();

    const {reaped} = await store.gcUnreferencedAssets({graceMs: 0});
    expect(reaped).toBe(0); // a naive ref-only GC would have reaped it → broken image
    expect(await store.getAsset(id)).not.toBeNull();
  });

  it('respects the grace period — a young orphan is kept, an aged one is reaped', async () => {
    const {id} = await store.putAsset(bytesFor(1), 'image/png'); // orphan, just now
    // A generous grace: the asset is younger than the window, so it is kept even
    // though nothing references it (the just-uploaded-not-yet-saved case).
    const young = await store.gcUnreferencedAssets({graceMs: 60 * 60 * 1000});
    expect(young.reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
    // Past the grace, the same orphan is reaped.
    const aged = await store.gcUnreferencedAssets({graceMs: 0});
    expect(aged.reaped).toBe(1);
    expect(await store.getAsset(id)).toBeNull();
  });

  it('a soft-deleted (trashed) page still protects its asset; a hard purge frees it', async () => {
    const {id} = await store.putAsset(bytesFor(1), 'image/png');
    const page = await store.upsertPage({name: `p-${seq}`, data: snapWithAsset(id)});
    await store.refAsset(id, page.id);
    await store.deletePage(page.id); // soft delete → ref survives AND its trashed doc is scanned
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
    await store.purgePage(page.id); // hard purge → FK cascade drops the ref + no page doc
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(1);
    expect(await store.getAsset(id)).toBeNull();
  });

  it('is a no-op when every asset is referenced (nothing reaped)', async () => {
    const a = (await store.putAsset(bytesFor(1), 'image/png')).id;
    const b = (await store.putAsset(bytesFor(2), 'image/png')).id;
    await store.upsertPage({name: `p1-${seq}`, data: snapWithAsset(a)});
    await store.upsertPage({name: `p2-${seq}`, data: snapWithAsset(b)});
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
  });

  it('KEEPS a doc-only (0-ref) asset whose sole holding page is TRASHED, so a restore is not broken', async () => {
    // The data-loss repro (Sasha/Quinn): trash retention (30d) far outlives the GC
    // grace (24h). An asset kept ONLY by a page's document (0 refs — the block-move/
    // copy case the scan exists for) must NOT be reaped while that page is merely
    // trashed, or restoring within retention would surface a permanently broken image.
    const {id} = await store.putAsset(bytesFor(1), 'image/png');
    // Uploaded on page X (ref X); the block then "moves" to page P (P's doc holds the
    // id, no ref); X is hard-purged → the X ref cascades away → 0 refs, kept only by P.
    const x = await store.upsertPage({name: `x-${seq}`, data: emptySnap()});
    await store.refAsset(id, x.id);
    const p = await store.upsertPage({name: `p-${seq}`, data: snapWithAsset(id)});
    await store.deletePage(x.id);
    await store.purgePage(x.id);
    expect(await store.pagesReferencingAsset(id)).toEqual([]); // 0 refs — doc-only now

    // Trash P. Its document still references the asset, so the GC (which scans trashed
    // pages too) must keep it — the OLD `deleted_at IS NULL` scan would have reaped it.
    await store.deletePage(p.id);
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();

    // Restore P within retention → the image is intact (would have 404'd under the bug).
    const restored = await store.restorePage(p.id);
    expect(restored).not.toBeNull();
    expect(await store.getAsset(id)).not.toBeNull();

    // Only once P's document is truly gone (hard purge) is the asset reapable.
    await store.deletePage(p.id);
    await store.purgePage(p.id);
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(1);
    expect(await store.getAsset(id)).toBeNull();
  });

  it('KEEPS an asset referenced only from a page’s properties (forward-compat scan), 0 refs', async () => {
    // Today every producer writes an `image` block into `data`, but `properties`
    // (cover config, future uploadable file-attachment fields) could hold an assetId
    // the day such a feature ships. The scan covers `properties::text` too so that
    // asset isn't silently reaped. Here the id lives ONLY in properties, with 0 refs.
    const {id} = await store.putAsset(bytesFor(1), 'image/png');
    const page = await store.upsertPage({name: `cover-${seq}`, data: emptySnap()});
    await store.setPageProperties(page.id, {cover: {assetId: id}});
    expect(await store.pagesReferencingAsset(id)).toEqual([]); // 0 refs; kept via properties
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
    // Clearing the property (and with no other reference) makes it reapable.
    await store.setPageProperties(page.id, {cover: null});
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(1);
    expect(await store.getAsset(id)).toBeNull();
  });
});

describe('asset storage budget (A6)', () => {
  it('putAsset rejects a NEW asset that would exceed the budget, but allows a dedup re-upload', async () => {
    const first = bytesFor(1, 8);
    await store.putAsset(first, 'image/png', {maxTotalBytes: 10}); // 8 <= 10, ok
    expect(await store.assetStorageBytes()).toBe(8);
    // A second DISTINCT 8-byte asset would total 16 > 10 → rejected.
    await expect(store.putAsset(bytesFor(2, 8), 'image/png', {maxTotalBytes: 10})).rejects.toBeInstanceOf(
      AssetBudgetError,
    );
    expect(await store.assetStorageBytes()).toBe(8); // nothing stored
    // Re-uploading the SAME content is a dedup no-op → allowed even at/over budget.
    const again = await store.putAsset(first, 'image/png', {maxTotalBytes: 10});
    expect(again.id).toBeTruthy();
    expect(await store.assetStorageBytes()).toBe(8);
  });

  it('an unset/zero budget is unlimited (legacy behavior)', async () => {
    for (let i = 0; i < 5; i += 1) await store.putAsset(bytesFor(i, 1000), 'image/png');
    expect(await store.assetStorageBytes()).toBe(5000);
  });

  it('the upload route returns a friendly 507 when the instance budget is exhausted', async () => {
    const app = createApp(store, undefined, new PageHub(), {assetStorageBudgetBytes: 10});
    const page = await store.upsertPage({name: `p-${seq}`, data: emptySnap()});
    const upload = (b: Uint8Array<ArrayBuffer>) =>
      app.request(`/api/assets?pageId=${page.id}`, {method: 'POST', headers: {'Content-Type': 'image/png', 'X-OpenBook-Client': '1'}, body: b});

    const ok = await upload(new Uint8Array(bytesFor(1, 8)));
    expect(ok.status).toBe(201);
    const over = await upload(new Uint8Array(bytesFor(2, 8))); // distinct → over budget
    expect(over.status).toBe(507);
    // A re-upload of the already-stored content still succeeds (dedup adds no bytes).
    const dup = await upload(new Uint8Array(bytesFor(1, 8)));
    expect(dup.status).toBe(201);
  });
});

describe('asset GC soak — many cycles converge', () => {
  it('reaps only truly-orphaned assets; keeps referenced + block-move-safe ones', async () => {
    // A stable anchor page holds one asset for the whole run (must survive every GC).
    const keepId = (await store.putAsset(bytesFor(1, 1000), 'image/png')).id; // 1000 bytes
    const anchor = await store.upsertPage({name: `anchor-${seq}`, data: snapWithAsset(keepId)});
    await store.refAsset(keepId, anchor.id);

    // The block-move-safe asset: ref'd to a page, then moved (ref removed) to the
    // anchor's neighbour whose document references it — 0 refs, but live-doc-used.
    const movedId = (await store.putAsset(bytesFor(2, 2000), 'image/png')).id; // 2000 bytes
    const donor = await store.upsertPage({name: `donor-${seq}`, data: emptySnap()});
    await store.refAsset(movedId, donor.id);
    const receiver = await store.upsertPage({name: `receiver-${seq}`, data: snapWithAsset(movedId)});
    await store.unrefAsset(movedId, donor.id);
    expect(receiver.id).toBeTruthy();

    let expectedOrphansReaped = 0;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      // Upload a fresh asset onto a throwaway page, then orphan it three ways in turn.
      const orphan = (await store.putAsset(bytesFor(cycle + 1, 16), 'image/png')).id;
      const host = await store.upsertPage({name: `host-${seq}-${cycle}`, data: snapWithAsset(orphan)});
      await store.refAsset(orphan, host.id);

      const mode = cycle % 3;
      if (mode === 0) {
        // Delete the whole page (soft + hard purge) → ref cascades, no page doc → orphan.
        await store.deletePage(host.id);
        await store.purgePage(host.id);
      } else if (mode === 1) {
        // Block deleted IN PLACE: rewrite the live page to an EMPTY document + drop the ref.
        await store.upsertPage({id: host.id, name: host.name, data: emptySnap()});
        await store.unrefAsset(orphan, host.id);
      } else {
        // Block REPLACED by a different (kept) image + the ref dropped — the host page
        // stays non-empty but no longer references the orphan (distinct from mode 1).
        await store.upsertPage({id: host.id, name: host.name, data: snapWithAsset(keepId)});
        await store.unrefAsset(orphan, host.id);
      }
      expectedOrphansReaped += 1;

      const gc = await store.gcUnreferencedAssets({graceMs: 0});
      expect(gc.reaped).toBe(1); // exactly this cycle's orphan
      expect(gc.ids).toContain(orphan);
    }

    // Convergence: the anchor + block-move-safe assets survived every sweep; every
    // orphan was reaped exactly once; the storage total reflects only the survivors.
    expect(await store.getAsset(keepId)).not.toBeNull();
    expect(await store.getAsset(movedId)).not.toBeNull();
    expect(await store.pagesReferencingAsset(movedId)).toEqual([]); // still 0 refs, still kept
    expect(expectedOrphansReaped).toBe(12);
    const finalSweep = await store.gcUnreferencedAssets({graceMs: 0});
    expect(finalSweep.reaped).toBe(0); // steady state — nothing left to reap
    // Only the two survivors' bytes remain (1000-byte + 2000-byte assets).
    expect(await store.assetStorageBytes()).toBe(3000);
  });
});
