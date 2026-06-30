import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import {createSelectionReporter} from '../localSelection';

/**
 * Collab T5 — the local caret reporter. The point of the shared `clear` (vs a
 * separate blur path) is that it cancels a still-pending trailing emit: a caret
 * move <100ms before a blur must NOT fire its throttled trailing AFTER the null,
 * or a stale peer caret would linger. This pins exactly that ordering.
 */
describe('createSelectionReporter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits the live caret on the leading edge', () => {
    const report = vi.fn();
    const r = createSelectionReporter(report);
    r.emit({blockId: 'b', anchor: 1, head: 1});
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith({blockId: 'b', anchor: 1, head: 1});
  });

  it('clear() cancels a pending trailing emit, so null is the LAST thing peers see', () => {
    const report = vi.fn();
    const r = createSelectionReporter(report);
    r.emit({blockId: 'b', anchor: 1, head: 1}); // leading fires now
    r.emit({blockId: 'b', anchor: 5, head: 5}); // queued as the trailing emit
    r.clear(); // blur backstop: cancel the trailing + publish null
    vi.advanceTimersByTime(500); // the cancelled trailing must never arrive
    expect(report.mock.calls.map((c) => c[0])).toEqual([{blockId: 'b', anchor: 1, head: 1}, null]);
  });
});
