import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {colorForIdentity, type DataClient} from '@book.dev/sdk';
import {blockText, findBlock} from './model';

/**
 * Live presence/awareness over the relay transport (Collab T4) — the DATA layer
 * for multiplayer cursors. It binds a `y-protocols/awareness` instance to the
 * editor's Y.Doc and carries each client's identity + selection between users,
 * exposing the resulting state for T5 to render remote carets/avatars (this module
 * builds NO cursor UI).
 *
 * Two transports, mirroring {@link connectBroadcast} + {@link connectPageRelay}:
 *
 *  - **Network (cross-user).** Local awareness changes POST to
 *    `/api/pages/:id/awareness` (read-gated, so viewers appear present); incoming
 *    presence arrives as `awareness` SSE frames, plus a one-shot snapshot on connect
 *    so a late joiner sees who's already here. The server **re-stamps the identity**
 *    from the verified principal, so a peer's name/colour are trustworthy — what we
 *    set locally below is only our own self-view + the same-browser mirror.
 *  - **BroadcastChannel (same-browser tabs).** Awareness also rides a channel so two
 *    tabs of one user see each other instantly and offline; same user, so the
 *    self-stamped identity is trivially correct there.
 *
 * Ephemeral throughout: nothing is persisted, and a peer is cleaned up on
 * disconnect/unmount (an explicit departure), on the awareness TTL (a crashed
 * client), and on `beforeunload` (best-effort on tab close) — no ghost cursors.
 */

/** Who this client is, for the LOCAL self-view (the server re-stamps for peers). */
export interface AwarenessIdentity {
  /** Display name (the verified principal's, when known). */
  name: string;
  /** Stable seed for the presence colour — the principal subject / email / a fallback. */
  id: string;
}

/** A client's selection, carried as `Y.RelativePosition` JSON so it survives edits. */
export interface AwarenessSelection {
  /** The block that owns the caret/selection. */
  blockId: string;
  /** Caret anchor as `Y.RelativePosition` JSON (null ⇒ block-level focus only). */
  anchor: unknown | null;
  /** Caret head as `Y.RelativePosition` JSON (null ⇒ collapsed at the anchor). */
  head: unknown | null;
}

/** The shape T5 reads out of each peer's `awareness.getStates()` entry. */
export interface AwarenessState {
  user?: {name: string; color: string; id: string};
  selection?: AwarenessSelection | null;
  /**
   * Whether this client may WRITE the page — the saver-election eligibility signal
   * (Collab T3). Published as a top-level awareness field (NOT inside `user`, which the
   * server re-stamps), so it survives the identity stamp and reaches peers. A viewer
   * (`false`/absent) is never elected saver; the lowest-clientID writer is. Set by the
   * saver controller, not the presence provider — see {@link connectPageSaver}.
   */
  canWrite?: boolean;
  /**
   * The base64 Yjs state vector the elected saver has DURABLY persisted, re-published
   * after each successful snapshot save (Collab T3). A non-saver compares it against its
   * own client clock to confirm its relayed edits actually reached the store before
   * skipping its own save — so a degraded relay (poll-mode) or a stalled saver can never
   * silently strand an edit (the non-saver's backstop fires instead).
   */
  saved?: string;
}

export interface AwarenessConnection {
  /** The live awareness instance — T5 reads `getStates()` + listens `'change'`. */
  readonly awareness: Awareness;
  /** Publish this client's selection (focused block + optional caret range). */
  setSelection(sel: AwarenessSelection | null): void;
  disconnect(): void;
}

/** Coalesce window for outgoing local awareness (ms). Exported for tests/tuning. */
export const AWARENESS_FLUSH_MS = 50;

/**
 * Hard floor between awareness POST *starts* (ms) — a transport-independent ~10Hz
 * rate ceiling (Collab T8). The coalesce window above only batches the leading edge;
 * the one-in-flight `posting` guard alone bounds the send rate by round-trip time,
 * which collapses to ~20Hz on a fast transport (loopback dev, a low-latency tunnel).
 * Awareness fan-out is O(editors²) — every client's cursor POST is re-broadcast to
 * every other client's SSE — so an unthrottled stream multiplies fast under
 * multi-editor load through the *.book.pub tunnel. This caps the SUSTAINED send rate
 * regardless of RTT. Exported for tests/tuning.
 */
export const AWARENESS_MIN_INTERVAL_MS = 100;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Build an {@link AwarenessSelection} for a block + optional caret offsets, encoding
 * the offsets as `Y.RelativePosition`s into the block's text so they track edits
 * (T5 resolves them back with `Y.createAbsolutePositionFromRelativePosition`). Omit
 * the offsets for block-level focus only.
 */
export function blockSelection(
  doc: Y.Doc,
  blockId: string,
  anchorOffset?: number,
  headOffset?: number,
): AwarenessSelection {
  const found = findBlock(doc, blockId);
  const text = found ? blockText(found.block) : undefined;
  const rel = (offset: number | undefined): unknown | null =>
    text && typeof offset === 'number'
      ? Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, offset))
      : null;
  const anchor = rel(anchorOffset);
  return {blockId, anchor, head: headOffset === undefined ? anchor : rel(headOffset)};
}

export interface ConnectAwarenessOptions {
  /** Same-browser channel key (defaults to the page id) for the tab mirror. */
  channelName?: string;
}

export function connectPageAwareness(
  doc: Y.Doc,
  pageId: string,
  client: DataClient,
  identity: AwarenessIdentity,
  options: ConnectAwarenessOptions = {},
): AwarenessConnection {
  const awareness = new Awareness(doc);
  let disposed = false;

  // ── Same-browser tabs (BroadcastChannel) ─────────────────────────────────────
  const bc = new BroadcastChannel(`obe:aware:${options.channelName ?? pageId}`);
  const bcPost = (bytes: Uint8Array): void => {
    try {
      bc.postMessage({u: bytes});
    } catch {
      // channel closed mid-flight (tab teardown) — nothing to do
    }
  };
  bc.onmessage = (e: MessageEvent<{u?: ArrayBuffer | Uint8Array; hello?: boolean}>) => {
    const m = e.data;
    if (!m || disposed) return;
    if (m.hello) {
      bcPost(encodeAwarenessUpdate(awareness, [doc.clientID])); // a new tab asked — reply with our state
      return;
    }
    if (m.u) applyAwarenessUpdate(awareness, m.u instanceof Uint8Array ? m.u : new Uint8Array(m.u), 'bc');
  };
  bc.postMessage({hello: true}); // ask any already-open tab for its current presence

  // ── Network (cross-user) ─────────────────────────────────────────────────────
  const unsubscribe = client.subscribePageAwareness(pageId, (update, clientId) => {
    if (disposed || clientId === doc.clientID) return; // our own echo — already applied
    try {
      applyAwarenessUpdate(awareness, fromBase64(update), 'net');
    } catch {
      // a malformed awareness frame is dropped rather than corrupting local state
    }
  });

  // Snapshot of who's already here, so we don't wait out the next periodic refresh.
  void (async () => {
    try {
      const updates = await client.syncPageAwareness(pageId);
      if (disposed) return;
      for (const u of updates) {
        try {
          applyAwarenessUpdate(awareness, fromBase64(u), 'net');
        } catch {
          /* skip a bad entry */
        }
      }
    } catch {
      // offline / poll-mode tunnel: the periodic awareness refresh is the backstop
    }
  })();

  // ── Send: coalesce local changes, one POST in flight, ≤10Hz sustained ─────────
  let timer: ReturnType<typeof setTimeout> | null = null;
  let posting = false;
  let dirty = false;
  // When the last POST *started*, for the sustained-rate ceiling (Collab T8).
  let lastPostAt = 0;

  const postSelf = (): Uint8Array => encodeAwarenessUpdate(awareness, [doc.clientID]);

  const flush = (): void => {
    timer = null;
    if (disposed || posting || !dirty) return;
    // Rate ceiling: never start two POSTs closer than AWARENESS_MIN_INTERVAL_MS —
    // if we posted too recently, defer the whole (still-dirty) batch until the floor
    // elapses. Transport-independent, so a fast tunnel can't push presence past ~10Hz.
    const since = Date.now() - lastPostAt;
    if (since < AWARENESS_MIN_INTERVAL_MS) {
      timer = setTimeout(flush, AWARENESS_MIN_INTERVAL_MS - since);
      return;
    }
    dirty = false;
    lastPostAt = Date.now();
    const bytes = postSelf();
    posting = true;
    void client
      .postPageAwareness(pageId, toBase64(bytes), doc.clientID)
      .catch(() => {
        // a dropped presence POST is non-fatal — the periodic refresh re-sends it
      })
      .finally(() => {
        posting = false;
        if (!disposed && dirty && !timer) timer = setTimeout(flush, AWARENESS_FLUSH_MS);
      });
  };

  const onUpdate = (
    {added, updated, removed}: {added: number[]; updated: number[]; removed: number[]},
    origin: unknown,
  ): void => {
    // Only relay OUR OWN local changes. `'net'`/`'bc'` are echoes (relaying loops),
    // and `'timeout'` is our local expiry of a *remote* peer (not ours to announce).
    if (origin !== 'local') return;
    const mine = [...added, ...updated, ...removed].includes(doc.clientID);
    if (!mine) return;
    const bytes = postSelf();
    bcPost(bytes); // same-browser tabs see it instantly
    if (removed.includes(doc.clientID)) {
      // a departure (disconnect) — send now; we may be mid-teardown, don't coalesce
      dirty = false;
      void client.postPageAwareness(pageId, toBase64(bytes), doc.clientID).catch(() => undefined);
      return;
    }
    dirty = true;
    if (!timer && !posting) timer = setTimeout(flush, AWARENESS_FLUSH_MS);
  };
  awareness.on('update', onUpdate);

  // Set our identity for the LOCAL view (the server re-stamps it for peers, so a
  // spoofed name never reaches anyone else; colour is derived the SAME way the
  // server derives it, so our self-colour matches how peers see us). This runs
  // AFTER the handler is wired so it also fires the initial announce — a peer sees
  // us the moment we connect, not only on our next change or the periodic refresh.
  awareness.setLocalStateField('user', {
    name: identity.name,
    color: colorForIdentity(identity.id),
    id: identity.id,
  });

  // Best-effort departure on a hard tab close (the awareness TTL is the backstop).
  const onUnload = (): void => sendDeparture();
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) window.addEventListener('beforeunload', onUnload);

  let departed = false;
  function sendDeparture(): void {
    if (departed) return;
    departed = true;
    removeAwarenessStates(awareness, [doc.clientID], 'local-departure'); // not 'local' → onUpdate ignores it
    const bytes = encodeAwarenessUpdate(awareness, [doc.clientID]); // encodes our now-null state
    bcPost(bytes);
    void client.postPageAwareness(pageId, toBase64(bytes), doc.clientID).catch(() => undefined);
  }

  return {
    awareness,
    setSelection(sel) {
      if (disposed) return;
      awareness.setLocalStateField('selection', sel);
    },
    disconnect() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (hasWindow) window.removeEventListener('beforeunload', onUnload);
      awareness.off('update', onUpdate);
      sendDeparture(); // announce we're gone (no ghost cursor) before tearing down
      unsubscribe();
      try {
        bc.close();
      } catch {
        /* already closed */
      }
      awareness.destroy(); // clears the awareness heartbeat/expiry interval
    },
  };
}
