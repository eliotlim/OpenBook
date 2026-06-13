import {describe, it, expect} from 'vitest';
import {pageSaveStatus, setPageSaveStatus, subscribePageSaveStatus, pageSaveStatusVersion} from '../pageSaveStatus';

describe('pageSaveStatus', () => {
  it('defaults to idle and round-trips per page', () => {
    expect(pageSaveStatus('p1')).toBe('idle');
    setPageSaveStatus('p1', 'saving');
    expect(pageSaveStatus('p1')).toBe('saving');
    setPageSaveStatus('p1', 'saved');
    expect(pageSaveStatus('p1')).toBe('saved');
  });

  it('keeps pages independent and clears on null', () => {
    setPageSaveStatus('a', 'saving');
    setPageSaveStatus('b', 'save failed');
    expect(pageSaveStatus('a')).toBe('saving');
    expect(pageSaveStatus('b')).toBe('save failed');
    setPageSaveStatus('a', null);
    expect(pageSaveStatus('a')).toBe('idle');
  });

  it('notifies subscribers and bumps the version', () => {
    let hits = 0;
    const before = pageSaveStatusVersion();
    const unsub = subscribePageSaveStatus(() => (hits += 1));
    setPageSaveStatus('p2', 'saving');
    expect(hits).toBe(1);
    expect(pageSaveStatusVersion()).toBeGreaterThan(before);
    unsub();
    setPageSaveStatus('p2', 'saved');
    expect(hits).toBe(1); // no longer notified
  });

  it('ignores a null page id', () => {
    expect(() => setPageSaveStatus(null, 'saving')).not.toThrow();
    expect(pageSaveStatus(null)).toBe('idle');
  });
});
