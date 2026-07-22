import {describe, it, expect, beforeEach} from 'vitest';
import {markPageCrashed, readCrashedPages, isPageCrashed, clearCrashedPage} from '../crashRecovery';

describe('crashRecovery', () => {
  beforeEach(() => sessionStorage.clear());

  it('starts with nothing quarantined', () => {
    expect(readCrashedPages().size).toBe(0);
    expect(isPageCrashed('p1')).toBe(false);
  });

  it('quarantines a crashed page (survives a reload — sessionStorage)', () => {
    markPageCrashed('p1');
    expect(isPageCrashed('p1')).toBe(true);
    // A fresh read (as a reload would do) still sees it.
    expect(readCrashedPages().has('p1')).toBe(true);
  });

  it('accumulates multiple crashed pages without duplicating', () => {
    markPageCrashed('p1');
    markPageCrashed('p2');
    markPageCrashed('p1');
    expect([...readCrashedPages()].sort()).toEqual(['p1', 'p2']);
  });

  it('ignores empty ids', () => {
    markPageCrashed('');
    expect(readCrashedPages().size).toBe(0);
  });

  it('clears one page or all', () => {
    markPageCrashed('p1');
    markPageCrashed('p2');
    clearCrashedPage('p1');
    expect(isPageCrashed('p1')).toBe(false);
    expect(isPageCrashed('p2')).toBe(true);
    clearCrashedPage();
    expect(readCrashedPages().size).toBe(0);
  });

  it('tolerates corrupt storage', () => {
    sessionStorage.setItem('openbook.crashedPageIds', '{not json');
    expect(readCrashedPages().size).toBe(0);
    markPageCrashed('p1'); // overwrites the corrupt value
    expect(isPageCrashed('p1')).toBe(true);
  });
});
