import {describe, it, expect} from 'vitest';
import {
  applyTheme,
  getTheme,
  themes,
  DEFAULT_THEME_ID,
  DEFAULT_APPEARANCE,
  composeAppearance,
  mergeAppearance,
  normalizeAppearance,
} from '../themes';

const satOf = (triple: string): number => Number(triple.replace(/%/g, '').split(/\s+/)[1]);
const hueOf = (triple: string): number => Number(triple.split(/\s+/)[0]);

describe('themes', () => {
  it('has the Default theme first and resolves by id', () => {
    expect(themes[0].id).toBe(DEFAULT_THEME_ID);
    expect(getTheme('forest').light.primary).toBe('142 71% 38%');
  });

  it('falls back to Default for an unknown id', () => {
    expect(getTheme('nope').id).toBe(DEFAULT_THEME_ID);
  });

  it('keeps the warm neutral base while swapping the accent', () => {
    const forest = getTheme('forest');
    // accent changes…
    expect(forest.light.primary).not.toBe(themes[0].light.primary);
    // …but the background neutral is shared with Default.
    expect(forest.light.background).toBe(themes[0].light.background);
  });

  it('applyTheme writes the palette onto documentElement as CSS vars', () => {
    applyTheme(getTheme('ocean'), 'light');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--primary')).toBe('221 83% 53%');
    expect(root.style.getPropertyValue('--brand-subtle')).toBe('221 86% 95%');

    applyTheme(getTheme('default'), 'dark');
    expect(root.style.getPropertyValue('--primary')).toBe('207 68% 55%');
  });
});

describe('composeAppearance', () => {
  it('reproduces the legacy light palette at the defaults (no-op)', () => {
    const t = composeAppearance(DEFAULT_APPEARANCE, 'light');
    expect(t.muted).toBe('40 9% 96%');
    expect(t.secondary).toBe('40 9% 96%');
    expect(t.border).toBe('40 8% 90%');
    expect(t.input).toBe('40 8% 87%');
    expect(t.accent).toBe('40 12% 93%');
    expect(t.sheet1).toBe('40 14% 97.5%');
    expect(t.sheet2).toBe('40 11% 93.5%');
    expect(t.primary).toBe('207 75% 49%');
    // The canvas stays white (saturation 0 reads identical to the old `0 0% 100%`).
    expect(satOf(t.background)).toBe(0);
  });

  it('keeps the dark surfaces neutral at the defaults', () => {
    const t = composeAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(satOf(t.muted)).toBe(0);
    expect(satOf(t.accent)).toBe(0);
    expect(satOf(t.background)).toBe(0);
    expect(t.primary).toBe('207 68% 55%');
  });

  it('"cool" swings the neutral surfaces to a cool hue', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, neutral: 'cool'}, 'light');
    expect(hueOf(t.muted)).toBe(220); // cool, not warm 40
    expect(satOf(t.muted)).toBeGreaterThan(0);
  });

  it('"neutral" fully desaturates the surfaces (true gray)', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, neutral: 'neutral', interfaceIntensity: 3}, 'light');
    expect(satOf(t.muted)).toBe(0);
    expect(satOf(t.sheet1)).toBe(0);
    expect(satOf(t.accent)).toBe(0);
  });

  it('interface intensity scales the surface saturation', () => {
    const off = composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 0}, 'light');
    const strong = composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 3}, 'light');
    expect(satOf(off.muted)).toBe(0);
    expect(satOf(strong.muted)).toBeGreaterThan(satOf(composeAppearance(DEFAULT_APPEARANCE, 'light').muted));
  });

  it('control intensity scales --accent (0 = neutral)', () => {
    const soft = composeAppearance({...DEFAULT_APPEARANCE, controlIntensity: 0}, 'light');
    const vivid = composeAppearance({...DEFAULT_APPEARANCE, controlIntensity: 3}, 'light');
    expect(satOf(soft.accent)).toBe(0);
    expect(satOf(vivid.accent)).toBeGreaterThan(12);
  });

  it('a tinted sidebar adopts the accent hue', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'ocean', tintedSidebar: true}, 'light');
    expect(hueOf(t.sheet1)).toBe(221); // ocean's hue
    expect(satOf(t.sheet1)).toBeGreaterThan(0);
  });
});

describe('mergeAppearance', () => {
  it('overlays only the provided keys and ignores undefined', () => {
    const merged = mergeAppearance(DEFAULT_APPEARANCE, {neutral: 'cool', interfaceIntensity: undefined});
    expect(merged.neutral).toBe('cool');
    expect(merged.interfaceIntensity).toBe(DEFAULT_APPEARANCE.interfaceIntensity);
    expect(merged.themeId).toBe(DEFAULT_APPEARANCE.themeId);
  });

  it('returns the base unchanged for a null override', () => {
    expect(mergeAppearance(DEFAULT_APPEARANCE, null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('normalizeAppearance (migration)', () => {
  it('maps the old tint / accentIntensity / neutral keys to the new model', () => {
    const out = normalizeAppearance({tint: 3, accentIntensity: 1, neutral: 'gray'});
    expect(out).toEqual({interfaceIntensity: 3, controlIntensity: 1, neutral: 'neutral'});
    expect(normalizeAppearance({neutral: 'match'}).neutral).toBe('warm');
  });

  it('leaves an already-current override untouched', () => {
    const cur = {neutral: 'cool', interfaceIntensity: 1, controlIntensity: 2};
    expect(normalizeAppearance(cur)).toEqual(cur);
  });
});
