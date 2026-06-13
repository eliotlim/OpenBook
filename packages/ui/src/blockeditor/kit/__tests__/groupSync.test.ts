import {afterEach, describe, expect, it, vi} from 'vitest';
import {readGroupSync, subscribeGroupSync, valueEqual, writeGroupSync} from '../groupSync';

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

describe('groupSync bridge', () => {
  it('writes, merges, and reads shared values', () => {
    const key = `k${Math.random().toString(36).slice(2)}`;
    expect(readGroupSync(key)).toEqual({});
    expect(writeGroupSync(key, {a: 1})).toBe(true);
    expect(writeGroupSync(key, {b: 2})).toBe(true); // merges
    expect(readGroupSync(key)).toEqual({a: 1, b: 2});
  });

  it('no-ops (returns false) when nothing changes — so adopted values never echo', () => {
    const key = `k${Math.random().toString(36).slice(2)}`;
    writeGroupSync(key, {a: 1, list: ['x', 'y']});
    expect(writeGroupSync(key, {a: 1})).toBe(false);
    expect(writeGroupSync(key, {list: ['x', 'y']})).toBe(false); // array value-equality
    expect(writeGroupSync(key, {a: 2})).toBe(true);
  });

  it('notifies subscribers on a real change only', () => {
    const key = `k${Math.random().toString(36).slice(2)}`;
    const cb = vi.fn();
    const unsub = subscribeGroupSync(key, cb);
    writeGroupSync(key, {a: 1});
    writeGroupSync(key, {a: 1}); // no-op
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    writeGroupSync(key, {a: 9});
    expect(cb).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it('compares scalars and arrays for equality', () => {
    expect(valueEqual(1, 1)).toBe(true);
    expect(valueEqual('a', 'a')).toBe(true);
    expect(valueEqual([1, 2], [1, 2])).toBe(true);
    expect(valueEqual([1, 2], [1, 3])).toBe(false);
    expect(valueEqual(1, 2)).toBe(false);
  });
});
