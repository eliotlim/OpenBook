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
  type DataColorScheme,
  type DataColorToken,
} from './dataColors';
import {SELECT_COLORS} from './database';

const HEX = /^#[0-9a-f]{6}$/;
const SCHEMES: DataColorScheme[] = ['pastel', 'vivid', 'muted'];

describe('dataColors canonical palette', () => {
  it('has 12 tokens: the 9 select colours plus 3 chart-only hues', () => {
    expect(DATA_COLOR_TOKENS).toHaveLength(12);
    // The stored select enum stays a strict 9-token subset (no stored-format change).
    for (const c of SELECT_COLORS) expect(DATA_COLOR_TOKENS).toContain(c);
    expect(SELECT_COLORS).toHaveLength(9);
    for (const extra of ['teal', 'cyan', 'indigo']) {
      expect(DATA_COLOR_TOKENS).toContain(extra);
      expect((SELECT_COLORS as readonly string[]).includes(extra)).toBe(false);
    }
  });

  it('cycles a blue-first, 12-long series order of valid tokens', () => {
    expect(SERIES_ORDER).toEqual([
      'blue', 'orange', 'green', 'red', 'purple', 'cyan',
      'yellow', 'teal', 'pink', 'indigo', 'brown', 'gray',
    ]);
    for (const t of SERIES_ORDER) expect(isDataColorToken(t)).toBe(true);
  });

  it('resolves every token × scheme to a hex fill and four chip hexes', () => {
    for (const scheme of SCHEMES) {
      for (const t of DATA_COLOR_TOKENS) {
        const c = DATA_PALETTE[scheme][t];
        expect(c.fill).toMatch(HEX);
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

  it('maps status lamps onto the semantic tokens (ok/warn/bad)', () => {
    expect(STATUS_TOKENS).toEqual({ok: 'green', warn: 'orange', bad: 'red'});
    for (const scheme of SCHEMES) {
      expect(statusColor('ok', scheme)).toBe(DATA_PALETTE[scheme].green.fill);
      expect(statusColor('warn', scheme)).toBe(DATA_PALETTE[scheme].orange.fill);
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
    expect(hexAlpha('#86efac', 0.25)).toBe('rgba(134,239,172,0.25)');
    expect(hexAlpha('not-a-hex', 0.5)).toBe('not-a-hex'); // passthrough
  });

  it('guards unknown tokens', () => {
    expect(isDataColorToken('blue')).toBe(true);
    expect(isDataColorToken('cerulean')).toBe(false);
    expect(isDataColorToken(undefined)).toBe(false);
  });
});

// ── Full-palette regression guard vs the signed-off derivation ───────────────
// Every value in dataColors.ts was emitted by `docs/design/ob-375-palette-
// audit.mjs` (WCAG-contrast-solved). That script is a browser-unsafe CLI (it
// console.logs markdown), so rather than shell out we PORT its pure colour math
// here verbatim and re-derive all 180 values (36 fills + 144 chip hexes),
// diffing against the module. Either the module or this port changing without
// the other fails — a real drift guard, not a spot-check. Keep this in lockstep
// with the .mjs (both are frozen: the palette is owner-signed, OB-375).

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
// fg auto-solver: move fg lightness away from bg until ratio >= 4.5
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

// Vivid anchors (SWATCH_HEX + kit extensions, orange shifted to orange-500).
const VIVID: Record<string, string> = {
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

interface Chip {light: {bg: string; fg: string}; dark: {bg: string; fg: string}}
interface Derived {fill: {pastel: string; vivid: string; muted: string}; chip: {pastel: Chip; vivid: Chip; muted: Chip}}

/** Re-derive one token's fills + chips exactly as ob-375-palette-audit.mjs does. */
function derive(t: string): Derived {
  const [h, s] = rgbToHsl(...hexToRgb(VIVID[t]));
  const tw = TW[t];
  const isNeutral = t === 'gray';
  const sat = (mul: number, min = 0): number => (isNeutral ? Math.min(s, 10) : dclamp(s * mul, min, 100));

  const pastelFill = tw.f300 ?? hslToHex(h, sat(0.62), 68);
  const mutedFill = hslToHex(h, isNeutral ? 6 : dclamp(s * 0.3, 10, 32), 58);

  const c800 = rgbToHsl(...hexToRgb(tw.c800));
  const cfgD = rgbToHsl(...hexToRgb(tw.cfgD));
  const pastelChip: Chip = {
    light: {
      bg: t === 'brown' ? blend(tw.c200, 0.7, LIGHT_PAGE) : tw.c200,
      fg: '',
    },
    dark: {
      bg: t === 'gray' ? blend('#3f3f46', 0.6, DARK_CARD) : blend(tw.c900, 0.4, DARK_CARD),
      fg: '',
    },
  };
  pastelChip.light.fg = solveFg(pastelChip.light.bg, c800[0], c800[1], c800[2], -1);
  pastelChip.dark.fg = solveFg(pastelChip.dark.bg, cfgD[0], cfgD[1], cfgD[2], +1);

  const vividLightBg = tw.f300 ?? hslToHex(h, sat(0.62), 68);
  const vividDarkBg = t === 'gray' ? hslToHex(h, 6, 30) : hslToHex(h, dclamp(s * 0.55, 20, 60), 27);
  const vividChip: Chip = {
    light: {bg: vividLightBg, fg: solveFg(vividLightBg, h, sat(0.75), 22, -1)},
    dark: {bg: vividDarkBg, fg: solveFg(vividDarkBg, h, sat(0.5), 82, +1)},
  };

  const mutedLightBg = hslToHex(h, isNeutral ? 5 : dclamp(s * 0.22, 8, 26), 90);
  const mutedDarkBg = hslToHex(h, isNeutral ? 4 : dclamp(s * 0.15, 6, 18), 24);
  const mutedChip: Chip = {
    light: {bg: mutedLightBg, fg: solveFg(mutedLightBg, h, isNeutral ? 6 : dclamp(s * 0.3, 8, 30), 32, -1)},
    dark: {bg: mutedDarkBg, fg: solveFg(mutedDarkBg, h, isNeutral ? 5 : dclamp(s * 0.2, 6, 22), 78, +1)},
  };

  return {
    fill: {pastel: pastelFill, vivid: VIVID[t], muted: mutedFill},
    chip: {pastel: pastelChip, vivid: vividChip, muted: mutedChip},
  };
}

describe('dataColors matches the ob-375 audit derivation (all 180 values)', () => {
  it('every fill + chip value equals the ported generator (36 fills + 144 chips)', () => {
    let compared = 0;
    for (const t of DATA_COLOR_TOKENS as readonly DataColorToken[]) {
      const d = derive(t);
      for (const scheme of SCHEMES) {
        const mod = DATA_PALETTE[scheme][t];
        // Tag each assertion with {scheme, t} so a drift names the exact cell.
        expect({scheme, t, v: mod.fill}).toEqual({scheme, t, v: d.fill[scheme]});
        expect({scheme, t, v: mod.chip.light.bg}).toEqual({scheme, t, v: d.chip[scheme].light.bg});
        expect({scheme, t, v: mod.chip.light.fg}).toEqual({scheme, t, v: d.chip[scheme].light.fg});
        expect({scheme, t, v: mod.chip.dark.bg}).toEqual({scheme, t, v: d.chip[scheme].dark.bg});
        expect({scheme, t, v: mod.chip.dark.fg}).toEqual({scheme, t, v: d.chip[scheme].dark.fg});
        compared += 5;
      }
    }
    expect(compared).toBe(180);
  });
});
