import {describe, it, expect} from 'vitest';
import {
  DATA_COLOR_TOKENS,
  DATA_PALETTE,
  DATA_STROKE,
  DEFAULT_DATA_COLOR_SCHEME,
  SERIES_ORDER,
  STATUS_TOKENS,
  dataStroke,
  hexAlpha,
  isDataColorToken,
  seriesColor,
  statusColor,
  type DataColor,
  type DataColorScheme,
  type DataColorToken,
} from './dataColors';
import {SELECT_COLORS} from './database';

const HEX = /^#[0-9a-f]{6}$/;
const SCHEMES: DataColorScheme[] = ['pastel', 'vivid', 'muted'];

describe('dataColors canonical palette', () => {
  it('has 12 tokens: the 9 select colours plus 3 extension hues', () => {
    expect(DATA_COLOR_TOKENS).toHaveLength(12);
    // The stored select enum stays a strict 9-token subset (no stored-format change).
    for (const c of SELECT_COLORS) expect(DATA_COLOR_TOKENS).toContain(c);
    expect(SELECT_COLORS).toHaveLength(9);
    for (const extra of ['teal', 'cyan', 'indigo']) {
      expect(DATA_COLOR_TOKENS).toContain(extra);
      expect((SELECT_COLORS as readonly string[]).includes(extra)).toBe(false);
    }
  });

  it('cycles a blue-first, 9-long series order of select tokens', () => {
    expect(SERIES_ORDER).toEqual([
      'blue', 'orange', 'green', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray',
    ]);
    for (const t of SERIES_ORDER) expect(isDataColorToken(t)).toBe(true);
    // The extension tokens sit outside the rendered cycle.
    for (const t of ['teal', 'cyan', 'indigo']) expect(SERIES_ORDER as readonly string[]).not.toContain(t);
  });

  it('resolves every token × scheme to hex fills and four chip hexes', () => {
    for (const scheme of SCHEMES) {
      for (const t of DATA_COLOR_TOKENS) {
        const c = DATA_PALETTE[scheme][t];
        expect(c.fill).toMatch(HEX);
        expect(c.fillDark).toMatch(HEX);
        expect(c.chip.light.bg).toMatch(HEX);
        expect(c.chip.light.fg).toMatch(HEX);
        expect(c.chip.dark.bg).toMatch(HEX);
        expect(c.chip.dark.fg).toMatch(HEX);
      }
    }
  });

  it('derives chart series colours by cycling SERIES_ORDER', () => {
    expect(seriesColor(0, 'pastel')).toBe(DATA_PALETTE.pastel.blue.fill);
    expect(seriesColor(0)).toBe(DATA_PALETTE[DEFAULT_DATA_COLOR_SCHEME].blue.fill);
    expect(seriesColor(SERIES_ORDER.length, 'pastel')).toBe(seriesColor(0, 'pastel')); // wraps
    expect(seriesColor(1, 'vivid')).toBe(DATA_PALETTE.vivid.orange.fill);
  });

  it('maps status lamps to green / yellow / red (glanceable traffic light)', () => {
    expect(STATUS_TOKENS).toEqual({ok: 'green', warn: 'yellow', bad: 'red'});
    for (const scheme of SCHEMES) {
      expect(statusColor('ok', scheme)).toBe(DATA_PALETTE[scheme].green.fill);
      expect(statusColor('warn', scheme)).toBe(DATA_PALETTE[scheme].yellow.fill);
      expect(statusColor('bad', scheme)).toBe(DATA_PALETTE[scheme].red.fill);
    }
  });

  it('exposes the light-mode hairline (pastel/muted only, not vivid)', () => {
    expect(DATA_STROKE).toBe('rgba(0,0,0,0.12)');
    expect(dataStroke('pastel')).toBe(DATA_STROKE);
    expect(dataStroke('muted')).toBe(DATA_STROKE);
    expect(dataStroke('vivid')).toBe('none');
  });

  it('inlines a hex as rgba at an alpha (for export self-containment)', () => {
    expect(hexAlpha('#9fdf9f', 0.25)).toBe('rgba(159,223,159,0.25)');
    expect(hexAlpha('not-a-hex', 0.5)).toBe('not-a-hex'); // passthrough
  });

  it('guards unknown tokens', () => {
    expect(isDataColorToken('blue')).toBe(true);
    expect(isDataColorToken('cerulean')).toBe(false);
    expect(isDataColorToken(undefined)).toBe(false);
  });
});

// ── Colour math (pure, no deps) — shared by both derivations below ────────────
type RGB = [number, number, number];
type HSL = [number, number, number];
const dclamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100;
  l /= 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s * 100, l * 100];
}
const hexToRgb = (hex: string): RGB => {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
};
const rgbToHex = (rgb: number[]): string =>
  '#' + rgb.map((v) => dclamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const hslToHex = (h: number, s: number, l: number): string =>
  rgbToHex(hslToRgb(((h % 360) + 360) % 360, dclamp(s, 0, 100), dclamp(l, 0, 100)));
const tripleToHex = (t: string): string => {
  const [h, s, l] = t.replace(/%/g, '').trim().split(/\s+/).map(Number);
  return hslToHex(h, s, l);
};
function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastHex(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
const blend = (fgHex: string, alpha: number, bgHex: string): string => {
  const f = hexToRgb(fgHex);
  const g = hexToRgb(bgHex);
  return rgbToHex(f.map((v, i) => v * alpha + g[i] * (1 - alpha)));
};

// ── Guard A: vivid + muted (+ pastel extension tokens) vs the ob-375 derivation ─
// Vivid/Muted are the contrast-solved audit sets (docs/design/ob-375-palette-
// audit.mjs); the pastel extension tokens (teal/cyan/indigo) also carry their
// audit-derived pastel values. Ported verbatim so the module can't drift.
function solveFg(bgHex: string, h: number, s: number, startL: number, dir: number): string {
  let l = startL;
  let hex = hslToHex(h, s, l);
  let guard = 0;
  while (contrastHex(hex, bgHex) < 4.5 && guard++ < 200) {
    l += dir * 0.5;
    if (l <= 2 || l >= 98) {
      hex = hslToHex(h, s, dclamp(l, 2, 98));
      break;
    }
    hex = hslToHex(h, s, l);
  }
  return hex;
}
const VIVID_ANCHOR: Record<string, string> = {
  gray: '#9ca3af', brown: '#b08968', orange: '#f97316', yellow: '#eab308',
  green: '#22c55e', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
  red: '#ef4444', teal: '#14b8a6', cyan: '#06b6d4', indigo: '#6366f1',
};
interface Tw {f300: string | null; c200: string; c800: string; c900: string; cfgD: string}
const TW: Record<string, Tw> = {
  gray:   {f300: '#d4d4d8', c200: '#e4e4e7', c800: '#3f3f46', c900: '#3f3f46', cfgD: '#e4e4e7'},
  brown:  {f300: null,      c200: '#fde68a', c800: '#78350f', c900: '#78350f', cfgD: '#fde68a'},
  orange: {f300: '#fdba74', c200: '#fed7aa', c800: '#9a3412', c900: '#7c2d12', cfgD: '#fed7aa'},
  yellow: {f300: '#fde047', c200: '#fef08a', c800: '#854d0e', c900: '#713f12', cfgD: '#fef08a'},
  green:  {f300: '#86efac', c200: '#bbf7d0', c800: '#166534', c900: '#14532d', cfgD: '#bbf7d0'},
  blue:   {f300: '#93c5fd', c200: '#bfdbfe', c800: '#1e40af', c900: '#1e3a8a', cfgD: '#bfdbfe'},
  purple: {f300: '#d8b4fe', c200: '#e9d5ff', c800: '#6b21a8', c900: '#581c87', cfgD: '#e9d5ff'},
  pink:   {f300: '#f9a8d4', c200: '#fbcfe8', c800: '#9d174d', c900: '#831843', cfgD: '#fbcfe8'},
  red:    {f300: '#fca5a5', c200: '#fecaca', c800: '#991b1b', c900: '#7f1d1d', cfgD: '#fecaca'},
  teal:   {f300: '#5eead4', c200: '#99f6e4', c800: '#115e59', c900: '#134e4a', cfgD: '#99f6e4'},
  cyan:   {f300: '#67e8f9', c200: '#a5f3fc', c800: '#155e75', c900: '#164e63', cfgD: '#a5f3fc'},
  indigo: {f300: '#a5b4fc', c200: '#c7d2fe', c800: '#3730a3', c900: '#312e81', cfgD: '#c7d2fe'},
};
const DARK_CARD = tripleToHex('0 0% 16%');
const LIGHT_PAGE = '#ffffff';
// The muted status tokens whose LIGHT fill is punched up for the traffic light
// (their dark fill keeps the desaturated wash) — see auditColor's muted branch.
const MUTED_STATUS = new Set(['green', 'yellow', 'red']);

/** ob-375 vivid + muted DataColor for a token (fillDark == fill, mode-invariant). */
function auditColor(t: string, scheme: 'vivid' | 'muted'): DataColor {
  const [h, s] = rgbToHsl(...hexToRgb(VIVID_ANCHOR[t]));
  const isNeutral = t === 'gray';
  const sat = (mul: number, min = 0): number => (isNeutral ? Math.min(s, 10) : dclamp(s * mul, min, 100));
  if (scheme === 'vivid') {
    const lightBg = TW[t].f300 ?? hslToHex(h, sat(0.62), 68);
    const darkBg = t === 'gray' ? hslToHex(h, 6, 30) : hslToHex(h, dclamp(s * 0.55, 20, 60), 27);
    const fill = VIVID_ANCHOR[t];
    return {fill, fillDark: fill, chip: {
      light: {bg: lightBg, fg: solveFg(lightBg, h, sat(0.75), 22, -1)},
      dark: {bg: darkBg, fg: solveFg(darkBg, h, sat(0.5), 82, +1)},
    }};
  }
  const fill = hslToHex(h, isNeutral ? 6 : dclamp(s * 0.3, 10, 32), 58);
  const lightBg = hslToHex(h, isNeutral ? 5 : dclamp(s * 0.22, 8, 26), 90);
  const darkBg = hslToHex(h, isNeutral ? 4 : dclamp(s * 0.15, 6, 18), 24);
  // The status trio's LIGHT fill is punched up +12% saturation (hue kept) for a
  // clearer traffic light; the dark fill stays the desaturated wash (OB-379).
  const [fh, fs, fl] = rgbToHsl(...hexToRgb(fill));
  const lightFill = MUTED_STATUS.has(t) ? hslToHex(fh, dclamp(fs + 12, 0, 100), fl) : fill;
  return {fill: lightFill, fillDark: fill, chip: {
    light: {bg: lightBg, fg: solveFg(lightBg, h, isNeutral ? 6 : dclamp(s * 0.3, 8, 30), 32, -1)},
    dark: {bg: darkBg, fg: solveFg(darkBg, h, isNeutral ? 5 : dclamp(s * 0.2, 6, 22), 78, +1)},
  }};
}
/** ob-375 PASTEL for the extension tokens only (teal/cyan/indigo). */
function auditPastelExt(t: string): DataColor {
  const tw = TW[t];
  const c800 = rgbToHsl(...hexToRgb(tw.c800));
  const cfgD = rgbToHsl(...hexToRgb(tw.cfgD));
  const [h, s] = rgbToHsl(...hexToRgb(VIVID_ANCHOR[t]));
  const fill = tw.f300 ?? hslToHex(h, dclamp(s * 0.62, 0, 100), 68);
  const lightBg = t === 'brown' ? blend(tw.c200, 0.7, LIGHT_PAGE) : tw.c200;
  const darkBg = t === 'gray' ? blend('#3f3f46', 0.6, DARK_CARD) : blend(tw.c900, 0.4, DARK_CARD);
  return {fill, fillDark: fill, chip: {
    light: {bg: lightBg, fg: solveFg(lightBg, c800[0], c800[1], c800[2], -1)},
    dark: {bg: darkBg, fg: solveFg(darkBg, cfgD[0], cfgD[1], cfgD[2], +1)},
  }};
}

// ── Guard B: the soft-pastel select tokens — owner light + derived dark ───────
// Owner-picked (rendered candidate, 2026-07-05): fill / chipBg / chipFg / fillDark.
// The per-hue dark chip is DERIVED here identically to the module: a deep muted
// bg + a light on-hue fg, both taken from the light chipFg's hue.
const PASTEL_OWNER: Record<string, {fill: string; chipBg: string; chipFg: string; fillDark: string}> = {
  gray:   {fill: '#c3c6cb', chipBg: '#e3e2e0', chipFg: '#5c6475', fillDark: '#b0b5bf'},
  brown:  {fill: '#d7af9d', chipBg: '#eee0da', chipFg: '#9d4c2a', fillDark: '#ddac98'},
  orange: {fill: '#debea6', chipBg: '#fadec9', chipFg: '#935425', fillDark: '#e3bda1'},
  yellow: {fill: '#dac495', chipBg: '#fdecc8', chipFg: '#876622', fillDark: '#e0c690'},
  green:  {fill: '#9fdf9f', chipBg: '#dbeddb', chipFg: '#1e761e', fillDark: '#9ae49a'},
  blue:   {fill: '#a9ccdf', chipBg: '#d3e5ef', chipFg: '#24698f', fillDark: '#a5cde4'},
  purple: {fill: '#cdade1', chipBg: '#e8deee', chipFg: '#9032c8', fillDark: '#cfa8e6'},
  pink:   {fill: '#dea6be', chipBg: '#f5e0e9', chipFg: '#b82e69', fillDark: '#e3a1bd'},
  red:    {fill: '#deaea6', chipBg: '#ffe2dd', chipFg: '#b4412d', fillDark: '#e3aaa1'},
};
/** Derive the dark chip for a soft-pastel token from its light chip fg (on-hue). */
function pastelDarkChip(chipFgHex: string): {bg: string; fg: string} {
  const [h, s] = rgbToHsl(...hexToRgb(chipFgHex));
  const bg = hslToHex(h, dclamp(s, 6, 40), 22);
  let l = 82;
  let fg = hslToHex(h, dclamp(s, 6, 50), l);
  let guard = 0;
  while (contrastHex(fg, bg) < 4.5 && guard++ < 50) {
    l += 1;
    fg = hslToHex(h, dclamp(s, 6, 50), l);
  }
  return {bg, fg};
}
function pastelOwnerColor(t: string): DataColor {
  const o = PASTEL_OWNER[t];
  return {fill: o.fill, fillDark: o.fillDark, chip: {light: {bg: o.chipBg, fg: o.chipFg}, dark: pastelDarkChip(o.chipFg)}};
}

describe('dataColors matches its derivation (drift guard)', () => {
  it('vivid + muted equal the ob-375 audit derivation (all 12 tokens each)', () => {
    let n = 0;
    for (const scheme of ['vivid', 'muted'] as const) {
      for (const t of DATA_COLOR_TOKENS) {
        expect({scheme, t, v: DATA_PALETTE[scheme][t]}).toEqual({scheme, t, v: auditColor(t, scheme)});
        n += 1;
      }
    }
    expect(n).toBe(24);
  });

  it('pastel extension tokens (teal/cyan/indigo) equal the ob-375 pastel derivation', () => {
    for (const t of ['teal', 'cyan', 'indigo']) {
      expect({t, v: DATA_PALETTE.pastel[t as DataColorToken]}).toEqual({t, v: auditPastelExt(t)});
    }
  });

  it('the 9 soft-pastel select tokens equal owner light + derived dark chip', () => {
    for (const t of SELECT_COLORS) {
      expect({t, v: DATA_PALETTE.pastel[t]}).toEqual({t, v: pastelOwnerColor(t)});
    }
  });

  it('every soft-pastel chip fg passes ≥ 4.5:1 on its bg (light AND dark)', () => {
    for (const t of SELECT_COLORS) {
      const c = DATA_PALETTE.pastel[t];
      expect({t, mode: 'light', r: contrastHex(c.chip.light.fg, c.chip.light.bg) >= 4.5}).toEqual({t, mode: 'light', r: true});
      expect({t, mode: 'dark', r: contrastHex(c.chip.dark.fg, c.chip.dark.bg) >= 4.5}).toEqual({t, mode: 'dark', r: true});
    }
  });

  it('the status trio reads as three distinct signal hues (green / yellow / red)', () => {
    const hueOf = (hex: string): number => rgbToHsl(...hexToRgb(hex))[0];
    const ok = hueOf(statusColor('ok'));
    const warn = hueOf(statusColor('warn'));
    const bad = hueOf(statusColor('bad'));
    // green ≈120°, yellow ≈40–60°, red ≈0–20° — each pair well separated in hue.
    expect(ok).toBeGreaterThan(90);
    expect(warn).toBeGreaterThan(30);
    expect(warn).toBeLessThan(70);
    expect(bad).toBeLessThan(25);
    expect(Math.min(Math.abs(ok - warn), Math.abs(warn - bad), Math.abs(ok - bad))).toBeGreaterThan(20);
  });
});
