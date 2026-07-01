import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';

/**
 * The client-side network collaboration provider (Collab T2) — cross-device live
 * editing over the existing SSE-down / POST-up transport (no WebSocket: the desktop
 * is portless and the *.book.pub tunnel proxies HTTP+SSE only).
 *
 * It augments — does NOT replace — the same-browser {@link connectBroadcast}
 * BroadcastChannel (which still syncs tabs in one process instantly). This carries
 * the SAME Yjs update bytes between *devices*:
 *
 *  1. **Subscribe first** to the page's `yupdate` firehose frames, applying each as
 *     origin `'net'`. Done before the handshake so nothing after this point is missed.
 *  2. **Late-joiner handshake (+ reconnect re-handshake, Collab T7)**: POST the local
 *     doc's state vector and apply the catch-up diff the server computes from its relay
 *     doc — so a client joining mid-session converges to the CURRENT doc, not just future
 *     edits. This same handshake RE-runs on every SSE reopen-after-drop (the live stream's
 *     reconnect signal), so a client that missed `yupdate` frames while disconnected
 *     catches up tight — exactly the ops it missed — instead of waiting out the coarser
 *     page-snapshot resync (≤ snapshot-rate).
 *  3. **Relay local edits**: POST `origin === 'local'` updates, coalesced on a short
 *     timer and merged ({@link Y.mergeUpdates}), with at most ONE POST in flight
 *     (simple backpressure — heavy typing piles into the next batch, never floods).
 *
 * Invariants this provider upholds (the T1 hardening items):
 *  - **Origin discipline.** Only `'local'` updates are relayed. `'net'` (an update
 *    we applied from the relay), `'server'` (a snapshot merge), and `'bc-remote'`
 *    (a sibling tab) are echoes — relaying them would loop. Incoming updates apply
 *    as `'net'` so the save loop + this relay both recognise and ignore them.
 *  - **Echo-to-author suppression.** The firehose echoes our own post back; we drop
 *    any frame whose `clientId` is ours (we already have those changes — applying
 *    them would be an idempotent no-op anyway).
 *  - **Ephemeral, never the source of truth.** The server persists nothing here;
 *    the debounced snapshot save is the sole durable checkpoint. A dropped POST,
 *    an offline window, or a tunnel that can't stream the SSE body all degrade to
 *    snapshot-rate convergence via the existing snapshot-merge path — never lost.
 *
 * ## Tunnel poll-mode degrade (explicit policy)
 * Under the *.book.pub release tunnel, the SSE body is buffered and `yupdate` frames
 * never arrive (the live stream falls back to poll-mode). POST-up still works, so a
 * tunneled client still **ingests** its own edits to peers and still completes the
 * **sync handshake** on connect (initial convergence). Ongoing convergence then
 * rides the existing poll-mode snapshot resync (`subscribePage` → snapshot merge) at
 * snapshot-rate. The debounced snapshot save is the durable backstop, so this is a
 * graceful receive-side degrade — never a lost edit.
 */

export interface RelayConnection {
  disconnect(): void;
}

/** Coalesce window for outgoing local updates (ms). Exported for tests/tuning. */
export const RELAY_FLUSH_MS = 60;

/**
 * Origins that arrive from somewhere other than this user's own local editing, so
 * they must NOT be relayed and must NOT trigger a durable snapshot save (they were
 * already saved by their author). Shared by {@link connectPageRelay} and the page
 * document's save loop so the two can never disagree (Collab T1: the `'net'`
 * save-skip that keeps an incremental update from churning a redundant snapshot —
 * OB-164 write-amp — while the debounced snapshot stays the durable checkpoint).
 */
export function isRemoteOrigin(origin: unknown): boolean {
  return origin === 'net' || origin === 'server' || origin === 'bc-remote';
}

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

export function connectPageRelay(doc: Y.Doc, pageId: string, client: DataClient): RelayConnection {
  let disposed = false;

  // ── Receive: live frames + late-joiner catch-up (apply as 'net') ─────────────
  const applyRemote = (update: Uint8Array): void => {
    try {
      Y.applyUpdate(doc, update, 'net');
    } catch {
      // A malformed remote update is dropped rather than corrupting local state.
    }
  };

  const unsubscribe = client.subscribePageUpdates(pageId, (update, clientId) => {
    if (disposed || clientId === doc.clientID) return; // our own echo — already applied
    applyRemote(fromBase64(update));
  });

  // Handshake / re-handshake: send our state vector, apply exactly the ops we're
  // missing. Runs after subscribe so any update that lands during the round-trip still
  // arrives live; CRDT idempotency makes the overlap harmless. At most one `/sync` is in
  // flight; a reconnect that arrives mid-sync queues exactly ONE follow-up, so a flapping
  // connection can never storm the relay.
  let syncing = false;
  let syncQueued = false;
  const runSync = (): void => {
    if (disposed) return;
    if (syncing) {
      syncQueued = true;
      return;
    }
    syncing = true;
    void (async () => {
      try {
        const diff = await client.syncPageUpdates(pageId, toBase64(Y.encodeStateVector(doc)));
        if (!disposed && diff) applyRemote(fromBase64(diff));
      } catch {
        // Offline / poll-mode tunnel: the snapshot-merge path is the backstop.
      } finally {
        syncing = false;
        if (!disposed && syncQueued) {
          syncQueued = false;
          runSync();
        }
      }
    })();
  };

  runSync(); // initial late-joiner handshake on connect

  // Collab T7 — re-handshake on SSE reopen. After a drop, the `yupdate` frames missed
  // during the disconnect would otherwise only reach us via the coarser page *snapshot*
  // resync (≤ snapshot-rate). Re-running the state-vector `/sync` pulls exactly the ops
  // we missed immediately, so we converge tight rather than lagging to the next snapshot
  // (the gap Quinn's T4 review flagged). The signal is trailing-debounced in the live
  // stream (flap-guard) and the in-flight guard above coalesces any overlap; in poll-mode
  // (no live SSE) it never fires, so convergence stays at snapshot-rate — the intended
  // graceful degrade, untouched.
  const unsubReconnect = client.subscribeReconnect?.(runSync);

  // ── Send: coalesce local edits; at most one POST in flight (backpressure) ────
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let posting = false;

  const flush = (): void => {
    timer = null;
    if (disposed || posting || pending.length === 0) return;
    const batch = pending;
    pending = [];
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    posting = true;
    void client
      .postPageUpdate(pageId, toBase64(merged), doc.clientID)
      .catch(() => {
        // A dropped relay POST is non-fatal — the durable snapshot save carries the
        // change and peers converge from it (and the next batch retries the stream).
      })
      .finally(() => {
        posting = false;
        // Drain anything that accumulated while this POST was in flight.
        if (!disposed && pending.length > 0 && !timer) timer = setTimeout(flush, RELAY_FLUSH_MS);
      });
  };

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'local') return; // only relay genuine local edits (no echo loops)
    pending.push(update);
    if (!timer && !posting) timer = setTimeout(flush, RELAY_FLUSH_MS);
  };
  doc.on('update', onUpdate);

  return {
    disconnect() {
      disposed = true;
      doc.off('update', onUpdate);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      unsubReconnect?.();
      unsubscribe();
    },
  };
}
