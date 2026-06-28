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

  it('compares plain objects structurally (deep, key-order-insensitive)', () => {
    // The `location` input publishes `{lat,lng,label}`; a fresh object each render.
    expect(valueEqual({lat: 1, lng: 2, label: 'Home'}, {lat: 1, lng: 2, label: 'Home'})).toBe(true);
    expect(valueEqual({lat: null, lng: null, label: ''}, {lat: null, lng: null, label: ''})).toBe(true);
    expect(valueEqual({a: 1, b: 2}, {b: 2, a: 1})).toBe(true); // key order insensitive
    expect(valueEqual({lat: 1, lng: 2, label: 'x'}, {lat: 1, lng: 3, label: 'x'})).toBe(false);
    expect(valueEqual({a: 1}, {a: 1, b: 2})).toBe(false); // extra key
    expect(valueEqual({a: 1, b: undefined}, {a: 1})).toBe(false); // differing key set
    // nested objects + arrays
    expect(valueEqual({a: {b: [1, 2]}}, {a: {b: [1, 2]}})).toBe(true);
    expect(valueEqual({a: {b: [1, 2]}}, {a: {b: [1, 3]}})).toBe(false);
    expect(valueEqual([{x: 1}], [{x: 1}])).toBe(true); // array of objects
    expect(valueEqual([{x: 1}], [{x: 2}])).toBe(false);
    // a scalar vs an object is never equal
    expect(valueEqual({a: 1}, 1)).toBe(false);
    expect(valueEqual({a: 1}, null)).toBe(false);
  });

  it('GUARD: structurally-equal objects are equal (would fail on the old ===-only object path)', () => {
    // Pre-fix, valueEqual returned false for ANY two distinct object references.
    // That made a synced group with an object-valued input (location) always
    // report "changed", driving a publish↔adopt ping-pong + page-save churn.
    // This assertion is `false` on the old code and `true` after the fix.
    expect(valueEqual({lat: 1, lng: 2, label: 'Home'}, {lat: 1, lng: 2, label: 'Home'})).toBe(true);
  });

  it('GUARD: republishing a structurally-equal object value no-ops (no notify/localStorage churn)', () => {
    const key = `k${Math.random().toString(36).slice(2)}`;
    const cb = vi.fn();
    const unsub = subscribeGroupSync(key, cb);
    // Mirror the GroupView publish effect: a fresh location object each "edit".
    const place = (): Record<string, unknown> => ({lat: 1, lng: 2, label: 'Home'});

    expect(writeGroupSync(key, {place: place()})).toBe(true); // first publish — a real change
    // Re-publishing the same structural value must NOT churn the store/subscribers.
    expect(writeGroupSync(key, {place: place()})).toBe(false);
    expect(writeGroupSync(key, {place: place()})).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1); // exactly one notify, not one-per-edit

    // A genuine change to the object still publishes + notifies.
    expect(writeGroupSync(key, {place: {lat: 1, lng: 9, label: 'Home'}})).toBe(true);
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
  });
});
