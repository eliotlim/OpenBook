import * as Y from 'yjs';
import {snapshotBlocks, type PageSnapshot, type StoredPage} from '@book.dev/sdk';
import type {BaseLoader} from './collab';

/**
 * Server-authoritative Yjs persistence (Collab T9) — the optional end-state that
 * removes the last-write-wins window.
 *
 * Today durability is client-driven: an elected client saver (T3) debounce-saves
 * the WHOLE page snapshot, and a stale client's whole-snapshot save can momentarily
 * overwrite newer content (small, backstop-covered). This persister makes the SERVER
 * the persistence authority instead. It keeps a per-page **canonical** {@link Y.Doc}
 * — seeded from the durable snapshot, then fed every write-gated `/updates` — and
 * debounce-persists a snapshot FROM that canonical doc. Because the canonical doc is
 * the CRDT *merge* of every ingested update, a stale client's update merges in (it
 * never overwrites), and the durable end-state always converges to that merge — no
 * edit is permanently lost.
 *
 * **Durability crux — never lose an edit on eviction/shutdown.** The canonical docs
 * are memory-bounded (LRU + idle TTL), but a doc is **checkpointed (persisted)
 * before it is evicted or the process shuts down**, so dropping a doc costs nothing —
 * the next touch reseeds from the just-written snapshot.
 *
 * **Attribution (OB-170) — per ingesting principal, never forged.** Each `/updates`
 * arrives write-gated with a resolved principal; {@link ingest} diffs the top-level
 * blocks it changed (the SAME content hash the durable stamp uses) and records
 * `blockId → verified subject` for exactly those blocks. The debounced persist stamps
 * the snapshot's per-block `authors` from that map ({@link PageStore.saveServerDoc} →
 * `stampSnapshotAuthorsPerBlock`), so every changed block is credited to whoever
 * actually changed it — not "the server", and not one writer for everyone's edits. A
 * guest/unverified change records an empty subject, which honestly *clears* the block's
 * verified author rather than forging one.
 *
 * Persistence flows through the normal store write path ({@link PageStore.saveServerDoc}
 * → `upsertPageTx`), so OB-241's per-block mtimes, the on-disk mirror, the conflict-copy
 * machinery, and the idempotent no-op-skip all apply unchanged. Pure JS (Yjs), so it
 * bundles into the bun-compiled sidecar with no native addon, exactly like the relay.
 *
 * Opt-in (default off): when disabled the persister is never constructed, so behaviour
 * is byte-identical to the shipped T3 client-saver model.
 */

/** The block document persisted inside a page snapshot (mirrors ui `encodeSnapshot`). */
export interface ServerBlockDoc {
  v: 1;
  /** Base64 Y update — the CRDT state clients merge from. */
  update: string;
  /** Plain JSON projection — exports / server / mtimes / authors / non-CRDT readers. */
  blocks: ServerBlockJSON[];
}

/** The JSON projection of one block (mirrors ui `BlockJSON`; kept minimal + local so
 *  the server never needs to depend on the ui package). */
export interface ServerBlockJSON {
  id: string;
  type: string;
  text?: Array<{t: string; a?: Record<string, unknown>}>;
  props?: Record<string, unknown>;
  children?: ServerBlockJSON[];
}

/**
 * Project one Yjs block (a Y.Map) into its JSON form — a faithful port of ui's
 * `blockToJSON`, so a server-persisted `blocks` projection is byte-identical to a
 * client-saved one (the no-op-skip dedupes; mtimes don't spuriously churn).
 *
 * Hardened against an adversarial-but-valid Yjs update (security review): every
 * facet is type-checked before use, and a child that isn't a Y.Map is skipped —
 * so a writer who crafts `text` as a non-Y.Text, `props` as a non-Y.Map, or packs
 * a primitive into `children` can't make the projection THROW. If it threw, `dirty`
 * would never be set again and server-persist would silently stop for that page
 * (a denial-of-durability). At worst such a node is projected in a degraded/absent
 * form; the canonical CRDT `update` (persisted verbatim) still carries it.
 */
function blockToJSON(b: Y.Map<unknown>): ServerBlockJSON {
  const id = b.get('id');
  const type = b.get('type');
  const json: ServerBlockJSON = {
    id: typeof id === 'string' ? id : '',
    type: typeof type === 'string' ? type : 'unknown',
  };
  const text = b.get('text');
  if (text instanceof Y.Text) {
    json.text = (text.toDelta() as Array<{insert: unknown; attributes?: Record<string, unknown>}>)
      .filter((op) => typeof op.insert === 'string')
      .map((op) => ({
        t: op.insert as string,
        ...(op.attributes && Object.keys(op.attributes).length > 0 ? {a: op.attributes} : {}),
      }));
  }
  const props = b.get('props');
  if (props instanceof Y.Map && props.size > 0) json.props = Object.fromEntries(props.entries());
  const children = b.get('children');
  if (children instanceof Y.Array) {
    const out: ServerBlockJSON[] = [];
    for (const child of children) if (child instanceof Y.Map) out.push(blockToJSON(child));
    json.children = out;
  }
  return json;
}

/** The top-level blocks of a canonical doc as JSON (the durable `blockdoc.blocks`).
 *  Non-Y.Map entries (only reachable via a hand-crafted hostile update) are skipped
 *  rather than allowed to throw — see {@link blockToJSON}. */
export function docToBlocksJSON(doc: Y.Doc): ServerBlockJSON[] {
  const out: ServerBlockJSON[] = [];
  for (const node of doc.getArray<unknown>('blocks')) if (node instanceof Y.Map) out.push(blockToJSON(node));
  return out;
}

/** Encode a canonical doc into the persisted block-document snapshot. */
export function encodeServerBlockDoc(doc: Y.Doc): ServerBlockDoc {
  return {
    v: 1,
    update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    blocks: docToBlocksJSON(doc),
  };
}

/** The ORDERED `[blockId, content hash]` digest of a doc's top-level blocks, using the
 *  exact `snapshotBlocks` hash the durable mtime/author stamp diffs against — so the
 *  blocks this persister flags as "changed by principal P" line up 1:1 with the blocks
 *  the store re-attributes on write. Order is preserved (not a Map) so a pure top-level
 *  REORDER — same ids, same hashes, different positions — is still detected as a change
 *  (the hash excludes position, and the client saver persists reorders, so the
 *  server-auth path must too). */
function topLevelDigest(doc: Y.Doc): Array<[string, string]> {
  const blocks = docToBlocksJSON(doc);
  const snap = {editor: 'blocks', blockdoc: {blocks}} as unknown as PageSnapshot;
  return snapshotBlocks(snap).map((d): [string, string] => [d.id, d.hash]);
}

interface PersistDoc {
  doc: Y.Doc;
  /** `true` once seeded from the durable snapshot; a Promise while seeding. */
  seeded: boolean | Promise<void>;
  touched: number;
  /** The canonical doc has changes not yet durably checkpointed. */
  dirty: boolean;
  /** `blockId → verified subject` of the principal that last changed each block since
   *  the last checkpoint (`''` = a guest/unverified change → the block is un-attributed). */
  pendingAuthors: Map<string, string>;
  /** Debounce timer for the next checkpoint (null when idle). */
  timer: ReturnType<typeof setTimeout> | null;
  /** The tail of this page's serialized persist chain (so evict/flush can await it). */
  persistChain: Promise<void>;
  /** Base64 state vector of the last successful checkpoint (the T3-reconciliation
   *  "how far the durable store is" signal a client confirms its edits against). */
  savedSV: string | null;
}

export interface ServerPersistOptions {
  /** Seed a page's canonical doc from its durable snapshot (raw Yjs update bytes). */
  loadBase: BaseLoader;
  /**
   * Durably write the canonical block document with per-block attribution. Returns the
   * updated page, or `null` when the page was deleted mid-session (the persister then
   * stops tracking it — a checkpoint must never resurrect a deleted page). REJECTS on
   * failure so the persister keeps the edits pending + retries.
   */
  saveDoc: (
    pageId: string,
    blockdoc: ServerBlockDoc,
    authorsByBlock: ReadonlyMap<string, string>,
  ) => Promise<StoredPage | null>;
  /** Fan a durably-checkpointed page out (hub publish → live peers + disk mirror). */
  onPersisted?: (page: StoredPage) => void;
  /** Max canonical docs held live at once (checkpoint-then-evict past this). */
  maxPages?: number;
  /** Checkpoint-then-drop a page's canonical doc after this many ms idle. */
  ttlMs?: number;
  /** Debounce window before a dirtied doc is checkpointed (ms). */
  debounceMs?: number;
}

/** A client save contributes CRDT state; a restore intentionally replaces it. Keeping
 *  that distinction explicit at the write fence prevents a stale PUT from being treated
 *  like a destructive restore. */
export type SnapshotWriteIntent =
  | {intent: 'merge'; snapshotUpdate: Uint8Array | null}
  | {intent: 'overwrite'; afterWrite?: () => void | Promise<void>};

export class ServerAuthoritativePersister {
  private readonly docs = new Map<string, PersistDoc>();
  /** Pages currently being overwritten outside the update stream. While a page is here, {@link schedule} and
   *  {@link persistOnce} refuse to arm or run a checkpoint for it — so no checkpoint's
   *  durable write can be *issued* after {@link quiesce} drained the in-flight one, and
   *  the snapshot `upsertPage` is the LAST durable write issued inside the fenced interval
   *  for that page. Set even when the page has no live canonical doc, so an `ingest` that
   *  seeds a fresh doc from the (still pre-write) `pages.data` mid-write also can't
   *  arm a clobbering checkpoint. Each fence owns one count, so an unrelated
   *  {@link forget} (DELETE) cannot clear another writer's freeze mid-write. */
  private readonly frozen = new Map<string, number>();
  /** Per-page tails for external snapshot writes. Two concurrent PUT/upsert/restore
   *  operations must not overlap: each quiesce→write→merge/reseed interval is exclusive
   *  through finalization. Serializing only those rare writes avoids touching ingest or
   *  checkpoint scheduling, while the per-page key leaves different pages independent. */
  private readonly snapshotWriteTails = new Map<string, Promise<void>>();
  private readonly maxPages: number;
  private readonly ttlMs: number;
  private readonly debounceMs: number;
  private closed = false;

  constructor(private readonly opts: ServerPersistOptions) {
    this.maxPages = opts.maxPages ?? 256;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.debounceMs = opts.debounceMs ?? 600;
  }

  /**
   * Fold a write-gated update into the page's canonical doc, attributing the blocks it
   * changes to `subject` (the ingesting principal's verified subject, or `''` for a
   * guest/unverified writer), and schedule a debounced durable checkpoint.
   */
  async ingest(pageId: string, update: Uint8Array, subject: string): Promise<void> {
    if (this.closed) return;
    const entry = await this.ensure(pageId);
    if (!entry) return; // evicted-and-not-rebuilt while seeding (closed) — nothing to do
    const before = topLevelDigest(entry.doc);
    try {
      Y.applyUpdate(entry.doc, update);
    } catch {
      // A malformed update can't corrupt a CRDT doc, but guard the apply anyway.
      return;
    }
    const after = topLevelDigest(entry.doc);
    const beforeById = new Map(before);
    // A pure top-level reorder (same length, same ids IN A DIFFERENT ORDER) changes the
    // document without changing any block's content hash — detect it via the ORDERED
    // id sequence, not just an id→hash map, or the reorder would never be persisted.
    let changed =
      before.length !== after.length || after.some((e, i) => e[0] !== before[i]?.[0]);
    for (const [id, hash] of after) {
      if (beforeById.get(id) !== hash) {
        changed = true;
        // Last writer of a block since the last checkpoint wins its attribution. (A pure
        // reorder changes no block's hash, so it dirties the doc without re-attributing
        // any block — exactly as the client saver's per-block author stamp does.)
        entry.pendingAuthors.set(id, subject);
      }
    }
    if (changed) {
      entry.dirty = true;
      this.schedule(pageId);
    }
  }

  /** Base64 state vector of a page's last durable checkpoint (`null` if never persisted
   *  / not tracked). The reconciliation signal a client confirms its relayed edits
   *  landed against before standing down its own save (Collab T3 handoff). */
  savedStateVector(pageId: string): string | null {
    return this.docs.get(pageId)?.savedSV ?? null;
  }

  /** Drop a page's canonical doc WITHOUT persisting (e.g. it was deleted). Safe if absent.
   *  Deliberately does not clear a snapshot writer's freeze: that writer owns the matching
   *  unfreeze in its `finally`, so DELETE cannot expose a checkpoint mid-fence. */
  forget(pageId: string): void {
    this.drop(pageId);
  }

  /**
   * Quiesce the persister for a page that is about to be overwritten OUT OF BAND — a
   * client whole-snapshot save or version restore (PVH-8) — so that snapshot write cannot
   * race a canonical checkpoint. This is owned by {@link withSnapshotWriteFence}; its
   * intent-specific finalizer merges or reseeds afterward. What it does, in order:
   *
   * 1. **Freeze** the page: while frozen, {@link schedule} won't arm a debounce and
   *    {@link persistOnce} won't run — no *new* checkpoint write can be issued for the page.
   *    The freeze is set even if the page has no live canonical doc, so an `ingest` that
   *    seeds a fresh doc from the (still pre-write) `pages.data` during the snapshot window
   *    also can't arm a clobbering checkpoint.
   * 2. **Cancel** the pending debounce timer, so a queued checkpoint of pre-write content
   *    never fires.
   * 3. **Drain** any in-flight persist for the page (`await persistChain`). A checkpoint
   *    that already passed {@link persistOnce}'s liveness fence and is mid-`saveDoc` thus
   *    COMPLETES here — landing its pre-write checkpoint FIRST, before the snapshot write —
   *    instead of racing behind it on the single-connection PGlite write mutex and
   *    committing last. `persistChain` is always resolved (persist() swallows write errors),
   *    so this never rejects.
   *
   * Together this closes the write-ordering race the pre-write liveness fence alone missed:
   * a debounce firing DURING the snapshot's `upsertPage` transaction would pass the fence
   * (the entry is still live — the drop hasn't run yet), capture the pre-write blockdoc,
   * and queue its `saveDoc` behind the snapshot on the write mutex, committing LAST and
   * durably clobbering it. After `quiesce`, no such checkpoint can be issued or be in
   * flight, and the snapshot `upsertPage` is the final durable write inside the fence.
   */
  async quiesce(pageId: string): Promise<void> {
    this.frozen.set(pageId, (this.frozen.get(pageId) ?? 0) + 1);
    const entry = this.docs.get(pageId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    // Drain a checkpoint already past the liveness fence so its pre-write checkpoint lands
    // BEFORE the snapshot write, not behind it. A persist chained onto the tail during
    // this await is frozen-gated inside persistOnce, so it issues no write.
    await entry.persistChain.catch(() => {});
  }

  /**
   * Run one whole-snapshot write behind the persister's quiesce fence. This is the
   * shared store/persister boundary for every write that replaces `pages.data`
   * without flowing through the canonical `/updates` doc. Intent is explicit:
   *
   * - Client PUT/POST snapshots MERGE their blockdoc update into the live canonical
   *   doc after the durable write, retain that doc, and dirty it so a checkpoint
   *   converges durable state to the CRDT union.
   * - Version restores OVERWRITE: an optional `afterWrite` invalidates adjacent live
   *   state before the canonical doc is dropped/reseeded and the freeze is released.
   *
   * Snapshot writers for the same page are serialized through the entire finalization
   * step, so the next writer cannot quiesce until the first merge/reseed has completed.
   * Different pages have independent tails. The callback may reject; either intent still
   * releases its own freeze, and overwrite intent still runs `afterWrite` then reseeds.
   */
  async withSnapshotWriteFence<T>(
    pageId: string,
    write: () => Promise<T>,
    options: SnapshotWriteIntent,
  ): Promise<T> {
    const previous = this.snapshotWriteTails.get(pageId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => done);
    this.snapshotWriteTails.set(pageId, tail);

    await previous.catch(() => {});
    try {
      await this.quiesce(pageId);
      try {
        const result = await write();
        if (options.intent === 'merge') {
          await this.mergeSnapshot(pageId, options.snapshotUpdate);
        }
        return result;
      } finally {
        if (options.intent === 'overwrite') {
          try {
            await options.afterWrite?.();
          } finally {
            this.reseed(pageId);
          }
        } else {
          this.unfreeze(pageId);
          // `quiesce` cancelled the prior debounce, and updates that arrived while
          // frozen could not schedule one. Re-arm after the canonical merge/failure.
          this.schedule(pageId);
        }
      }
    } finally {
      release();
      if (this.snapshotWriteTails.get(pageId) === tail) this.snapshotWriteTails.delete(pageId);
    }
  }

  /**
   * Adopt an intentional EXTERNAL overwrite of a page — a version restore (PVH-3/8),
   * or another operation with explicit replacement semantics — by
   * dropping the canonical doc so the next client access reseeds it from the freshly
   * written durable snapshot, and clearing the snapshot-write freeze set by {@link quiesce}.
   *
   * For a restore this is called AFTER the restore's `upsertPage` (with {@link quiesce}
   * before it), so the restore write is the last durable write the persister allowed for
   * the page and the dropped doc reseeds from that restored snapshot on next access.
   *
   * Why drop-from-cache (not rebuild-in-place): the canonical doc is by design a disposable
   * cache — "the next touch reseeds from the just-written snapshot" — so dropping it is the
   * simplest thing that guarantees convergence. Rebuilding the Y.Doc in place would mean
   * swapping the doc reference an in-flight `ingest` still holds, or hand-crafting a diff
   * update; dropping sidesteps both and reuses the exact seed path {@link ensure} already
   * takes on a cold page.
   *
   * **Semantics — the restore wins, but connected edits are NOT thrown away.**
   * The restored snapshot becomes the new base. A client that is still connected
   * loses nothing: its edits are CRDT deltas that re-merge on top of that base on its next
   * `/sync` (the server answers that client's state vector from the freshly reseeded doc).
   * For an intentional restore, even edits from a client that has already gone are
   * recoverable because PVH-1 force-captures the pre-restore state as a version first.
   *
   * **No feedback loop.** This is called ONLY from overwrite paths, never from
   * the checkpoint path (which persists via `saveDoc` → `store.saveServerDoc` and never
   * touches this method) — so a checkpoint can't self-invalidate. Paired with {@link quiesce}
   * (which cancels the debounce, freezes new checkpoints, and drains the in-flight one), a
   * checkpoint of pre-write content can neither fire after the snapshot nor race its write.
   */
  reseed(pageId: string): void {
    this.drop(pageId);
    this.unfreeze(pageId);
  }

  /** Checkpoint every dirty canonical doc now (shutdown / periodic flush). Awaits all
   *  writes so a caller can guarantee nothing is lost before the store closes. Any doc a
   *  failed write left un-persisted is LOGGED (never silently stranded) so a broken store
   *  at shutdown is at least visible. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.snapshotWriteTails.values()]);
    await Promise.all([...this.docs.keys()].map((id) => this.checkpoint(id)));
    for (const [id, entry] of this.docs) {
      if (!this.isClean(entry)) {
        console.error(`OpenBook server-persist: page ${id} still has un-checkpointed edits after flush (store write failing?)`);
      }
    }
  }

  /** Checkpoint everything, then destroy every doc + stop. Used on server shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.snapshotWriteTails.values()]);
    await this.flushAll();
    for (const id of [...this.docs.keys()]) this.drop(id);
  }

  /** Pages currently held live (tests / introspection). */
  size(): number {
    return this.docs.size;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async ensure(pageId: string): Promise<PersistDoc | null> {
    // Touch the requested live doc BEFORE the lazy TTL sweep. Besides avoiding needless
    // drop+reload on an active ingest, this is essential inside a snapshot merge fence:
    // the retained canonical union must not be evicted and reseeded from the just-written
    // (possibly stale) durable snapshot while merge finalization is acquiring it.
    const live = this.docs.get(pageId);
    if (live) live.touched = Date.now();
    await this.sweepExpired();
    let entry = this.docs.get(pageId);
    if (!entry) {
      entry = {
        doc: new Y.Doc(),
        seeded: false,
        touched: Date.now(),
        dirty: false,
        pendingAuthors: new Map(),
        timer: null,
        persistChain: Promise.resolve(),
        savedSV: null,
      };
      this.docs.set(pageId, entry);
      await this.evictLruIfNeeded();
    }
    entry.touched = Date.now();
    if (entry.seeded === true) return entry;
    if (entry.seeded === false) {
      const e = entry;
      e.seeded = (async () => {
        const base = await this.opts.loadBase(pageId).catch(() => null);
        if (base) {
          try {
            Y.applyUpdate(e.doc, base);
          } catch {
            // A corrupt stored snapshot shouldn't wedge the persister; start from an
            // empty doc and let live updates + the next checkpoint converge it.
          }
        }
        // Seeding just replayed the durable snapshot into the doc; that is not a NEW
        // edit, so it must not mark the doc dirty (or we'd re-persist the snapshot
        // verbatim on every reseed). The no-op-skip would dedupe it, but skip the work.
        e.seeded = true;
      })();
    }
    await entry.seeded;
    // A flood of other pages could have evicted+destroyed this entry while we seeded.
    if (this.docs.get(pageId) !== entry) {
      if (this.closed) return null;
      return this.ensure(pageId);
    }
    return entry;
  }

  /** Merge a client whole-snapshot's CRDT state into the canonical doc after its direct
   *  DB write. Even a stale update that contributes no new operation dirties the canonical
   *  doc: the DB was just replaced by that stale snapshot, so the next checkpoint must
   *  write the retained union back. Legacy snapshots without an update dirty an already
   *  live canonical doc, but do not manufacture an empty canonical doc on a cold page. */
  private async mergeSnapshot(pageId: string, snapshotUpdate: Uint8Array | null): Promise<void> {
    const hadCanonical = this.docs.has(pageId);
    if (!hadCanonical && !snapshotUpdate) return;
    const entry = await this.ensure(pageId);
    if (!entry) return;
    if (snapshotUpdate) {
      try {
        Y.applyUpdate(entry.doc, snapshotUpdate);
      } catch {
        // The route historically accepts opaque snapshots. If its CRDT update is malformed,
        // retain and re-checkpoint an existing canonical doc; on a cold page, leave the direct
        // snapshot untouched rather than replacing it with a newly-created empty doc.
        if (!hadCanonical) {
          this.drop(pageId);
          return;
        }
      }
    }
    entry.touched = Date.now();
    entry.dirty = true;
  }

  private isFrozen(pageId: string): boolean {
    return (this.frozen.get(pageId) ?? 0) > 0;
  }

  /** Release exactly one fence-owned freeze. A refcount makes `forget()` safe while a
   *  DELETE races a snapshot writer: only the owning fence can release its guard. */
  private unfreeze(pageId: string): void {
    const count = this.frozen.get(pageId) ?? 0;
    if (count <= 1) this.frozen.delete(pageId);
    else this.frozen.set(pageId, count - 1);
  }

  private schedule(pageId: string): void {
    if (this.closed) return;
    // Frozen ⇒ an external snapshot is writing this page; refuse to arm a checkpoint
    // until the intent-specific merge/reseed finalizer releases the fence.
    if (this.isFrozen(pageId)) return;
    const entry = this.docs.get(pageId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.persist(pageId);
    }, this.debounceMs);
    entry.timer.unref?.();
  }

  /** Enqueue a checkpoint of a page's canonical doc, serialized behind any in-flight
   *  checkpoint for that page (so two persists never interleave their atomic capture,
   *  and evict/flush can `await` the tail). The chain is kept RESOLVED after a failure
   *  (so later debounced persists still run) — a failed write already re-dirtied +
   *  re-armed the entry, and every drop decision reads the entry's OWN dirtiness
   *  ({@link isClean}), never this promise's resolution. Returns the tail promise. */
  private persist(pageId: string): Promise<void> {
    const entry = this.docs.get(pageId);
    if (!entry) return Promise.resolve();
    entry.persistChain = entry.persistChain
      .then(() => this.persistOnce(pageId))
      .catch((err) => console.error('OpenBook server-persist checkpoint failed:', err));
    return entry.persistChain;
  }

  private async persistOnce(pageId: string): Promise<void> {
    const entry = this.docs.get(pageId);
    if (!entry || entry.seeded !== true) return;
    // Frozen ⇒ an external snapshot write is in progress for this page. Refuse to write
    // pre-write content: this bails a checkpoint chained after the freeze (e.g. via evict/TTL
    // `checkpoint` that bypasses `schedule`), so no checkpoint's `saveDoc` can be issued
    // after `quiesce` drained the in-flight one and before intent-specific finalization.
    // A checkpoint already in flight when `quiesce` ran passed this guard before the freeze
    // and is awaited by `quiesce`, so it lands FIRST (before the snapshot write), not after.
    if (this.isFrozen(pageId)) return;
    if (!entry.dirty && entry.pendingAuthors.size === 0) return; // nothing new to write
    // ── Atomic capture (synchronous — no await between these lines, so no concurrent
    //    ingest interleaves): the projected block document, its state vector, and the
    //    pending-author map all describe the SAME instant of the canonical doc. Captured
    //    BEFORE `dirty` is cleared, so a (hardened, non-throwing) projection error would
    //    still leave the doc dirty rather than silently clearing it.
    const blockdoc = encodeServerBlockDoc(entry.doc);
    const svB64 = Buffer.from(Y.encodeStateVector(entry.doc)).toString('base64');
    const authors = entry.pendingAuthors;
    entry.pendingAuthors = new Map();
    entry.dirty = false;
    // Fence a checkpoint that a {@link reseed} (external snapshot overwrite) dropped while
    // this persist was debounced: if we're no longer the live doc for this page, writing
    // our now-stale pre-write capture would clobber the external snapshot. That snapshot
    // wins, so bail. Checked AFTER the synchronous capture so no concurrent ingest interleaves.
    if (this.docs.get(pageId) !== entry) return;
    try {
      const page = await this.opts.saveDoc(pageId, blockdoc, authors);
      if (page === null) {
        this.drop(pageId); // deleted mid-session — stop tracking, do not resurrect
        return;
      }
      entry.savedSV = svB64;
      this.opts.onPersisted?.(page);
    } catch (err) {
      // The checkpoint did NOT land. Restore what we captured so a retry covers it,
      // WITHOUT clobbering a newer attribution an ingest set during the write (newer
      // wins), re-arm the debounce, and RETHROW: a swallowed failure would let
      // `checkpoint` look successful and an evict/TTL sweep then drop a still-un-persisted
      // doc — a silently lost edit. The re-dirtied entry is what keeps `isClean` false so
      // the drop is refused.
      for (const [id, subject] of authors) if (!entry.pendingAuthors.has(id)) entry.pendingAuthors.set(id, subject);
      entry.dirty = true;
      this.schedule(pageId); // retry on the debounce
      throw err;
    }
  }

  /** Force a durable checkpoint of a page now (bypass the debounce) and await it. Note it
   *  does NOT by itself guarantee the doc is now clean — a concurrent ingest during the
   *  write, or a write failure, can leave it dirty — so a caller that then drops MUST
   *  re-check {@link isClean} (which evict/TTL/close all do). */
  private async checkpoint(pageId: string): Promise<void> {
    const entry = this.docs.get(pageId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await this.persist(pageId);
  }

  /** A doc is safe to drop only when it holds NOTHING un-persisted: fully seeded, not
   *  dirty, no pending attribution. Anything else — a failed write, or an ingest that
   *  landed during the checkpoint `await` — means dropping it would lose an edit. */
  private isClean(entry: PersistDoc): boolean {
    return entry.seeded === true && !entry.dirty && entry.pendingAuthors.size === 0;
  }

  /** Destroy + forget a page's canonical doc (no checkpoint). */
  private drop(pageId: string): void {
    const entry = this.docs.get(pageId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.doc.destroy();
    this.docs.delete(pageId);
  }

  /** Checkpoint-then-drop entries idle past the TTL (lazy — no background timer). */
  private async sweepExpired(): Promise<void> {
    if (this.ttlMs <= 0) return;
    const cutoff = Date.now() - this.ttlMs;
    const expired = [...this.docs].filter(([, e]) => e.touched < cutoff).map(([id]) => id);
    for (const id of expired) {
      await this.checkpoint(id); // never lose an edit to a TTL sweep
      const entry = this.docs.get(id);
      // Drop ONLY if the checkpoint left it verifiably clean AND it's still idle — a
      // concurrent ingest during the await may have re-touched/re-dirtied it (or the
      // write failed), in which case keep it (it re-checkpoints on its own debounce).
      if (entry && this.isClean(entry) && entry.touched < cutoff) this.drop(id);
    }
  }

  /** Checkpoint-then-evict the least-recently-touched pages when over the cap. */
  private async evictLruIfNeeded(): Promise<void> {
    if (this.docs.size <= this.maxPages) return;
    // Least-recently-touched first. Checkpoint each and drop ONLY the ones the checkpoint
    // left verifiably clean — never a doc still holding un-persisted state (a failed
    // write, or an ingest that landed during the await). If the oldest can't be cleanly
    // dropped we try the next; if none can, we accept a temporary over-cap (a SOFT memory
    // bound) rather than lose an edit. Iterating a fixed snapshot (not `while size > cap`)
    // also can't spin when nothing is droppable.
    const candidates = [...this.docs.entries()].sort((a, b) => a[1].touched - b[1].touched).map(([id]) => id);
    for (const id of candidates) {
      if (this.docs.size <= this.maxPages) break;
      await this.checkpoint(id); // durability crux: persist before we drop it
      const entry = this.docs.get(id);
      if (entry && this.isClean(entry)) this.drop(id);
    }
  }
}
