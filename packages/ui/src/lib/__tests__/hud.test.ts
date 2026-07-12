import {describe, it, expect} from 'vitest';
import {
  normalizeTab,
  isSettingsTab,
  isTabParam,
  SETTINGS_TABS,
  SETTINGS_SECTIONS,
  SETTINGS_ALIAS_SECTIONS,
  SETTINGS_SECTION_PEOPLE,
  DEFAULT_SETTINGS_TAB,
  loadHudStorage,
  HUD_STORAGE_KEY,
} from '../hud';

describe('normalizeTab', () => {
  it('maps renamed legacy ids to their current tabs', () => {
    expect(normalizeTab('server')).toBe('connection');
    expect(normalizeTab('backup')).toBe('admin');
  });

  it('folds the retired Members tab into Sharing (SHR-5)', () => {
    expect(normalizeTab('members')).toBe('sharing');
    // No standalone `members` tab remains in the rail.
    expect(isSettingsTab('members')).toBe(false);
    expect(SETTINGS_TABS).not.toContain('members');
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

describe('isTabParam', () => {
  it('accepts real tabs and known legacy aliases, rejects strays', () => {
    expect(isTabParam('sharing')).toBe(true);
    expect(isTabParam('members')).toBe(true); // legacy alias → Sharing
    expect(isTabParam('nope')).toBe(false);
    expect(isTabParam(undefined)).toBe(false);
  });
});

describe('alias sections', () => {
  it('routes the members deep-link to the Sharing tab People section', () => {
    expect(SETTINGS_ALIAS_SECTIONS.members).toBe(SETTINGS_SECTION_PEOPLE);
  });
});

describe('loadHudStorage', () => {
  it('normalizes a persisted legacy tab on load', () => {
    localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify({settings: {tab: 'server'}}));
    expect(loadHudStorage().settings.tab).toBe('connection');
    localStorage.clear();
  });

  it('never restores a stale in-tab scroll target', () => {
    localStorage.setItem(HUD_STORAGE_KEY, JSON.stringify({settings: {tab: 'sharing', section: 'settings-people'}}));
    expect(loadHudStorage().settings.section).toBeNull();
    localStorage.clear();
  });
});
