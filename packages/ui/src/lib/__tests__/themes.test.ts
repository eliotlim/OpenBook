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
  it('reproduces the legacy content surfaces at the defaults', () => {
    const t = composeAppearance(DEFAULT_APPEARANCE, 'light');
    expect(t.muted).toBe('40 9% 96%');
    expect(t.secondary).toBe('40 9% 96%');
    expect(t.border).toBe('40 8% 90%');
    expect(t.input).toBe('40 8% 87%');
    expect(t.accent).toBe('40 12% 93%');
    expect(t.primary).toBe('207 75% 49%');
    // The canvas stays white (saturation 0 reads identical to the old `0 0% 100%`).
    expect(satOf(t.background)).toBe(0);
    // The one intended departure (#7): the sidebar sheets are tinted by default.
    expect(hueOf(t.sheet1)).toBe(207);
    expect(satOf(t.sheet1)).toBeGreaterThan(0);
  });

  it('keeps the dark surfaces neutral at the defaults', () => {
    const t = composeAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(satOf(t.muted)).toBe(0);
    expect(satOf(t.accent)).toBe(0);
    expect(satOf(t.background)).toBe(0);
    expect(t.primary).toBe('207 68% 55%');
  });

  it('the "slate" gray accent swings the neutral surfaces to a cool hue', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'slate'}, 'light');
    expect(hueOf(t.muted)).toBe(220); // cool, not warm 40
    expect(satOf(t.muted)).toBeGreaterThan(0);
  });

  it('the "graphite" gray accent fully desaturates the surfaces, sidebar included (true gray)', () => {
    // Even with the always-on sidebar tint, a neutral-family accent keeps the
    // sheets desaturated (no hue at 0°).
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'graphite', interfaceIntensity: 3}, 'light');
    expect(satOf(t.muted)).toBe(0);
    expect(satOf(t.sheet1)).toBe(0);
    expect(satOf(t.accent)).toBe(0);
  });

  it('a coloured accent keeps the warm-minimal neutral base', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'forest'}, 'light');
    expect(hueOf(t.muted)).toBe(40); // warm, regardless of the green accent
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

  it('the sidebar is always tinted and adopts the accent hue', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'ocean'}, 'light');
    expect(hueOf(t.sheet1)).toBe(221); // ocean's hue
    expect(satOf(t.sheet1)).toBeGreaterThan(0);
  });

  it('interface intensity dials the sidebar tint strength (level 0 = flat panel)', () => {
    const off = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'ocean', interfaceIntensity: 0}, 'light');
    const strong = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'ocean', interfaceIntensity: 3}, 'light');
    expect(satOf(off.sheet1)).toBe(0); // no tint at level 0
    expect(satOf(strong.sheet1)).toBeGreaterThan(satOf(composeAppearance({...DEFAULT_APPEARANCE, themeId: 'ocean'}, 'light').sheet1));
  });
});

describe('mergeAppearance', () => {
  it('overlays only the provided keys and ignores undefined', () => {
    const merged = mergeAppearance(DEFAULT_APPEARANCE, {themeId: 'slate', interfaceIntensity: undefined});
    expect(merged.themeId).toBe('slate');
    expect(merged.interfaceIntensity).toBe(DEFAULT_APPEARANCE.interfaceIntensity);
    expect(merged.controlIntensity).toBe(DEFAULT_APPEARANCE.controlIntensity);
  });

  it('returns the base unchanged for a null override', () => {
    expect(mergeAppearance(DEFAULT_APPEARANCE, null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('normalizeAppearance (migration)', () => {
  it('maps the old tint / accentIntensity keys and drops the retired neutral + tintedSidebar knobs', () => {
    const out = normalizeAppearance({tint: 3, accentIntensity: 1, neutral: 'cool', tintedSidebar: false});
    expect(out).toEqual({interfaceIntensity: 3, controlIntensity: 1}); // neutral + tintedSidebar dropped
  });

  it('renames the retired gray theme ids to their rock types', () => {
    expect(normalizeAppearance({themeId: 'warm'}).themeId).toBe('sandstone');
    expect(normalizeAppearance({themeId: 'neutral'}).themeId).toBe('graphite');
    expect(normalizeAppearance({themeId: 'cool'}).themeId).toBe('slate');
  });

  it('leaves an already-current override untouched', () => {
    const cur = {themeId: 'slate', interfaceIntensity: 1, controlIntensity: 2};
    expect(normalizeAppearance(cur)).toEqual(cur);
  });
});
