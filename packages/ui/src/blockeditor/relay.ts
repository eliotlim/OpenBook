import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';

/**
 * Cross-device live collaboration over the existing SSE-down / POST-up transport
 * (Collab T0 spike). The same-browser {@link connectBroadcast} BroadcastChannel
 * keeps tabs in one process in sync; this carries the SAME Y-update bytes between
 * *devices* by posting local updates to `POST /api/pages/:id/updates` and applying
 * the `yupdate` frames that fan back out of the firehose SSE.
 *
 * Design (validated by this spike — see the T0 findings):
 *  - Relay ONLY `origin === 'local'` updates. `'net'` (an update we just applied
 *    from the relay), `'server'` (a snapshot merge) and `'bc-remote'` (a sibling
 *    tab) are all echoes — re-posting them would loop the relay.
 *  - Incoming updates apply with origin `'net'` so the save loop and this relay
 *    both recognise + ignore them (the editor still re-renders: Y.applyUpdate
 *    fires `doc.on('update')`).
 *  - Echo-to-author suppression by `doc.clientID`: the firehose echoes our own
 *    post back to us; we drop any frame whose `clientId` is ours (we already have
 *    those changes — applying them would be an idempotent no-op anyway).
 *  - Outgoing updates are coalesced on a short timer and merged with
 *    {@link Y.mergeUpdates}, so a burst of keystrokes becomes one POST.
 *
 * The relay is best-effort and ephemeral: the server persists nothing here, so a
 * peer that joins mid-edit converges from the next debounced snapshot save.
 */

export interface RelayConnection {
  disconnect(): void;
}

/** How long to coalesce local updates before POSTing them as one merged blob. */
const FLUSH_MS = 60;

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
  let pending: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const merged = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    void client.postPageUpdate(pageId, toBase64(merged), doc.clientID).catch(() => {
      // A dropped relay POST is non-fatal — the durable snapshot save still
      // carries the change, and peers converge from it.
    });
  };

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'local') return; // only relay genuine local edits (no echo loops)
    pending.push(update);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  doc.on('update', onUpdate);

  const unsubscribe = client.subscribePageUpdates(pageId, (update, clientId) => {
    if (clientId === doc.clientID) return; // our own echo — already applied
    try {
      Y.applyUpdate(doc, fromBase64(update), 'net');
    } catch {
      // A malformed remote update is dropped rather than corrupting local state.
    }
  });

  return {
    disconnect() {
      doc.off('update', onUpdate);
      if (timer) clearTimeout(timer);
      flush(); // best-effort send of anything still queued
      unsubscribe();
    },
  };
}
