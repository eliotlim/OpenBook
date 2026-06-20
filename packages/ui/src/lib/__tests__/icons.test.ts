import {describe, it, expect} from 'vitest';
import {LUCIDE_PREFIX, isLucideIcon, pageIconToText} from '../iconValue';
import {LUCIDE_ICONS, LUCIDE_ICON_NAMES, lucideIconFor} from '../lucideIcons';

describe('iconValue helpers', () => {
  it('detects lucide refs vs emoji glyphs', () => {
    expect(isLucideIcon('lucide:Heart')).toBe(true);
    expect(isLucideIcon('📄')).toBe(false);
    expect(isLucideIcon('')).toBe(false);
    expect(isLucideIcon(null)).toBe(false);
    expect(isLucideIcon(undefined)).toBe(false);
  });

  it('renders emoji to text and collapses lucide refs (never leaks the ref)', () => {
    expect(pageIconToText('📄')).toBe('📄');
    expect(pageIconToText('lucide:Heart')).toBe('');
    expect(pageIconToText('')).toBe('');
    expect(pageIconToText(undefined)).toBe('');
  });
});

describe('lucide registry', () => {
  it('exposes a non-empty, de-duplicated curated set', () => {
    expect(LUCIDE_ICON_NAMES.length).toBeGreaterThan(100);
    expect(new Set(LUCIDE_ICON_NAMES).size).toBe(LUCIDE_ICON_NAMES.length);
  });

  it('every curated name resolves to a component', () => {
    for (const name of LUCIDE_ICON_NAMES) {
      expect(typeof LUCIDE_ICONS[name]).toBe('object'); // forwardRef component
    }
  });

  it('resolves a value with or without the prefix, and null for unknowns', () => {
    expect(lucideIconFor(`${LUCIDE_PREFIX}Heart`)).toBe(LUCIDE_ICONS.Heart);
    expect(lucideIconFor('Heart')).toBe(LUCIDE_ICONS.Heart);
    expect(lucideIconFor('lucide:NotARealIcon')).toBeNull();
  });

  it('keeps the renamed Infinity icon under its lucide name', () => {
    expect(lucideIconFor('lucide:Infinity')).toBe(LUCIDE_ICONS.Infinity);
  });
});
