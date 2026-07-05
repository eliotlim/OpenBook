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

  // ── OB-377 full-accent sidebar (values audited in
  //    docs/design/colour-consistency-manifest-2026-07.md §2.2) ──────────────

  it('renders the full-accent sidebar at the default intensity', () => {
    const light = composeAppearance(DEFAULT_APPEARANCE, 'light');
    expect(light.sheet1).toBe('207 75% 44%'); // audited: darkened 49 → 44 for white text
    expect(light.sheet2).toBe('207 79% 38%');
    expect(light.sheet1Foreground).toBe('0 0% 100%');
    expect(light.sheet2Foreground).toBe('0 0% 100%');
    expect(light.sheetVeil).toBe('0 0% 0%'); // black veil under a light foreground
    const dark = composeAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(dark.sheet1).toBe('207 47.6% 24%'); // deep shade, not the dark primary
    expect(dark.sheet2).toBe('207 47.6% 28.5%');
    expect(dark.sheet1Foreground).toBe('0 0% 93%');
    expect(dark.sheetVeil).toBe('0 0% 100%');
  });

  it('flips warm/pastel hues to an ink foreground (audited override)', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'sunset'}, 'light');
    expect(t.sheet1).toBe('25 95% 53%'); // primary verbatim — no darkening needed
    expect(t.sheet1Foreground).toBe('25 55% 15%');
    expect(t.sheetVeil).toBe('0 0% 100%'); // white veil under an ink foreground
  });

  it('gray accents render a charcoal panel at full intensity', () => {
    const t = composeAppearance({...DEFAULT_APPEARANCE, themeId: 'graphite'}, 'light');
    expect(t.sheet1).toBe('0 0% 34%'); // the gray primary, verbatim
    expect(t.sheet1Foreground).toBe('0 0% 100%');
  });

  it('interface intensity: 0 = flat panel, 1 = soft tint, 3 = same sheets as 2', () => {
    const off = composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 0}, 'light');
    expect(satOf(off.sheet1)).toBe(0); // no tint at level 0
    expect(off.sheet1Foreground).toBe('34 9% 19%');
    const soft = composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 1}, 'light');
    expect(soft.sheet1).toBe('207 42% 96%'); // the pre-OB-377 default look
    expect(soft.sheet1Foreground).toBe('34 9% 19%');
    // The sidebar is already at maximum at level 2; level 3 only strengthens
    // the other neutral surfaces.
    const l2 = composeAppearance(DEFAULT_APPEARANCE, 'light');
    const l3 = composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 3}, 'light');
    expect(l3.sheet1).toBe(l2.sheet1);
    expect(l3.sheet1Foreground).toBe(l2.sheet1Foreground);
  });

  it('the desk stays a neutral canvas while the sheets go full-accent', () => {
    const light = composeAppearance(DEFAULT_APPEARANCE, 'light');
    expect(light.desk).toBe('40 11% 93.5%'); // warm neutral, no accent
    const dark = composeAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(satOf(dark.desk)).toBe(0);
    expect(dark.desk.endsWith('11%')).toBe(true);
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
