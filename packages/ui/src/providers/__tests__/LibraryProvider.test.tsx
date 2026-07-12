import React from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {renderHook, cleanup} from '@testing-library/react';
import {LibraryProvider, useLibrary, LIBRARIES_KEY, LEGACY_LIBRARIES_KEY} from '../LibraryProvider';

const wrapper = ({children}: {children: React.ReactNode}) => <LibraryProvider>{children}</LibraryProvider>;

describe('LibraryProvider — openbook.workspaces → openbook.libraries migration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('migrates a list saved under the legacy key when the new key is absent', () => {
    // A pre-rename install: the list lives under `openbook.workspaces` only.
    const saved = [{id: 'ws-acme', icon: '📗', name: 'Acme Corp', serverUrl: null}];
    localStorage.setItem(LEGACY_LIBRARIES_KEY, JSON.stringify(saved));

    const {result} = renderHook(() => useLibrary(), {wrapper});

    // The saved data is loaded (not the bare default).
    expect(result.current.libraries).toEqual(saved);

    // …and re-persisted under the new key, with the old key removed.
    expect(JSON.parse(localStorage.getItem(LIBRARIES_KEY) ?? '[]')).toEqual(saved);
    expect(localStorage.getItem(LEGACY_LIBRARIES_KEY)).toBeNull();
  });

  it('prefers the new key and ignores the legacy key (no clobber)', () => {
    const current = [{id: 'lib-new', icon: '📘', name: 'Current', serverUrl: null}];
    const legacy = [{id: 'lib-old', icon: '📙', name: 'Stale', serverUrl: null}];
    localStorage.setItem(LIBRARIES_KEY, JSON.stringify(current));
    localStorage.setItem(LEGACY_LIBRARIES_KEY, JSON.stringify(legacy));

    const {result} = renderHook(() => useLibrary(), {wrapper});

    // The new key wins; the legacy list is never adopted.
    expect(result.current.libraries).toEqual(current);
    expect(result.current.libraries.some((l) => l.id === 'lib-old')).toBe(false);

    // The new key is not clobbered, and the untouched legacy key is left as-is
    // (migration only runs when the new key is absent).
    expect(JSON.parse(localStorage.getItem(LIBRARIES_KEY) ?? '[]')).toEqual(current);
    expect(JSON.parse(localStorage.getItem(LEGACY_LIBRARIES_KEY) ?? '[]')).toEqual(legacy);
  });

  it('falls back to the default local library when neither key is present', () => {
    const {result} = renderHook(() => useLibrary(), {wrapper});

    expect(result.current.libraries).toHaveLength(1);
    expect(result.current.libraries[0].id).toBe('local');
    expect(result.current.libraries[0].serverUrl).toBeNull();
    expect(localStorage.getItem(LEGACY_LIBRARIES_KEY)).toBeNull();
  });

  it('falls back to the default (without throwing) when the legacy value is malformed', () => {
    localStorage.setItem(LEGACY_LIBRARIES_KEY, '{not valid json');

    // Must not throw while hydrating from a corrupt legacy blob.
    const {result} = renderHook(() => useLibrary(), {wrapper});

    expect(result.current.libraries).toHaveLength(1);
    expect(result.current.libraries[0].id).toBe('local');
    expect(result.current.libraries[0].serverUrl).toBeNull();
  });
});
