import * as Y from 'yjs';
import {Awareness, applyAwarenessUpdate, encodeAwarenessUpdate} from 'y-protocols/awareness';
import type {Principal} from '@book.dev/sdk';
import {colorForIdentity, principalId} from '@book.dev/sdk';

/**
 * Ephemeral awareness/presence relay (Collab T4) — the server side of live
 * "who's here / where's their cursor".
 *
 * It is the awareness analogue of {@link CollabRelay}, with two jobs:
 *
 *  1. **Re-stamp identity from the verified principal, single-client.**
 *     A `y-protocols/awareness` update is a tiny JSON-per-client blob the editor
 *     controls, so the name/colour in it is spoofable AND a hostile reader could
 *     pack many client-states into one body to spawn phantom cursors.
 *     {@link stampAwarenessIdentity} keeps ONLY the single declared client's state
 *     (an honest client posts exactly `encodeAwarenessUpdate(aw, [doc.clientID])`)
 *     and forces its `user` to the server-resolved {@link Principal} — so a peer
 *     can announce any *selection* but never a *different identity*, and never a
 *     cursor for a client it doesn't own (mirrors the relay's edit-log identity
 *     stamping).
 *
 *  2. **Hold a per-page presence snapshot for late joiners.** Awareness re-announces
 *     itself every ~15s, so without help a fresh joiner waits that long to see who's
 *     already here. This keeps the latest stamped update per present client (keyed
 *     by the editor's Yjs clientID), expiring them at the awareness TTL, so a joiner
 *     can fetch the current presence immediately.
 *
 * Like the relay it persists **NOTHING** — never a store write, never in the durable
 * snapshot, never in the edit log (presence is not data, and OpenBook collects no
 * telemetry). Pure JS (yjs + lib0 via y-protocols), so it bundles into the
 * bun-compiled sidecar with no native addon, exactly as {@link CollabRelay} does.
 */

/** The awareness `user` facet the server controls (identity, not selection). */
export interface AwarenessUser {
  /** Display name from the verified principal (falls back to a generic label). */
  name: string;
  /** Stable presence colour derived from the principal's subject. */
  color: string;
  /** The principal id (subject) — a stable, non-spoofable peer key for the UI. */
  id: string;
}

/** The identity facet to stamp for a principal (display name + stable colour). */
export function awarenessUser(principal: Principal): AwarenessUser {
  const name = principal.name.trim() || (principal.kind === 'guest' ? 'Guest' : 'Member');
  return {name, color: colorForIdentity(principalId(principal)), id: principalId(principal)};
}

/**
 * Re-encode an awareness update down to ONLY the single declared client, with its
 * `user` identity forced to `user` (the verified principal's) and everything else
 * (its `selection`/cursor) preserved. Decodes through a throwaway {@link Awareness}
 * so any *other* client-states a hostile body packed in are simply never re-emitted
 * (no phantom cursors), and the identity can't be spoofed. A `null` state (the
 * client going offline) re-encodes as a departure so it still propagates.
 *
 * Returns the stamped bytes plus `present` — whether a non-null (still-here) state
 * survived — so the caller tells an arrival/update from a removal without decoding
 * again. Returns empty bytes (`present:false`) when the declared client isn't in the
 * body at all (a forged/empty update) or it's malformed — the route 400s on that.
 */
export function stampAwarenessIdentity(
  update: Uint8Array,
  user: AwarenessUser,
  declaredClientId: number,
): {stamped: Uint8Array; present: boolean} {
  const doc = new Y.Doc();
  const aw = new Awareness(doc);
  try {
    applyAwarenessUpdate(aw, update, 'ingest'); // populates aw.states + aw.meta from the body
    // `meta` carries the declared client iff the body actually referenced it (even a
    // departure, which deletes the state but keeps the clock). No meta ⇒ the client
    // wasn't in the body (forged / empty) ⇒ reject.
    if (!aw.meta.has(declaredClientId)) return {stamped: new Uint8Array(), present: false};
    const state = aw.states.get(declaredClientId);
    const present = state != null && typeof state === 'object';
    // Force identity on a present state; a departure (state gone) re-encodes as null.
    if (present) aw.states.set(declaredClientId, {...(state as Record<string, unknown>), user});
    // Encode ONLY the declared client — any other states in the body are dropped here.
    return {stamped: encodeAwarenessUpdate(aw, [declaredClientId]), present};
  } catch {
    return {stamped: new Uint8Array(), present: false};
  } finally {
    aw.destroy(); // clears the awareness heartbeat interval (never ticks in sync code)
    doc.destroy();
  }
}

interface PresenceEntry {
  /** The latest identity-stamped awareness update for this client. */
  update: Uint8Array;
  /** Last time we heard from this client (for the awareness TTL sweep). */
  lastSeen: number;
}

export interface AwarenessRelayOptions {
  /** Max pages held live at once (LRU-evicted past this). */
  maxPages?: number;
  /**
   * Max distinct clients tracked per page (oldest evicted past this). Bounds one
   * page's map so an authed reader can't inflate it by cycling `clientId`s faster
   * than the TTL sweeps — a real page never has hundreds of simultaneous cursors.
   */
  maxClientsPerPage?: number;
  /**
   * Drop a client's presence after this many ms with no refresh — the awareness
   * `outdatedTimeout` (30s), so a crashed client ages out of the snapshot at the
   * same rate peers expire it (a live client re-announces every ~15s).
   */
  ttlMs?: number;
}

export class AwarenessRelay {
  // pageId → (Yjs clientID → latest stamped presence).
  private readonly pages = new Map<string, Map<number, PresenceEntry>>();
  private readonly maxPages: number;
  private readonly maxClientsPerPage: number;
  private readonly ttlMs: number;

  constructor(opts: AwarenessRelayOptions = {}) {
    this.maxPages = opts.maxPages ?? 1024;
    this.maxClientsPerPage = opts.maxClientsPerPage ?? 256;
    this.ttlMs = opts.ttlMs ?? 30_000;
  }

  /** Record (or refresh) a client's stamped presence on a page. */
  ingest(pageId: string, clientId: number, stamped: Uint8Array): void {
    this.sweepExpired();
    let page = this.pages.get(pageId);
    if (!page) {
      page = new Map();
      this.pages.set(pageId, page);
    }
    // Write the entry FIRST, so this page is now the most-recently-touched and can't
    // be chosen as the page-LRU victim below (which would discard what we just wrote).
    page.set(clientId, {update: stamped, lastSeen: Date.now()});
    this.evictClientsIfNeeded(page); // per-page client cap
    this.evictLruIfNeeded(pageId); // page cap (never evicts the page we just wrote)
  }

  /** Drop a client's presence (it sent an offline/`null` state, or we expired it). */
  remove(pageId: string, clientId: number): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    page.delete(clientId);
    if (page.size === 0) this.pages.delete(pageId);
  }

  /**
   * The current presence snapshot for a page: the stamped update of every client
   * still within the TTL, for a late joiner to apply at once. Stale entries are
   * swept first, so a crashed peer never lingers in the snapshot.
   */
  snapshot(pageId: string): Uint8Array[] {
    this.sweepExpired();
    const page = this.pages.get(pageId);
    if (!page) return [];
    return [...page.values()].map((e) => e.update);
  }

  /** Drop a page's presence entirely (e.g. on delete). Safe if absent. */
  forget(pageId: string): void {
    this.pages.delete(pageId);
  }

  /** Pages currently holding presence (tests / introspection). */
  size(): number {
    return this.pages.size;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Drop clients (and emptied pages) idle past the TTL. Lazy — no timer to leak. */
  private sweepExpired(): void {
    if (this.ttlMs <= 0) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [pageId, page] of this.pages) {
      for (const [clientId, entry] of page) {
        if (entry.lastSeen < cutoff) page.delete(clientId);
      }
      if (page.size === 0) this.pages.delete(pageId);
    }
  }

  /** Evict the oldest clients on a page past the per-page cap. */
  private evictClientsIfNeeded(page: Map<number, PresenceEntry>): void {
    while (page.size > this.maxClientsPerPage) {
      let oldestId: number | null = null;
      let oldest = Infinity;
      for (const [clientId, entry] of page) {
        if (entry.lastSeen < oldest) {
          oldest = entry.lastSeen;
          oldestId = clientId;
        }
      }
      if (oldestId == null) break;
      page.delete(oldestId);
    }
  }

  /** Evict the least-recently-touched page when over the cap (never `keepPageId`,
   *  the page just written — so a fresh ingest can't discard its own entry). */
  private evictLruIfNeeded(keepPageId?: string): void {
    while (this.pages.size > this.maxPages) {
      let oldestId: string | null = null;
      let oldest = Infinity;
      for (const [pageId, page] of this.pages) {
        if (pageId === keepPageId) continue;
        const newest = Math.max(...[...page.values()].map((e) => e.lastSeen), 0);
        if (newest < oldest) {
          oldest = newest;
          oldestId = pageId;
        }
      }
      if (oldestId == null) break;
      this.pages.delete(oldestId);
    }
  }
}
