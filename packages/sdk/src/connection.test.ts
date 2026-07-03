/**
 * Forwarding-audience persistence — in particular the stale-audience heal: an
 * audience recorded as `<prefix>.book.pub` before the `*.book.cloud` root move
 * can never mint again (the issuer only allowlists the new root), so
 * {@link getForwardingAudience} must rewrite it on read AND persist the healed
 * value — otherwise every identity refresh keeps requesting a dead audience.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getForwardingAudience, setForwardingAudience} from './connection';

const KEY = 'openbook.forwarding.audience';

/** A minimal localStorage for the node test environment. */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe('getForwardingAudience — stale book.pub → book.cloud heal', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = stubLocalStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns null when nothing is recorded', () => {
    expect(getForwardingAudience()).toBeNull();
  });

  it('round-trips a current *.book.cloud audience untouched', () => {
    setForwardingAudience('demo-xyz.book.cloud');
    expect(getForwardingAudience()).toBe('demo-xyz.book.cloud');
    expect(store.get(KEY)).toBe('demo-xyz.book.cloud');
  });

  it('heals a stale <prefix>.book.pub audience to <prefix>.book.cloud and writes it back', () => {
    store.set(KEY, 'demo-xyz.book.pub'); // persisted before the root migration
    expect(getForwardingAudience()).toBe('demo-xyz.book.cloud');
    // The heal is persisted, not just returned — the next read needs no rewrite.
    expect(store.get(KEY)).toBe('demo-xyz.book.cloud');
    expect(getForwardingAudience()).toBe('demo-xyz.book.cloud');
  });

  it('leaves non-book.pub hosts (self-hosted audiences) alone', () => {
    store.set(KEY, 'books.example.com');
    expect(getForwardingAudience()).toBe('books.example.com');
    expect(store.get(KEY)).toBe('books.example.com');
  });

  it('clearing with null removes the record', () => {
    setForwardingAudience('demo-xyz.book.cloud');
    setForwardingAudience(null);
    expect(getForwardingAudience()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });
});
