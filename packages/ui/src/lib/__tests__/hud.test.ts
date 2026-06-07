import {describe, it, expect} from 'vitest';
import {
  normalizeTab,
  isSettingsTab,
  SETTINGS_TABS,
  SETTINGS_SECTIONS,
  DEFAULT_SETTINGS_TAB,
  loadHudStorage,
  HUD_STORAGE_KEY,
} from '../hud';

describe('normalizeTab', () => {
  it('maps renamed legacy ids to their current tabs', () => {
    expect(normalizeTab('server')).toBe('connection');
    expect(normalizeTab('backup')).toBe('admin');
  });

  it('passes a current tab through unchanged', () => {
    expect(normalizeTab('general')).toBe('general');
    expect(normalizeTab('admin')).toBe('admin');
  });

  it('falls back to the default tab for unknown or non-string values', () => {
    expect(normalizeTab('nope')).toBe(DEFAULT_SETTINGS_TAB);
    expect(normalizeTab(undefined)).toBe(DEFAULT_SETTINGS_TAB);
    expect(normalizeTab(42)).toBe(DEFAULT_SETTINGS_TAB);
  });
});

describe('settings sections', () => {
  it('derives the flat tab list from the sections, in order', () => {
    expect(SETTINGS_TABS).toEqual(SETTINGS_SECTIONS.flatMap((s) => s.tabs));
    expect(SETTINGS_TABS[0]).toBe(DEFAULT_SETTINGS_TAB);
  });

  it('every section tab is a recognised settings tab', () => {
    for (const section of SETTINGS_SECTIONS) {
      for (const tab of section.tabs) expect(isSettingsTab(tab)).toBe(true);
    }
  });
});

describe('loadHudStorage', () => {
  it('normalizes a persisted legacy tab on load', () => {
    localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify({settings: {tab: 'server'}}));
    expect(loadHudStorage().settings.tab).toBe('connection');
    localStorage.clear();
  });
});
