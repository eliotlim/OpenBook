import {beforeEach, describe, it, expect} from 'vitest';
import {DEFAULT_APPEARANCE} from '../themes';
import {composePageAppearance, hasPageTheme, readPageTheme, writePageTheme} from '../pageTheme';

describe('pageTheme storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips an override and reports presence', () => {
    expect(readPageTheme('p1')).toBeNull();
    expect(hasPageTheme('p1')).toBe(false);

    writePageTheme('p1', {themeId: 'rose'});
    expect(readPageTheme('p1')).toEqual({themeId: 'rose'});
    expect(hasPageTheme('p1')).toBe(true);
  });

  it('clears the override when written null or empty', () => {
    writePageTheme('p1', {themeId: 'rose'});
    writePageTheme('p1', null);
    expect(readPageTheme('p1')).toBeNull();
    expect(hasPageTheme('p1')).toBe(false);

    writePageTheme('p1', {themeId: 'rose'});
    writePageTheme('p1', {});
    expect(readPageTheme('p1')).toBeNull();
  });

  it('keeps per-page overrides independent', () => {
    writePageTheme('a', {themeId: 'ocean'});
    writePageTheme('b', {neutral: 'cool'});
    expect(readPageTheme('a')).toEqual({themeId: 'ocean'});
    expect(readPageTheme('b')).toEqual({neutral: 'cool'});
  });
});

describe('composePageAppearance', () => {
  it('returns undefined when there is no override', () => {
    expect(composePageAppearance(DEFAULT_APPEARANCE, null, 'light')).toBeUndefined();
    expect(composePageAppearance(DEFAULT_APPEARANCE, {}, 'light')).toBeUndefined();
  });

  it('composes scoped CSS vars from the merged appearance', () => {
    const style = composePageAppearance(DEFAULT_APPEARANCE, {themeId: 'forest'}, 'light');
    expect(style).toBeDefined();
    // The page's primary follows its override, not the app default.
    expect(style!['--primary']).toBe('142 71% 38%');
  });
});
