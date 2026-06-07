import React from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {renderHook, act, cleanup} from '@testing-library/react';
import {
  PreferencesProvider,
  usePreferences,
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
} from '../PreferencesProvider';

const wrapper = ({children}: {children: React.ReactNode}) => <PreferencesProvider>{children}</PreferencesProvider>;

describe('PreferencesProvider', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('starts from the defaults when nothing is stored', () => {
    const {result} = renderHook(() => usePreferences(), {wrapper});
    expect(result.current.preferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('update() merges within a section and persists', () => {
    const {result} = renderHook(() => usePreferences(), {wrapper});
    act(() => result.current.update({general: {spellcheck: false}}));

    expect(result.current.preferences.general.spellcheck).toBe(false);
    // The sibling key in the same section is preserved.
    expect(result.current.preferences.general.confirmOnTrash).toBe(true);

    const stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}');
    expect(stored.general.spellcheck).toBe(false);
  });

  it('adopts stored values after mount, merged over the defaults', () => {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({profile: {name: 'Ada'}}));
    const {result} = renderHook(() => usePreferences(), {wrapper});

    expect(result.current.preferences.profile.name).toBe('Ada');
    // A key absent from storage falls back to its default (forward-compatible).
    expect(result.current.preferences.profile.avatar).toBe(DEFAULT_PREFERENCES.profile.avatar);
    expect(result.current.preferences.general.confirmOnTrash).toBe(true);
  });
});
