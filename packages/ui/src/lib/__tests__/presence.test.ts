import {describe, it, expect} from 'vitest';
import type {AwarenessState} from '@/blockeditor';
import * as Y from 'yjs';
import {IDENTITY_COLORS} from '@book.dev/sdk';
import {blockSelection, createDoc, decodeSnapshot, encodeSnapshot, rootBlocks} from '@/blockeditor';
import {electSaver, isElectedSaver, presencePeers, readableTextColor, resolveSelectionIndices} from '@/lib/presence';

/** WCAG contrast ratio between two `#rrggbb` colours, for asserting AA. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const m = hex.replace('#', '');
    const ch = (i: number): number => {
      const c = parseInt(m.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Collab T5 — the pure presence derivations the avatar stack and remote-cursor
 * overlay are built on: deriving the peer list from an awareness state map, and
 * resolving a peer's Y.RelativePosition selection back to absolute offsets (the
 * round-trip a remote caret depends on). The DOM caret *rendering* needs layout
 * and is covered manually / in e2e, not here.
 */

const user = (id: string, name: string, color = '#5b8def'): AwarenessState['user'] => ({id, name, color});

describe('readableTextColor', () => {
  it('gives every identity swatch a foreground that clears WCAG AA (4.5:1) for small bold text', () => {
    for (const swatch of IDENTITY_COLORS) {
      const fg = readableTextColor(swatch);
      expect(contrast(fg, swatch)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks near-black on the light swatches where white fails (amber/teal/green)', () => {
    // White on amber is only ~2.2:1 — the regression Devon flagged.
    expect(contrast('#ffffff', '#e4a33c')).toBeLessThan(4.5);
    expect(readableTextColor('#e4a33c')).not.toBe('#ffffff');
  });

  it('picks white on a genuinely dark colour', () => {
    expect(readableTextColor('#1b2a4a')).toBe('#ffffff');
  });
});

describe('presencePeers', () => {
  it('excludes the local client and any half-initialised (no-identity) peer', () => {
    const states = new Map<number, AwarenessState>([
      [1, {user: user('ada', 'Ada')}],
      [2, {user: user('boris', 'Boris')}],
      [99, {user: user('me', 'Me')}], // local
      [3, {}], // connected but no identity yet
    ]);
    const peers = presencePeers(states, 99);
    expect(peers.map((p) => p.id)).toEqual(['ada', 'boris']);
  });

  it('dedupes multiple tabs of one identity into a single avatar, sorted by name', () => {
    const states = new Map<number, AwarenessState>([
      [5, {user: user('zoe', 'Zoe')}],
      [1, {user: user('ada', 'Ada')}],
      [2, {user: user('ada', 'Ada')}], // Ada's second tab
    ]);
    const peers = presencePeers(states, 99);
    expect(peers.map((p) => p.id)).toEqual(['ada', 'zoe']);
  });

  it('keeps every connection when dedupe is off (one caret per tab)', () => {
    const states = new Map<number, AwarenessState>([
      [1, {user: user('ada', 'Ada')}],
      [2, {user: user('ada', 'Ada')}],
    ]);
    expect(presencePeers(states, 99, {dedupe: false}).length).toBe(2);
  });

  it('carries the peer colour, name fallback, and selection through', () => {
    const states = new Map<number, AwarenessState>([
      [1, {user: user('ada', '  ', '#e0635c'), selection: {blockId: 'b1', anchor: null, head: null}}],
    ]);
    const [peer] = presencePeers(states, 99);
    expect(peer.color).toBe('#e0635c');
    expect(peer.name).toBe('Someone'); // blank name → fallback
    expect(peer.selection?.blockId).toBe('b1');
  });
});

describe('saver election (Collab T3)', () => {
  const writer = (canWrite: boolean): AwarenessState => ({user: user('u', 'U'), canWrite});

  it('elects the lowest-clientID present writer — every peer agrees', () => {
    const states = new Map<number, AwarenessState>([
      [30, writer(true)],
      [10, writer(true)],
      [20, writer(true)],
    ]);
    // Each peer derives the SAME answer from the shared map → exactly one saver.
    expect(electSaver(states, {localClientId: 10, localCanWrite: true})).toBe(10);
    expect(electSaver(states, {localClientId: 20, localCanWrite: true})).toBe(10);
    expect(electSaver(states, {localClientId: 30, localCanWrite: true})).toBe(10);
    expect(isElectedSaver(states, {localClientId: 10, localCanWrite: true})).toBe(true);
    expect(isElectedSaver(states, {localClientId: 20, localCanWrite: true})).toBe(false);
    expect(isElectedSaver(states, {localClientId: 30, localCanWrite: true})).toBe(false);
  });

  it('excludes viewers — a write-capable client never defers to one that cannot save', () => {
    // The lowest clientID (5) is a viewer; the saver must be the lowest *writer* (15).
    const states = new Map<number, AwarenessState>([
      [5, writer(false)],
      [15, writer(true)],
      [25, writer(true)],
    ]);
    expect(electSaver(states, {localClientId: 15, localCanWrite: true})).toBe(15);
    // A viewer itself never saves, whatever its clientID.
    expect(isElectedSaver(states, {localClientId: 5, localCanWrite: false})).toBe(false);
  });

  it('treats a peer that does not advertise canWrite (older client / no field) as a non-writer', () => {
    const states = new Map<number, AwarenessState>([
      [5, {user: user('old', 'Old')}], // no canWrite field
      [15, writer(true)],
    ]);
    // We don't defer persistence to id 5 (might be a viewer / can't save) — id 15 saves.
    expect(electSaver(states, {localClientId: 15, localCanWrite: true})).toBe(15);
  });

  it('falls back to the local writer (solo / last standing) when no writer has resolved', () => {
    // Empty map: awareness not initialised yet, or we are momentarily alone.
    expect(isElectedSaver(new Map(), {localClientId: 7, localCanWrite: true})).toBe(true);
    expect(electSaver(new Map(), {localClientId: 7, localCanWrite: true})).toBeNull();
    // Only viewers present besides us → we are still the saver.
    const onlyViewers = new Map<number, AwarenessState>([[2, writer(false)]]);
    expect(isElectedSaver(onlyViewers, {localClientId: 7, localCanWrite: true})).toBe(true);
  });
});

describe('resolveSelectionIndices', () => {
  it('resolves a range selection to absolute offsets', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'hello world'}]);
    expect(resolveSelectionIndices(doc, blockSelection(doc, 'b1', 2, 7))).toEqual({anchor: 2, head: 7});
  });

  it('treats a collapsed caret (head omitted) as anchor === head', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'hello'}]);
    expect(resolveSelectionIndices(doc, blockSelection(doc, 'b1', 4))).toEqual({anchor: 4, head: 4});
  });

  it('returns null for block-level focus (no caret) and for garbage', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'hi'}]);
    expect(resolveSelectionIndices(doc, blockSelection(doc, 'b1'))).toBeNull();
    expect(resolveSelectionIndices(doc, null)).toBeNull();
    expect(resolveSelectionIndices(doc, {blockId: 'b1', anchor: {bogus: true}, head: null})).toBeNull();
  });

  it('resolves a peer relative position in another doc that shares the history', () => {
    // Two docs converged by the relay (as in T4): a caret created in one resolves
    // in the other — this is exactly what the remote-cursor layer does.
    const snap = encodeSnapshot(createDoc([{id: 'b1', type: 'paragraph', text: 'hello'}]));
    const mine = decodeSnapshot(snap);
    const peerDoc = decodeSnapshot(snap);
    const peerSel = blockSelection(peerDoc, 'b1', 2, 4);
    expect(resolveSelectionIndices(mine, peerSel)).toEqual({anchor: 2, head: 4});
  });

  it('survives a concurrent edit before the caret (relative position tracks)', () => {
    const doc = createDoc([{id: 'b1', type: 'paragraph', text: 'hello'}]);
    const sel = blockSelection(doc, 'b1', 2, 4); // anchored at "he|ll|o"
    // Someone inserts 3 chars at the very start; the caret should slide right.
    const text = rootBlocks(doc).get(0).get('text') as Y.Text;
    text.insert(0, 'XYZ');
    expect(resolveSelectionIndices(doc, sel)).toEqual({anchor: 5, head: 7});
  });
});
