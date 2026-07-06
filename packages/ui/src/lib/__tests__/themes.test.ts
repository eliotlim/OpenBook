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

  // ── Sidebar mode: tinted default vs the OB-377 full-accent option ──────────
  //    (accent values audited in docs/design/colour-consistency-manifest-2026-07.md §2.2)

  const ACCENT: typeof DEFAULT_APPEARANCE = {...DEFAULT_APPEARANCE, sidebar: 'accent'};

  it('defaults to the tinted sidebar (pale accent panel, app foreground)', () => {
    expect(DEFAULT_APPEARANCE.sidebar).toBe('tinted');
    const light = composeAppearance(DEFAULT_APPEARANCE, 'light');
    expect(light.sheet1).toBe('207 42% 96%'); // the pre-OB-377 pale tint
    expect(light.sheet2).toBe('207 50% 90.5%');
    expect(light.sheet1Foreground).toBe('34 9% 19%'); // the app foreground, not flipped
    const dark = composeAppearance(DEFAULT_APPEARANCE, 'dark');
    expect(dark.sheet1).toBe('207 34% 16%');
    expect(dark.sheet1Foreground).toBe('0 0% 82%');
  });

  it('renders the full-accent sidebar when sidebar = accent', () => {
    const light = composeAppearance(ACCENT, 'light');
    expect(light.sheet1).toBe('207 75% 44%'); // audited: darkened 49 → 44 for white text
    expect(light.sheet2).toBe('207 79% 38%');
    expect(light.sheet1Foreground).toBe('0 0% 100%');
    expect(light.sheet2Foreground).toBe('0 0% 100%');
    expect(light.sheetVeil).toBe('0 0% 0%'); // black veil under a light foreground
    const dark = composeAppearance(ACCENT, 'dark');
    expect(dark.sheet1).toBe('207 47.6% 24%'); // deep shade, not the dark primary
    expect(dark.sheet2).toBe('207 47.6% 28.5%');
    expect(dark.sheet1Foreground).toBe('0 0% 93%');
    expect(dark.sheetVeil).toBe('0 0% 100%');
  });

  it('accent flips warm/pastel hues to an ink foreground (audited override)', () => {
    const t = composeAppearance({...ACCENT, themeId: 'sunset'}, 'light');
    expect(t.sheet1).toBe('25 95% 53%'); // primary verbatim — no darkening needed
    expect(t.sheet1Foreground).toBe('25 55% 15%');
    expect(t.sheetVeil).toBe('0 0% 100%'); // white veil under an ink foreground
  });

  it('accent gray accents render a charcoal panel', () => {
    const t = composeAppearance({...ACCENT, themeId: 'graphite'}, 'light');
    expect(t.sheet1).toBe('0 0% 34%'); // the gray primary, verbatim
    expect(t.sheet1Foreground).toBe('0 0% 100%');
  });

  it('interfaceIntensity drives the TINTED sidebar saturation, not the accent one', () => {
    // Tinted: 0 = flat neutral panel, then TINT_MUL 0.55 / 1 / 1.5.
    expect(satOf(composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 0}, 'light').sheet1)).toBe(0);
    expect(composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 1}, 'light').sheet1).toBe('207 23.1% 96%');
    expect(composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 2}, 'light').sheet1).toBe('207 42% 96%');
    expect(composeAppearance({...DEFAULT_APPEARANCE, interfaceIntensity: 3}, 'light').sheet1).toBe('207 63% 96%');
    // Accent: the sheet is the full accent surface regardless of intensity.
    const a0 = composeAppearance({...ACCENT, interfaceIntensity: 0}, 'light');
    const a3 = composeAppearance({...ACCENT, interfaceIntensity: 3}, 'light');
    expect(a0.sheet1).toBe('207 75% 44%');
    expect(a3.sheet1).toBe('207 75% 44%');
  });

  it('the desk stays a neutral canvas in both sidebar modes', () => {
    for (const opts of [DEFAULT_APPEARANCE, ACCENT]) {
      expect(composeAppearance(opts, 'light').desk).toBe('40 11% 93.5%'); // warm neutral, no accent
      const dark = composeAppearance(opts, 'dark');
      expect(satOf(dark.desk)).toBe(0);
      expect(dark.desk.endsWith('11%')).toBe(true);
    }
  });

  // The §2.2 audited table, encoded verbatim for the archetypes the manifest
  // calls out (per-theme sheet-darken and ink-flip overrides among them). This
  // pins composeAppearance to the signed-off values — it must not re-derive them
  // at runtime and drift. All under sidebar = accent.
  const SHEET_TABLE: Array<{
    id: string;
    light: [string, string, string];
    dark: [string, string, string];
  }> = [
    {id: 'default', light: ['207 75% 44%', '207 79% 38%', '0 0% 100%'], dark: ['207 47.6% 24%', '207 47.6% 28.5%', '0 0% 93%']},
    {id: 'graphite', light: ['0 0% 34%', '0 4% 28%', '0 0% 100%'], dark: ['0 0% 24%', '0 0% 28.5%', '0 0% 93%']},
    {id: 'ocean', light: ['221 83% 53%', '221 87% 47%', '0 0% 100%'], dark: ['217 60% 24%', '217 60% 28.5%', '0 0% 93%']},
    {id: 'forest', light: ['142 71% 31%', '142 75% 25%', '0 0% 100%'], dark: ['142 45.5% 24%', '142 45.5% 28.5%', '0 0% 93%']},
    {id: 'teal', light: ['174 72% 30%', '174 76% 24%', '0 0% 100%'], dark: ['173 49% 24%', '173 49% 28.5%', '0 0% 93%']},
    {id: 'sunset', light: ['25 95% 53%', '25 99% 47%', '25 55% 15%'], dark: ['21 60% 24%', '21 60% 28.5%', '0 0% 93%']},
    {id: 'amber', light: ['38 92% 48%', '38 96% 42%', '30 40% 14%'], dark: ['41 60% 24%', '41 60% 28.5%', '0 0% 93%']},
    {id: 'pastel-butter', light: ['46 80% 70%', '46 84% 64%', '40 55% 24%'], dark: ['46 46.2% 24%', '46 46.2% 28.5%', '0 0% 93%']},
    {id: 'pastel-lavender', light: ['258 60% 76%', '258 64% 70%', '258 55% 15%'], dark: ['258 33.6% 24%', '258 33.6% 28.5%', '0 0% 93%']},
  ];

  it.each(SHEET_TABLE)('matches the §2.2 audited accent sheet tokens for $id', ({id, light, dark}) => {
    const l = composeAppearance({...ACCENT, themeId: id}, 'light');
    expect([l.sheet1, l.sheet2, l.sheet1Foreground]).toEqual(light);
    expect(l.sheet2Foreground).toBe(light[2]); // both sheets share the foreground
    const d = composeAppearance({...ACCENT, themeId: id}, 'dark');
    expect([d.sheet1, d.sheet2, d.sheet1Foreground]).toEqual(dark);
  });

  // Acceptance guard: on the accent sheet the sheet-foreground must clear WCAG
  // 4.5:1 on *both* sheets, for *every* theme, in *both* schemes. (Note: this
  // checks the composed SHEET fg/bg; the real sidebar DOM — nav/headers/rows/
  // icons that read other tokens — is verified end-to-end by the Playwright
  // guard packages/web/e2e/sidebar-accent-contrast.spec.ts.)
  const hslToRgb = (triple: string): [number, number, number] => {
    const [h, s, l] = triple.replace(/%/g, '').split(/\s+/).map(Number).map((n, i) => (i === 0 ? n : n / 100));
    const k = (n: number): number => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((c) => Math.round(c * 255)) as [number, number, number];
  };
  const luminance = (triple: string): number => {
    const lin = hslToRgb(triple)
      .map((c) => c / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const contrast = (a: string, b: string): number => {
    const [la, lb] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (la + 0.05) / (lb + 0.05);
  };

  it('keeps accent foreground-on-sheet ≥ 4.5:1 for all 17 themes in both schemes', () => {
    for (const theme of themes) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = composeAppearance({...ACCENT, themeId: theme.id}, scheme);
        for (const [sheet, fg] of [[t.sheet1, t.sheet1Foreground], [t.sheet2, t.sheet2Foreground]] as const) {
          const ratio = contrast(fg, sheet);
          expect(ratio, `${theme.id}/${scheme}: fg ${fg} on sheet ${sheet}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
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

  it('keeps a valid sidebar value and drops an invalid one (→ tinted default)', () => {
    expect(normalizeAppearance({sidebar: 'accent'}).sidebar).toBe('accent');
    expect(normalizeAppearance({sidebar: 'tinted'}).sidebar).toBe('tinted');
    // Unknown value dropped → merges to DEFAULT_APPEARANCE.sidebar ('tinted').
    expect('sidebar' in normalizeAppearance({sidebar: 'full'})).toBe(false);
    // A persisted appearance with no sidebar key stays tinted (no surprise flip).
    expect('sidebar' in normalizeAppearance({themeId: 'ocean'})).toBe(false);
    expect(mergeAppearance(DEFAULT_APPEARANCE, normalizeAppearance({themeId: 'ocean'})).sidebar).toBe('tinted');
  });
});
