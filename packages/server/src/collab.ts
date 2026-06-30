import * as Y from 'yjs';

/**
 * The live-collaboration relay's catch-up memory (Collab T1).
 *
 * The incremental relay itself ({@link PageHub.publishPageUpdate}) is a dumb,
 * stateless fan-out: it ferries opaque update bytes between connected editors. That
 * alone does NOT let a client joining mid-session converge — it would only see
 * edits made *after* it subscribed, missing anything that flew between the last
 * durable snapshot and the moment it connected (a real gap during sustained typing,
 * when no debounced snapshot save fires).
 *
 * This class closes that gap with the standard Yjs sync handshake, held server-side
 * so it works even when no peer is currently connected:
 *
 *  - per active page it keeps ONE ephemeral {@link Y.Doc}, lazily **seeded from the
 *    durable snapshot** and then fed every relayed update ({@link ingest});
 *  - on a late-joiner handshake ({@link sync}) it answers a client's state vector
 *    with exactly the ops that client is missing (`encodeStateAsUpdate(doc, sv)`).
 *
 * It persists NOTHING — the debounced snapshot `PUT` remains the sole durable
 * checkpoint (OB-164). The relay doc is a disposable cache: bounded by an LRU cap +
 * idle TTL, and reseeded from the snapshot the next time the page goes active. So
 * losing it (eviction, restart) costs nothing but a re-seed. Pure JS (Yjs + lib0),
 * so it bundles cleanly into the bun-compiled sidecar — no native addon.
 */

/** Loads the durable snapshot's base64 Yjs update for a page (or `null`). */
export type BaseLoader = (pageId: string) => Promise<Uint8Array | null>;

interface RelayDoc {
  doc: Y.Doc;
  /** `true` once seeded; a Promise while a concurrent seed is in flight. */
  seeded: boolean | Promise<void>;
  touched: number;
}

export interface CollabRelayOptions {
  /** Max pages held live at once (LRU-evicted past this). */
  maxPages?: number;
  /** Drop a page's relay doc after this many ms with no ingest/sync. */
  ttlMs?: number;
}

export class CollabRelay {
  private readonly docs = new Map<string, RelayDoc>();
  private readonly maxPages: number;
  private readonly ttlMs: number;

  constructor(opts: CollabRelayOptions = {}) {
    this.maxPages = opts.maxPages ?? 256;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  /** Fold a relayed update into the page's relay doc so a later sync reflects it. */
  async ingest(pageId: string, update: Uint8Array, loadBase: BaseLoader): Promise<void> {
    const doc = await this.ensure(pageId, loadBase);
    try {
      Y.applyUpdate(doc, update);
    } catch {
      // A malformed update can't corrupt a CRDT doc, but guard the apply anyway.
    }
  }

  /**
   * Answer a late joiner's state vector with the ops it's missing. An empty state
   * vector (a brand-new doc) yields the full state. Returns `null` when there is
   * nothing to send (an empty relay doc — the joiner already has the snapshot).
   */
  async sync(pageId: string, clientStateVector: Uint8Array, loadBase: BaseLoader): Promise<Uint8Array | null> {
    const doc = await this.ensure(pageId, loadBase);
    let diff: Uint8Array;
    try {
      diff = Y.encodeStateAsUpdate(doc, clientStateVector.length > 0 ? clientStateVector : undefined);
    } catch {
      // A malformed / truncated / hostile `sv` (it doesn't decode as a Yjs state
      // vector) would otherwise throw and 500. Fall back to the full state — the
      // client converges either way — matching the leniency `ingest` already shows.
      diff = Y.encodeStateAsUpdate(doc);
    }
    // The empty-doc update is a 2-byte no-op header; skip it so the client doesn't
    // apply a meaningless update (and so the API can answer `null`).
    return diff.length <= 2 ? null : diff;
  }

  /** Drop a page's relay doc (e.g. on delete). Safe if absent. */
  forget(pageId: string): void {
    this.docs.get(pageId)?.doc.destroy();
    this.docs.delete(pageId);
  }

  /** Pages currently held live (for tests / introspection). */
  size(): number {
    return this.docs.size;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async ensure(pageId: string, loadBase: BaseLoader): Promise<Y.Doc> {
    this.sweepExpired();
    let entry = this.docs.get(pageId);
    if (!entry) {
      entry = {doc: new Y.Doc(), seeded: false, touched: Date.now()};
      this.docs.set(pageId, entry);
      this.evictLruIfNeeded();
    }
    entry.touched = Date.now();
    if (entry.seeded === true) return entry.doc;
    // Dedupe a concurrent seed (ingest racing sync) onto one base load.
    if (entry.seeded === false) {
      const e = entry;
      e.seeded = (async () => {
        const base = await loadBase(pageId).catch(() => null);
        if (base) {
          try {
            Y.applyUpdate(e.doc, base);
          } catch {
            // A corrupt stored snapshot shouldn't wedge the relay; serve an empty
            // doc and let live updates + the next snapshot converge it.
          }
        }
        e.seeded = true;
      })();
    }
    await entry.seeded;
    // While we awaited the seed, a flood of other pages could have LRU-evicted
    // (and destroyed) this entry. Using a destroyed doc would be wrong, so if it's
    // no longer the live entry, rebuild — bounded by the same cap, so this can't
    // loop without sustained eviction pressure.
    if (this.docs.get(pageId) !== entry) return this.ensure(pageId, loadBase);
    return entry.doc;
  }

  /** Drop entries idle past the TTL (lazy — no background timer to leak in tests). */
  private sweepExpired(): void {
    if (this.ttlMs <= 0) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, entry] of this.docs) {
      if (entry.touched < cutoff) {
        entry.doc.destroy();
        this.docs.delete(id);
      }
    }
  }

  /** Evict the least-recently-touched page when over the cap. */
  private evictLruIfNeeded(): void {
    while (this.docs.size > this.maxPages) {
      let oldestId: string | null = null;
      let oldest = Infinity;
      for (const [id, entry] of this.docs) {
        if (entry.touched < oldest) {
          oldest = entry.touched;
          oldestId = id;
        }
      }
      if (oldestId == null) break;
      this.docs.get(oldestId)?.doc.destroy();
      this.docs.delete(oldestId);
    }
  }
}
