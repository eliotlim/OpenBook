import {describe, it, expect} from 'vitest';
import {
  SETTINGS_SEARCH_INDEX,
  filterSettingsIndex,
  settingsKeywordsForTab,
} from '@/lib/settingsIndex';
import {SETTINGS_TABS} from '@/lib/hud';
import type {TKey} from '@/i18n';

// A tiny translator: return the key itself, except spell out a couple of labels
// so we can assert matching on the *translated* text (not just keys/keywords).
const t = (key: TKey): string => {
  const map: Record<string, string> = {
    'customisation.blockShortcuts': 'Block editing',
    'ai.title': 'AI',
    'agents.title': 'Agent access',
  };
  return map[key] ?? key;
};

describe('settingsIndex', () => {
  it('every entry points at a known settings tab', () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(SETTINGS_TABS).toContain(entry.tab);
      expect(entry.sectionId.length).toBeGreaterThan(0);
    }
  });

  it('empty query yields no rows', () => {
    expect(filterSettingsIndex('', t, {includeAgents: true})).toEqual([]);
    expect(filterSettingsIndex('   ', t, {includeAgents: true})).toEqual([]);
  });

  it('matches on translated label text (case-insensitive)', () => {
    const rows = filterSettingsIndex('block editing', t, {includeAgents: true});
    expect(rows.some((r) => r.labelKey === 'customisation.blockShortcuts')).toBe(true);
  });

  it('matches on raw keywords a natural query would use', () => {
    // "backup" is only in the admin entry's keywords, not its translated label.
    const rows = filterSettingsIndex('backup', t, {includeAgents: true});
    expect(rows.some((r) => r.tab === 'admin')).toBe(true);
  });

  it('requires every token to match (AND semantics)', () => {
    const rows = filterSettingsIndex('block nonsensetoken', t, {includeAgents: true});
    expect(rows).toEqual([]);
  });

  it('hides admin-only (agents) sections for a non-admin', () => {
    const asAdmin = filterSettingsIndex('mcp', t, {includeAgents: true});
    expect(asAdmin.some((r) => r.tab === 'agents')).toBe(true);
    const asViewer = filterSettingsIndex('mcp', t, {includeAgents: false});
    expect(asViewer.some((r) => r.tab === 'agents')).toBe(false);
  });

  it('joins per-tab keywords for the command palette', () => {
    // The palette deep link consumes this; it should carry the folded synonyms.
    expect(settingsKeywordsForTab('libraries')).toContain('server');
    expect(settingsKeywordsForTab('signin')).toContain('login');
    // A tab with no index entry returns an empty blob (no throw).
    expect(typeof settingsKeywordsForTab('general')).toBe('string');
  });
});
