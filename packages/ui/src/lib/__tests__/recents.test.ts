import {beforeEach, describe, expect, it} from 'vitest';
import {readRecents, recordRecent, recordRecentId} from '../recents';

describe('recordRecentId (pure)', () => {
  it('prepends a new id', () => {
    expect(recordRecentId(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('moves an existing id to the front (deduped)', () => {
    expect(recordRecentId(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('caps the list to max, dropping the oldest', () => {
    expect(recordRecentId(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('keeps a stable list when re-recording the current front', () => {
    expect(recordRecentId(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });
});

describe('recents store (localStorage-backed)', () => {
  beforeEach(() => localStorage.clear());

  it('records visits most-recent first', () => {
    recordRecent('p1');
    recordRecent('p2');
    recordRecent('p1');
    expect(readRecents()).toEqual(['p1', 'p2']);
  });
});
