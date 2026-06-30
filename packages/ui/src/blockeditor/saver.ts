import * as Y from 'yjs';
import type {Awareness} from 'y-protocols/awareness';
import {electSaver, isElectedSaver} from '@/lib/presence';
import type {AwarenessState} from './awareness';

/**
 * Single-saver election + durable-checkpoint coordinator (Collab T3).
 *
 * The relay (Collab T1/T2) fans every incremental edit so N concurrent editors converge
 * live, but each client still debounce-saves the WHOLE snapshot on its OWN edits — N
 * overlapping whole-snapshot writes per burst (OB-164/OB-242 write-amp) when ONE save
 * would persist the same converged doc for everyone. This controller bounds that to a
 * single writer at a time, without moving persistence server-side (that's the separate
 * T9) and without ever dropping an edit:
 *
 *  - **Election.** Among present *writers* (advertised via the awareness `canWrite`
 *    field), the lowest `clientID` is the saver — every peer derives the same answer
 *    from the shared awareness map ({@link isElectedSaver}). Only the elected saver runs
 *    the debounced save; it persists the converged doc no matter WHO authored the latest
 *    change (a relayed peer's edit included — its author deliberately skips its own
 *    save). Non-savers don't write; their edits relay into the saver's doc and are
 *    persisted there, once.
 *
 *  - **Handover (awareness-driven).** When the saver leaves, its awareness departure
 *    re-elects the next-lowest writer, which **immediately saves if the doc is dirty**
 *    (dirty-on-election) so no window drops the latest edits. The leaving saver also
 *    flushes a final save on {@link SaverConnection.disconnect} — double cover, no gap.
 *    The last writer standing (and any client with no awareness at all — offline / no
 *    relay) is always the saver, so a solo doc is never stranded un-persisted.
 *
 *  - **Degraded-relay safety net (backstop).** A non-saver confirms the elected saver
 *    actually persisted ITS edits by comparing its own client clock against the saver's
 *    published `saved` state vector. If that confirmation doesn't arrive within a grace
 *    window — the *.book.pub poll-mode tunnel buffering the live stream, or a stalled /
 *    non-receiving saver — the non-saver saves its OWN edits (the existing
 *    offline/poll-fallback). So the write-amp win holds whenever the live relay is
 *    healthy, and degrades to "everyone saves" (today's behaviour) exactly when it
 *    isn't — never a lost edit.
 *
 * Stateful + transport-free (yjs + a `y-protocols/awareness` instance), mirroring
 * {@link connectPageRelay}/{@link connectPageAwareness}, so it unit-tests without React
 * or a network and bundles into the portless sidecar.
 */

/** Debounce window for the elected saver's snapshot save (ms). Exported for tuning. */
export const SAVER_DEBOUNCE_MS = 600;

/**
 * Grace window before a non-saver falls back to saving its OWN edits when the elected
 * saver hasn't confirmed persisting them (ms). Long relative to the live save+confirm
 * round-trip (≈ debounce + a relay RTT), so it never fires while the relay is healthy,
 * only when convergence has genuinely degraded. Exported for tests/tuning.
 */
export const SAVER_BACKSTOP_MS = 8_000;

export interface SaverConnection {
  /** Whether this client is currently the elected saver (tests / inspection). */
  isSaver(): boolean;
  /** Tear down; flushes one final save if this client holds un-persisted edits. */
  disconnect(): void;
}

export interface ConnectSaverOptions {
  /** This client's own write capability — a viewer (`false`) is never elected saver. */
  canWrite: boolean;
  /**
   * Persist the current doc (the component's projection + `onSave` + no-op skip).
   * Resolves on success, REJECTS on failure — the controller relies on that to keep
   * a failed save "unconfirmed" (so the backstop / next debounce retries it). Called at
   * most once per debounce window, only when elected (or on a backstop / final flush).
   */
  save: () => Promise<void> | void;
  /** Called when this client gains un-persisted edits (→ a "saving" indicator). */
  onPending?: () => void;
  /** Called when all of this client's edits are durably persisted (→ "saved"). */
  onPersisted?: () => void;
  /** Called when the elected role flips (tests / a "you are the saver" affordance). */
  onRoleChange?: (isSaver: boolean) => void;
  /** Override the debounce window (ms). */
  debounceMs?: number;
  /** Override the backstop window (ms). */
  backstopMs?: number;
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

/** This doc's own local clock — the number of ops authored by `doc.clientID`. */
const localClock = (doc: Y.Doc): number => Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;

/** The clock a base64 state vector covers for `clientId` (0 ⇒ unknown / malformed). */
const clockFor = (svB64: string | undefined, clientId: number): number => {
  if (!svB64) return 0;
  try {
    return Y.decodeStateVector(fromBase64(svB64)).get(clientId) ?? 0;
  } catch {
    return 0;
  }
};

export function connectPageSaver(doc: Y.Doc, awareness: Awareness | null, opts: ConnectSaverOptions): SaverConnection {
  const debounceMs = opts.debounceMs ?? SAVER_DEBOUNCE_MS;
  const backstopMs = opts.backstopMs ?? SAVER_BACKSTOP_MS;

  let disposed = false;
  let saver = false;
  // The converged doc has changes not yet persisted by this client (drives the saver's
  // debounce + dirty-on-election). Set on any non-'server' update, cleared optimistically
  // when a save is dispatched (re-set if it fails or new edits land during the write).
  let dirty = false;
  let saving = false;
  let resaveQueued = false;
  // The highest local clock THIS client has itself durably persisted (its own saves).
  let ownPersistedClock = 0;
  let lastBusy = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let backstopTimer: ReturnType<typeof setTimeout> | null = null;

  const states = (): Map<number, AwarenessState> =>
    (awareness ? awareness.getStates() : new Map()) as Map<number, AwarenessState>;

  /** The elected saver's published persisted-state-vector, or undefined if we're it. */
  const saverSavedSV = (): string | undefined => {
    if (!awareness) return undefined;
    const map = states();
    const saverId = electSaver(map, {localClientId: doc.clientID, localCanWrite: opts.canWrite});
    if (saverId == null || saverId === doc.clientID) return undefined;
    return map.get(saverId)?.saved;
  };

  /** The highest clock of OUR ops known durably persisted — by us, or by the saver. */
  const confirmedClock = (): number => Math.max(ownPersistedClock, clockFor(saverSavedSV(), doc.clientID));

  /** We authored ops neither we nor the elected saver have confirmed persisting. */
  const unconfirmedLocal = (): boolean => localClock(doc) > confirmedClock();

  const refreshStatus = (): void => {
    const busy = saving || debounceTimer != null || backstopTimer != null || (saver ? dirty : unconfirmedLocal());
    if (busy === lastBusy) return;
    lastBusy = busy;
    (busy ? opts.onPending : opts.onPersisted)?.();
  };

  const scheduleDebounced = (): void => {
    if (disposed || !saver) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!disposed && saver) dispatchSave();
      refreshStatus();
    }, debounceMs);
  };

  const armBackstop = (): void => {
    if (disposed || saver || backstopTimer || !unconfirmedLocal()) return;
    backstopTimer = setTimeout(() => {
      backstopTimer = null;
      // The elected saver hasn't confirmed persisting our edits within the grace window
      // (degraded relay / stalled saver). Save our own so they reach the store — never
      // lose an edit to a dead relay. Re-arm while still unconfirmed.
      if (!disposed && !saver && unconfirmedLocal()) {
        dispatchSave();
        armBackstop();
      }
      refreshStatus();
    }, backstopMs);
  };

  const dispatchSave = (): void => {
    if (disposed) return;
    if (saving) {
      resaveQueued = true;
      return;
    }
    // Capture the state vector this save persists BEFORE it runs (the save reads the doc
    // synchronously), so publishing it can't over-claim edits that land mid-write.
    const sv = Y.encodeStateVector(doc);
    const wasDirty = dirty;
    dirty = false;
    saving = true;
    void Promise.resolve()
      .then(() => opts.save())
      .then(() => {
        ownPersistedClock = Math.max(ownPersistedClock, Y.decodeStateVector(sv).get(doc.clientID) ?? 0);
        // Tell non-savers exactly how far the durable store now is, so they can confirm
        // their relayed edits landed and stand down their backstop.
        if (saver && awareness) {
          try {
            awareness.setLocalStateField('saved', toBase64(sv));
          } catch {
            /* awareness torn down mid-flight — nothing to publish */
          }
        }
      })
      .catch(() => {
        dirty = dirty || wasDirty; // failed → still un-persisted; a retry/backstop covers it
      })
      .finally(() => {
        saving = false;
        if (disposed) return;
        if (resaveQueued) {
          resaveQueued = false;
          if (saver) scheduleDebounced();
          else armBackstop();
        } else if (saver && dirty) {
          scheduleDebounced();
        } else if (!saver) {
          armBackstop();
        }
        refreshStatus();
      });
  };

  const onDocUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (disposed) return;
    // A 'server' snapshot merge is already durable in the store — it doesn't make our
    // local ops un-persisted, so it neither dirties the doc nor schedules a save.
    if (origin === 'server') {
      refreshStatus();
      return;
    }
    dirty = true; // local / relayed 'net' / sibling 'bc-remote' — converged content advanced
    if (saver) {
      // The single saver persists the converged doc whoever authored the change.
      scheduleDebounced();
    } else if (origin === 'local' || origin == null) {
      // Our own edit while a peer is the saver: the relay carries it to the saver who
      // persists it; we only arm the backstop in case that confirmation never arrives.
      armBackstop();
    }
    refreshStatus();
  };

  const recompute = (): void => {
    if (disposed) return;
    const next = isElectedSaver(states(), {localClientId: doc.clientID, localCanWrite: opts.canWrite});
    if (next !== saver) {
      saver = next;
      opts.onRoleChange?.(saver);
      if (saver) {
        // Dirty-on-election: a fresh saver (a handover, or a promoted non-saver) persists
        // immediately if the doc is dirty, so a transient election gap never drops the
        // latest edits. The no-op JSON skip in `save` dedupes if already current.
        if (backstopTimer) {
          clearTimeout(backstopTimer);
          backstopTimer = null;
        }
        if (dirty) dispatchSave();
      } else {
        // Stepped down (a lower-id writer joined + took over). Stop our debounce so we
        // don't double-save; flush once if we still hold our OWN unconfirmed edits, so
        // the brief overlap before the new saver's dirty-on-election save drops nothing.
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (unconfirmedLocal() && !saving) dispatchSave();
      }
    }
    // A fresh `saved` SV from the saver may now confirm (or no longer cover) our edits.
    if (!saver) {
      if (!unconfirmedLocal() && backstopTimer) {
        clearTimeout(backstopTimer);
        backstopTimer = null;
      } else {
        armBackstop();
      }
    }
    refreshStatus();
  };

  // Advertise our write capability so peers can include us in their election (a viewer
  // posts `false`, so it's never elected). Top-level field ⇒ survives the server's
  // identity re-stamp; relayed by the awareness provider's own local-change handler.
  if (awareness) {
    try {
      awareness.setLocalStateField('canWrite', opts.canWrite);
    } catch {
      /* awareness not ready — recompute still uses the local override */
    }
    awareness.on('change', recompute);
  }
  doc.on('update', onDocUpdate);
  recompute(); // initial election (solo when there's no awareness / no peers yet)

  return {
    isSaver: () => saver,
    disconnect() {
      if (disposed) return;
      disposed = true;
      doc.off('update', onDocUpdate);
      if (awareness) awareness.off('change', recompute);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (backstopTimer) clearTimeout(backstopTimer);
      debounceTimer = backstopTimer = null;
      // Final save on teardown so a leaving saver / last writer never strands the latest
      // edits: flush if we're the saver with a dirty doc, or (any client) we still hold
      // our own unconfirmed local edits. Fire-and-forget — a surviving peer re-elects and
      // dirty-on-election saves too, so there's no gap either way.
      if (!saving && ((saver && dirty) || unconfirmedLocal())) {
        void Promise.resolve()
          .then(() => opts.save())
          .catch(() => undefined);
      }
    },
  };
}
