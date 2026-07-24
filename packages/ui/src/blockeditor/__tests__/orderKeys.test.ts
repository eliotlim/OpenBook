import {describe, it, expect} from 'vitest';
import {compareOrderKeys, isOrderKey, keyBetween, keysBetween, ORDER_KEY_REBALANCE_LENGTH} from '../orderKeys';

describe('orderKeys — fractional order keys', () => {
  it('produces a key strictly between its bounds, for every bound shape', () => {
    const first = keyBetween(null, null);
    expect(isOrderKey(first)).toBe(true);

    const before = keyBetween(null, first);
    const after = keyBetween(first, null);
    expect(before < first).toBe(true);
    expect(first < after).toBe(true);

    const mid = keyBetween(before, after);
    expect(before < mid && mid < after).toBe(true);
    for (const k of [first, before, after, mid]) expect(isOrderKey(k)).toBe(true);
  });

  it('orders by plain string comparison (the whole comparator)', () => {
    expect(compareOrderKeys('G', 'V')).toBe(-1);
    expect(compareOrderKeys('V', 'G')).toBe(1);
    expect(compareOrderKeys('V', 'V')).toBe(0);
    // Base-62 digit order matches ASCII order: 0-9 < A-Z < a-z.
    expect(compareOrderKeys('9', 'A')).toBe(-1);
    expect(compareOrderKeys('Z', 'a')).toBe(-1);
  });

  it('rejects malformed keys and inverted bounds', () => {
    expect(() => keyBetween('V', 'G')).toThrow(RangeError); // a >= b
    expect(() => keyBetween('V', 'V')).toThrow(RangeError);
    expect(() => keyBetween('A0', null)).toThrow(RangeError); // trailing zero
    expect(() => keyBetween('', null)).toThrow(RangeError); // empty
    expect(() => keyBetween('a!b', null)).toThrow(RangeError); // bad alphabet
    expect(isOrderKey('0')).toBe(false);
    expect(isOrderKey('0V')).toBe(true); // leading zero digit is fine
  });

  it('midpoint density: repeated insertion into the SAME gap always fits', () => {
    // Worst case for precision — always split the same gap, 200 times.
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    let prev = lo;
    for (let i = 0; i < 200; i += 1) {
      const mid = keyBetween(prev, hi);
      expect(prev < mid && mid < hi).toBe(true);
      expect(isOrderKey(mid)).toBe(true);
      prev = mid;
    }
    // And the mirror image: always split toward the lower bound.
    prev = hi;
    for (let i = 0; i < 200; i += 1) {
      const mid = keyBetween(lo, prev);
      expect(lo < mid && mid < prev).toBe(true);
      prev = mid;
    }
  });

  it('precision at 50+ repeated moves: keys stay short (well under the rebalance limit)', () => {
    // Simulates 60 alternating "move between the same two neighbours" ops —
    // the TBL-2 drag pattern that stresses key growth.
    let a = keyBetween(null, null);
    let b = keyBetween(a, null);
    let longest = 0;
    for (let i = 0; i < 60; i += 1) {
      const k = keyBetween(a, b);
      longest = Math.max(longest, k.length);
      if (i % 2 === 0) a = k;
      else b = k;
    }
    // ~1 char per ~5 splits — 60 moves stay far below the rebalance trigger,
    // so real tables essentially never rebalance.
    expect(longest).toBeLessThan(20);
    expect(longest).toBeLessThan(ORDER_KEY_REBALANCE_LENGTH);
  });

  it('sequential appends and prepends grow logarithmically, not linearly', () => {
    let last = keyBetween(null, null);
    for (let i = 0; i < 100; i += 1) last = keyBetween(last, null);
    expect(last.length).toBeLessThan(25);
    let first = keyBetween(null, null);
    for (let i = 0; i < 100; i += 1) first = keyBetween(null, first);
    expect(first.length).toBeLessThan(25);
  });

  it('keysBetween spreads n ascending unique keys, deterministically', () => {
    for (const n of [1, 2, 3, 7, 26, 100]) {
      const keys = keysBetween(null, null, n);
      expect(keys).toHaveLength(n);
      for (let i = 1; i < keys.length; i += 1) expect(keys[i - 1] < keys[i]).toBe(true);
      for (const k of keys) expect(isOrderKey(k)).toBe(true);
      // Determinism — two peers migrating the same table write identical keys.
      expect(keysBetween(null, null, n)).toEqual(keys);
      // Balanced subdivision keeps keys short.
      expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(Math.ceil(Math.log2(n + 1)) + 1);
    }
    expect(keysBetween(null, null, 0)).toEqual([]);
  });

  it('keysBetween respects explicit bounds', () => {
    const [lo, hi] = ['G', 'W'];
    const keys = keysBetween(lo, hi, 9);
    for (const k of keys) expect(lo < k && k < hi).toBe(true);
    for (let i = 1; i < keys.length; i += 1) expect(keys[i - 1] < keys[i]).toBe(true);
  });
});
