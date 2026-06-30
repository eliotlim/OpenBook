import {describe, it, expect} from 'vitest';
import * as Y from 'yjs';
import type {DataClient} from '@book.dev/sdk';
import {connectPageRelay} from '../relay';
import {connectPageAwareness} from '../awareness';
import {connectPageSaver} from '../saver';
import {blockText, createDoc, decodeSnapshot, encodeSnapshot, findBlock} from '../model';

/**
 * Collab T3 — single-saver election (`connectPageSaver`). With N concurrent editors the
 * relay converges every doc live, but each one still debounce-saves the WHOLE snapshot on
 * its own edits → N overlapping whole-snapshot writes per burst (OB-164/OB-242 write-amp)
 * where ONE save persists the same converged doc. These pin the parts that bound that:
 * exactly one client persists a shared burst, handover on saver-leave, the solo / last
 * writer always saves, dirty-on-election closes the handover gap, and a non-saver still
 * saves itself when the saver can't confirm (the offline/poll-mode safety net).
 *
 * Drives the REAL providers ({@link connectPageRelay} + {@link connectPageAwareness}) over
 * an in-memory transport, so election rides the same awareness presence it does in the
 * app — only the durable `save` is a spy (we count who writes, not the snapshot itself).
 */

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s);
};
const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * A combined in-memory relay + awareness fake — the two ephemeral channels collab uses —
 * fanning every post out to ALL subscribers (incl. the author echo, which the providers
 * drop by clientId). It does NOT re-stamp identity, so a client's own `canWrite`/`saved`
 * top-level awareness fields flow through unchanged (the real server's stamp preserves
 * them too, only forcing `user`).
 */
function fakeCollab(): {client: DataClient} {
  const relSubs = new Map<string, Set<(u: string, c: number) => void>>();
  const relDocs = new Map<string, Y.Doc>();
  const relDoc = (id: string): Y.Doc => {
    let d = relDocs.get(id);
    if (!d) {
      d = new Y.Doc();
      relDocs.set(id, d);
    }
    return d;
  };
  const awSubs = new Map<string, Set<(u: string, c: number) => void>>();
  const awSnap = new Map<string, Map<number, string>>();
  const client = {
    postPageUpdate(id: string, update: string, clientId: number): Promise<void> {
      Y.applyUpdate(relDoc(id), fromB64(update));
      relSubs.get(id)?.forEach((fn) => fn(update, clientId));
      return Promise.resolve();
    },
    subscribePageUpdates(id: string, on: (u: string, c: number) => void): () => void {
      let s = relSubs.get(id);
      if (!s) {
        s = new Set();
        relSubs.set(id, s);
      }
      s.add(on);
      return () => s?.delete(on);
    },
    syncPageUpdates(id: string, sv: string): Promise<string | null> {
      const diff = Y.encodeStateAsUpdate(relDoc(id), sv.length > 0 ? fromB64(sv) : undefined);
      return Promise.resolve(diff.length <= 2 ? null : toB64(diff));
    },
    postPageAwareness(id: string, update: string, clientId: number): Promise<void> {
      let p = awSnap.get(id);
      if (!p) {
        p = new Map();
        awSnap.set(id, p);
      }
      p.set(clientId, update);
      awSubs.get(id)?.forEach((fn) => fn(update, clientId));
      return Promise.resolve();
    },
    subscribePageAwareness(id: string, on: (u: string, c: number) => void): () => void {
      let s = awSubs.get(id);
      if (!s) {
        s = new Set();
        awSubs.set(id, s);
      }
      s.add(on);
      return () => s?.delete(on);
    },
    syncPageAwareness(id: string): Promise<string[]> {
      return Promise.resolve([...(awSnap.get(id)?.values() ?? [])]);
    },
  } as unknown as DataClient;
  return {client};
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const blankSnap = (): ReturnType<typeof encodeSnapshot> => encodeSnapshot(createDoc([{id: 'b1', type: 'paragraph', text: ''}]));
const edit = (doc: Y.Doc, ch: string): void =>
  doc.transact(() => {
    const t = blockText(findBlock(doc, 'b1')!.block)!;
    t.insert(t.length, ch);
  }, 'local');
const textOf = (doc: Y.Doc): string => blockText(findBlock(doc, 'b1')!.block)!.toString();

interface Writer {
  doc: Y.Doc;
  isSaver: () => boolean;
  saves: () => number;
  disconnect: () => void;
}

/** A fully-wired editor: relay + awareness + the saver controller, with a spy `save`. */
function connectWriter(
  client: DataClient,
  pageId: string,
  clientId: number,
  snap: ReturnType<typeof encodeSnapshot>,
  opts: {canWrite?: boolean; debounceMs?: number; backstopMs?: number} = {},
): Writer {
  const doc = decodeSnapshot(snap);
  doc.clientID = clientId; // deterministic election order (lowest = saver)
  const relay = connectPageRelay(doc, pageId, client);
  const aware = connectPageAwareness(doc, pageId, client, {name: `U${clientId}`, id: `u${clientId}`}, {channelName: `tab-${clientId}`});
  let count = 0;
  const saver = connectPageSaver(doc, aware.awareness, {
    canWrite: opts.canWrite ?? true,
    save: () => {
      count += 1;
      return Promise.resolve();
    },
    debounceMs: opts.debounceMs ?? 80,
    backstopMs: opts.backstopMs ?? 5_000,
  });
  return {
    doc,
    isSaver: () => saver.isSaver(),
    saves: () => count,
    disconnect: () => {
      saver.disconnect();
      aware.disconnect();
      relay.disconnect();
    },
  };
}

describe('Collab T3 — single-saver election', () => {
  it('lets only the elected (lowest-clientID) saver persist a shared edit burst', async () => {
    const {client} = fakeCollab();
    const snap = blankSnap();
    const w10 = connectWriter(client, 'p', 10, snap, {debounceMs: 150});
    const w20 = connectWriter(client, 'p', 20, snap, {debounceMs: 150});
    const w30 = connectWriter(client, 'p', 30, snap, {debounceMs: 150});
    await wait(220); // canWrite propagates → election converges

    expect(w10.isSaver()).toBe(true);
    expect(w20.isSaver()).toBe(false);
    expect(w30.isSaver()).toBe(false);

    // All three edit (the burst); they converge into the saver's doc via the relay.
    edit(w10.doc, 'a');
    edit(w20.doc, 'b');
    edit(w30.doc, 'c');
    await wait(500);

    // The two non-savers NEVER write; the single saver persists the converged doc once.
    // Without election all three would whole-snapshot-save → 3× the writes for one burst.
    expect(w20.saves()).toBe(0);
    expect(w30.saves()).toBe(0);
    expect(w10.saves()).toBeGreaterThanOrEqual(1);
    expect(w10.saves()).toBeLessThanOrEqual(2); // coalesced (ideally exactly one)
    // …and every edit reached the saver's converged doc (nothing dropped).
    expect(textOf(w10.doc).split('').sort().join('')).toBe('abc');

    w10.disconnect();
    w20.disconnect();
    w30.disconnect();
  });

  it('hands over to the next writer when the saver leaves — no gap', async () => {
    const {client} = fakeCollab();
    const snap = blankSnap();
    const w10 = connectWriter(client, 'p', 10, snap);
    const w20 = connectWriter(client, 'p', 20, snap);
    const w30 = connectWriter(client, 'p', 30, snap);
    await wait(220);
    expect(w10.isSaver()).toBe(true);

    w10.disconnect(); // the saver leaves
    await wait(220); // departure propagates → re-election

    expect(w20.isSaver()).toBe(true); // the next-lowest writer took over
    expect(w30.isSaver()).toBe(false);

    const before = w20.saves();
    edit(w30.doc, 'z'); // a post-handover edit by a non-saver
    await wait(300);
    expect(w20.saves()).toBeGreaterThan(before); // the NEW saver persists it
    expect(w30.saves()).toBe(0); // the non-saver still never writes

    w20.disconnect();
    w30.disconnect();
  });

  it('immediately persists a dirty doc on becoming saver (dirty-on-election closes the gap)', async () => {
    const {client} = fakeCollab();
    const snap = blankSnap();
    // A long debounce so the saver does NOT persist w20's edit before it leaves — the gap.
    const w10 = connectWriter(client, 'p', 10, snap, {debounceMs: 5_000});
    const w20 = connectWriter(client, 'p', 20, snap, {debounceMs: 5_000});
    await wait(220);
    expect(w10.isSaver()).toBe(true);

    edit(w20.doc, 'x'); // w20 (non-saver) edits → its doc is dirty / unconfirmed
    await wait(140); // it relays to the saver, but the saver's long debounce hasn't fired
    expect(w20.saves()).toBe(0);

    w10.disconnect(); // the saver leaves before persisting
    await wait(220); // w20 re-elects to saver

    expect(w20.isSaver()).toBe(true);
    // Saved at once on election — no further edit needed — so the gap drops nothing.
    expect(w20.saves()).toBeGreaterThanOrEqual(1);

    w20.disconnect();
  });

  it('always saves when solo with no awareness (offline / no relay presence)', async () => {
    const snap = blankSnap();
    const doc = decodeSnapshot(snap);
    doc.clientID = 42;
    let saves = 0;
    const saver = connectPageSaver(doc, null, {
      canWrite: true,
      save: () => {
        saves += 1;
        return Promise.resolve();
      },
      debounceMs: 60,
    });
    expect(saver.isSaver()).toBe(true); // no presence ⇒ solo ⇒ always the saver

    edit(doc, 'q');
    await wait(200);
    expect(saves).toBeGreaterThanOrEqual(1);
    saver.disconnect();
  });

  it('keeps the last writer standing (present, but alone) saving', async () => {
    const {client} = fakeCollab();
    const only = connectWriter(client, 'p', 7, blankSnap(), {debounceMs: 60});
    await wait(140);
    expect(only.isSaver()).toBe(true);

    edit(only.doc, 'm');
    await wait(200);
    expect(only.saves()).toBeGreaterThanOrEqual(1);
    only.disconnect();
  });

  it('never lets a viewer save, even as the lowest clientID', async () => {
    const {client} = fakeCollab();
    const snap = blankSnap();
    const viewer = connectWriter(client, 'p', 3, snap, {canWrite: false, debounceMs: 60});
    const writer = connectWriter(client, 'p', 9, snap, {debounceMs: 60});
    await wait(200);

    expect(viewer.isSaver()).toBe(false); // a viewer is never elected
    expect(writer.isSaver()).toBe(true); // the lowest *writer* saves

    edit(writer.doc, 'w');
    await wait(200);
    expect(viewer.saves()).toBe(0);
    expect(writer.saves()).toBeGreaterThanOrEqual(1);

    viewer.disconnect();
    writer.disconnect();
  });

  it('republishes canWrite:false when a client flips writer→viewer — no stale election leak', async () => {
    // useCanWrite defaults `true` while getInstanceInfo() loads, so a client that
    // resolves to a viewer first advertises canWrite:true. The page effect re-runs on
    // the flip — tearing down the canWrite:true controller and starting a canWrite:false
    // one (the fix: connectPageSaver runs unconditionally). This pins that the stale
    // `true` is overwritten, so the viewer can't win the election (and 403 every save,
    // stranding real writers on the backstop) despite holding the lowest clientID.
    const {client} = fakeCollab();
    const snap = blankSnap();

    const flipDoc = decodeSnapshot(snap);
    flipDoc.clientID = 5; // the LOWEST id — a stale canWrite:true here would win
    const flipAware = connectPageAwareness(flipDoc, 'p', client, {name: 'V', id: 'v'}, {channelName: 'tab-5'});
    // Phase 1: optimistic writer (canWrite still loading → defaults true).
    const optimistic = connectPageSaver(flipDoc, flipAware.awareness, {canWrite: true, save: () => Promise.resolve()});
    await wait(100);
    expect((flipAware.awareness.getLocalState() as {canWrite?: boolean}).canWrite).toBe(true);

    // Phase 2: canWrite resolves to false → the effect re-runs (old tears down, new runs).
    optimistic.disconnect();
    const resolved = connectPageSaver(flipDoc, flipAware.awareness, {canWrite: false, save: () => Promise.resolve()});
    await wait(100);

    expect((flipAware.awareness.getLocalState() as {canWrite?: boolean}).canWrite).toBe(false);
    expect(resolved.isSaver()).toBe(false); // a viewer is never elected…

    // …and a real writer with a HIGHER clientID is the saver (the viewer didn't usurp it).
    const writer = connectWriter(client, 'p', 20, snap, {debounceMs: 60});
    await wait(180);
    expect(writer.isSaver()).toBe(true);
    edit(writer.doc, 'w');
    await wait(160);
    expect(writer.saves()).toBeGreaterThanOrEqual(1);

    resolved.disconnect();
    flipAware.disconnect();
    writer.disconnect();
  });

  it('falls back to saving its own edits when the saver never confirms (degraded relay / stalled saver)', async () => {
    const {client} = fakeCollab();
    const snap = blankSnap();
    // A present lower-id writer that never actually persists (no saver controller) — it
    // just advertises canWrite, like a saver stuck behind a poll-mode tunnel that buffers
    // its live stream, so it never publishes a `saved` state vector.
    const stalledDoc = decodeSnapshot(snap);
    stalledDoc.clientID = 5;
    const stalled = connectPageAwareness(stalledDoc, 'p', client, {name: 'stalled', id: 's'}, {channelName: 'tab-5'});
    stalled.awareness.setLocalStateField('canWrite', true);

    const w20 = connectWriter(client, 'p', 20, snap, {debounceMs: 60, backstopMs: 150});
    await wait(220);
    expect(w20.isSaver()).toBe(false); // it defers to the lower-id "saver" (id 5)

    edit(w20.doc, 'k'); // relays out, but id 5 never persists / publishes a `saved` SV
    await wait(120);
    expect(w20.saves()).toBe(0); // still inside the grace window — deferring to the saver
    await wait(220); // past the backstop
    expect(w20.saves()).toBeGreaterThanOrEqual(1); // saved its own edit — no lost edit

    w20.disconnect();
    stalled.disconnect();
  });
});
