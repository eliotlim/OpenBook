import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import {throttle} from '@/lib/throttle';

/**
 * The rate-limiter behind the local caret broadcast (Collab T5): the first move
 * fires at once (live feel), a burst is coalesced to ~10Hz, the final resting
 * position is never dropped (trailing call), and a blur can cancel the pending
 * trailing call so the caret clears immediately.
 */
describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('invokes on the leading edge immediately', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('a');
  });

  it('coalesces a burst to one trailing call carrying the latest args', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a'); // leading
    t('b');
    t('c'); // only this (the latest) should survive the window
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('c');
  });

  it('allows the next leading call once the window has elapsed', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a');
    vi.advanceTimersByTime(101);
    t('b');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('b');
  });

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t('a'); // leading
    t('b'); // queued trailing
    t.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1); // only the leading 'a' ever fired
  });
});
