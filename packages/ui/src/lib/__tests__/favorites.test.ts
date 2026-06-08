import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  isFavorite,
  readFavorites,
  removeFavorite,
  subscribeFavorites,
  toggleFavorite,
  toggleFavoriteId,
} from '../favorites';

describe('toggleFavoriteId (pure)', () => {
  it('adds an absent id to the front (newest pinned first)', () => {
    expect(toggleFavoriteId(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('removes a present id', () => {
    expect(toggleFavoriteId(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('round-trips to original membership when toggled twice', () => {
    const once = toggleFavoriteId(['a'], 'b');
    expect(toggleFavoriteId(once, 'b')).toEqual(['a']);
  });
});

describe('favorites store (localStorage-backed)', () => {
  beforeEach(() => localStorage.clear());

  it('persists toggles and reports membership', () => {
    expect(readFavorites()).toEqual([]);
    toggleFavorite('p1');
    expect(isFavorite('p1')).toBe(true);
    expect(readFavorites()).toEqual(['p1']);
    toggleFavorite('p1');
    expect(isFavorite('p1')).toBe(false);
  });

  it('removeFavorite drops an id and is a no-op when absent', () => {
    toggleFavorite('p1');
    toggleFavorite('p2');
    removeFavorite('p1');
    expect(readFavorites()).toEqual(['p2']);
    removeFavorite('missing'); // no throw, no change
    expect(readFavorites()).toEqual(['p2']);
  });

  it('notifies subscribers on change', () => {
    const cb = vi.fn();
    const unsub = subscribeFavorites(cb);
    toggleFavorite('p1');
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    toggleFavorite('p2');
    expect(cb).toHaveBeenCalledTimes(1); // not called after unsubscribe
  });
});
