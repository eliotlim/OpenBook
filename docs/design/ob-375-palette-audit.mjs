// OB-375 palette + contrast generator. Throwaway spike script.
// Emits the manifest's value tables (markdown) with WCAG 2.1 contrast ratios.

// ── colour math ──────────────────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
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
const hexToRgb = (hex) => {
  const m = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
};
const rgbToHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const hslToHex = (h, s, l) => rgbToHex(hslToRgb(((h % 360) + 360) % 360, clamp(s, 0, 100), clamp(l, 0, 100)));
const parseTriple = (t) => t.replace(/%/g, '').trim().split(/\s+/).map(Number);
const tripleToHex = (t) => hslToHex(...parseTriple(t));
const r1 = (n) => Math.round(n * 10) / 10;
const triple = (h, s, l) => `${r1(((h % 360) + 360) % 360)} ${r1(clamp(s, 0, 100))}% ${r1(clamp(l, 0, 100))}%`;
const hexToTriple = (hex) => triple(...rgbToHsl(...hexToRgb(hex)));

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastHex(a, b) {
  const la = luminance(hexToRgb(a)), lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
const cr = (a, b) => Math.round(contrastHex(a, b) * 100) / 100;
// flatten fg-with-alpha over bg
const blend = (fgHex, alpha, bgHex) => {
  const f = hexToRgb(fgHex), g = hexToRgb(bgHex);
  return rgbToHex(f.map((v, i) => v * alpha + g[i] * (1 - alpha)));
};

// ── canonical tokens ─────────────────────────────────────────────────────────
// Vivid anchors: SWATCH_HEX for the 9 select tokens (back-compat), except
// orange moves amber-500 -> orange-500 (#f97316) to match the chip hue
// (COLOR_CLASSES uses orange-200/800) and to separate from yellow.
// Extensions (chart-series-only): teal, cyan, indigo from the kit palette.
const VIVID = {
  gray: '#9ca3af', brown: '#b08968', orange: '#f97316', yellow: '#eab308',
  green: '#22c55e', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
  red: '#ef4444', teal: '#14b8a6', cyan: '#06b6d4', indigo: '#6366f1',
};
const TOKENS = Object.keys(VIVID);

// Tailwind v3 hexes used to anchor pastel chips (today's COLOR_CLASSES look)
// and pastel fills (-300 row). brown has no tailwind family -> derived.
const TW = {
  gray:   { f300: '#d4d4d8', c200: '#e4e4e7', c800: '#3f3f46', c900: '#3f3f46', c100: '#f4f4f5', cfgD: '#e4e4e7' }, // zinc; today: bg-zinc-200 text-zinc-700 / dark bg-zinc-700/60 text-zinc-200
  brown:  { f300: null,      c200: '#fde68a', c800: '#78350f', c900: '#78350f', c100: '#fef3c7', cfgD: '#fde68a' }, // amber family stand-in (today: amber-200/70 + amber-900)
  orange: { f300: '#fdba74', c200: '#fed7aa', c800: '#9a3412', c900: '#7c2d12', c100: '#ffedd5', cfgD: '#fed7aa' },
  yellow: { f300: '#fde047', c200: '#fef08a', c800: '#854d0e', c900: '#713f12', c100: '#fef9c3', cfgD: '#fef08a' },
  green:  { f300: '#86efac', c200: '#bbf7d0', c800: '#166534', c900: '#14532d', c100: '#dcfce7', cfgD: '#bbf7d0' },
  blue:   { f300: '#93c5fd', c200: '#bfdbfe', c800: '#1e40af', c900: '#1e3a8a', c100: '#dbeafe', cfgD: '#bfdbfe' },
  purple: { f300: '#d8b4fe', c200: '#e9d5ff', c800: '#6b21a8', c900: '#581c87', c100: '#f3e8ff', cfgD: '#e9d5ff' },
  pink:   { f300: '#f9a8d4', c200: '#fbcfe8', c800: '#9d174d', c900: '#831843', c100: '#fce7f3', cfgD: '#fbcfe8' },
  red:    { f300: '#fca5a5', c200: '#fecaca', c800: '#991b1b', c900: '#7f1d1d', c100: '#fee2e2', cfgD: '#fecaca' },
  teal:   { f300: '#5eead4', c200: '#99f6e4', c800: '#115e59', c900: '#134e4a', c100: '#ccfbf1', cfgD: '#99f6e4' },
  cyan:   { f300: '#67e8f9', c200: '#a5f3fc', c800: '#155e75', c900: '#164e63', c100: '#cffafe', cfgD: '#a5f3fc' },
  indigo: { f300: '#a5b4fc', c200: '#c7d2fe', c800: '#3730a3', c900: '#312e81', c100: '#e0e7ff', cfgD: '#c7d2fe' },
};
const DARK_CARD = tripleToHex('0 0% 16%');   // dark --card, the surface chips usually sit on
const LIGHT_PAGE = '#ffffff';
const DARK_PAGE = tripleToHex('0 0% 13%');

// fg auto-solver: move fg lightness away from bg until ratio >= 4.5
function solveFg(bgHex, h, s, startL, dir /* -1 darken, +1 lighten */) {
  let l = startL;
  let hex = hslToHex(h, s, l);
  let guard = 0;
  while (contrastHex(hex, bgHex) < 4.5 && guard++ < 200) {
    l += dir * 0.5;
    if (l <= 2 || l >= 98) { hex = hslToHex(h, s, clamp(l, 2, 98)); break; }
    hex = hslToHex(h, s, l);
  }
  return hex;
}

// ── build the palette ────────────────────────────────────────────────────────
// role model per token x scheme:
//   fill            one value, mode-invariant (dot/swatch, chart series, status light)
//   chip.light/dark {bg, fg}
const palette = {};
for (const t of TOKENS) {
  const [h, s, l] = rgbToHsl(...hexToRgb(VIVID[t]));
  const tw = TW[t];
  const isNeutral = t === 'gray';
  const sat = (mul, min = 0) => (isNeutral ? Math.min(s, 10) : clamp(s * mul, min, 100));

  // fills
  const vividFill = VIVID[t];
  const pastelFill = tw.f300 ?? hslToHex(h, sat(0.62), 68); // brown derived
  const mutedFill = hslToHex(h, isNeutral ? 6 : clamp(s * 0.3, 10, 32), 58);

  // chips
  const chip = (scheme) => {
    if (scheme === 'pastel') {
      // today's look: tailwind -200 bg + -800-ish fg (light); -900/40 flattened + -200 fg (dark)
      const lightBg = t === 'brown' ? blend(tw.c200, 0.7, LIGHT_PAGE) : tw.c200;
      const lightFg = solveFg(lightBg, ...rgbToHsl(...hexToRgb(tw.c800)).slice(0, 2), rgbToHsl(...hexToRgb(tw.c800))[2], -1);
      const darkBg = t === 'gray' ? blend('#3f3f46', 0.6, DARK_CARD) : blend(tw.c900, 0.4, DARK_CARD);
      const darkFg = solveFg(darkBg, ...rgbToHsl(...hexToRgb(tw.cfgD)).slice(0, 2), rgbToHsl(...hexToRgb(tw.cfgD))[2], +1);
      return { light: { bg: lightBg, fg: lightFg }, dark: { bg: darkBg, fg: darkFg } };
    }
    if (scheme === 'vivid') {
      const lightBg = tw.f300 ?? hslToHex(h, sat(0.62), 68);
      const lightFg = solveFg(lightBg, h, sat(0.75), 22, -1);
      const darkBg = t === 'gray' ? hslToHex(h, 6, 30) : hslToHex(h, clamp(s * 0.55, 20, 60), 27);
      const darkFg = solveFg(darkBg, h, sat(0.5), 82, +1);
      return { light: { bg: lightBg, fg: lightFg }, dark: { bg: darkBg, fg: darkFg } };
    }
    // muted
    const lightBg = hslToHex(h, isNeutral ? 5 : clamp(s * 0.22, 8, 26), 90);
    const lightFg = solveFg(lightBg, h, isNeutral ? 6 : clamp(s * 0.3, 8, 30), 32, -1);
    const darkBg = hslToHex(h, isNeutral ? 4 : clamp(s * 0.15, 6, 18), 24);
    const darkFg = solveFg(darkBg, h, isNeutral ? 5 : clamp(s * 0.2, 6, 22), 78, +1);
    return { light: { bg: lightBg, fg: lightFg }, dark: { bg: darkBg, fg: darkFg } };
  };

  palette[t] = {
    hue: r1(h),
    fill: { pastel: pastelFill, vivid: vividFill, muted: mutedFill },
    chip: { pastel: chip('pastel'), vivid: chip('vivid'), muted: chip('muted') },
  };
}

// ── emit palette tables ──────────────────────────────────────────────────────
const fmt = (hex) => `\`${hex}\` (${hexToTriple(hex)})`;
let out = [];
out.push('<!-- fills: token x scheme (mode-invariant) -->');
out.push('| Token | Pastel fill | Vivid fill | Muted fill |');
out.push('|---|---|---|---|');
for (const t of TOKENS) {
  const p = palette[t];
  out.push(`| ${t} | ${fmt(p.fill.pastel)} | ${fmt(p.fill.vivid)} | ${fmt(p.fill.muted)} |`);
}
out.push('');
for (const scheme of ['pastel', 'vivid', 'muted']) {
  out.push(`<!-- ${scheme} chips -->`);
  out.push('| Token | Light bg | Light fg | ratio | Dark bg | Dark fg | ratio |');
  out.push('|---|---|---|---|---|---|---|');
  for (const t of TOKENS) {
    const c = palette[t].chip[scheme];
    out.push(
      `| ${t} | ${fmt(c.light.bg)} | ${fmt(c.light.fg)} | ${cr(c.light.fg, c.light.bg)} | ${fmt(c.dark.bg)} | ${fmt(c.dark.fg)} | ${cr(c.dark.fg, c.dark.bg)} |`,
    );
  }
  out.push('');
}
// fill visibility (non-normative, 3:1 graphics target) vs page bg
out.push('<!-- fill vs page (graphics, 3:1 target) -->');
out.push('| Token | Pastel vs light page | Pastel vs dark page | Vivid vs light | Vivid vs dark | Muted vs light | Muted vs dark |');
out.push('|---|---|---|---|---|---|---|');
for (const t of TOKENS) {
  const f = palette[t].fill;
  out.push(`| ${t} | ${cr(f.pastel, LIGHT_PAGE)} | ${cr(f.pastel, DARK_PAGE)} | ${cr(f.vivid, LIGHT_PAGE)} | ${cr(f.vivid, DARK_PAGE)} | ${cr(f.muted, LIGHT_PAGE)} | ${cr(f.muted, DARK_PAGE)} |`);
}
out.push('');

// ── sidebar full-accent model ────────────────────────────────────────────────
// themes.ts primaries (light primary+fg, dark primary), verbatim.
const THEMES = [
  { id: 'default', lp: '207 75% 49%', lfg: '0 0% 100%', dp: '207 68% 55%' },
  { id: 'sandstone', lp: '28 12% 34%', lfg: '0 0% 100%', dp: '30 10% 70%', gray: true },
  { id: 'graphite', lp: '0 0% 34%', lfg: '0 0% 100%', dp: '0 0% 72%', gray: true },
  { id: 'slate', lp: '220 14% 36%', lfg: '0 0% 100%', dp: '218 12% 72%', gray: true },
  { id: 'ocean', lp: '221 83% 53%', lfg: '0 0% 100%', dp: '217 91% 60%' },
  { id: 'forest', lp: '142 71% 38%', lfg: '0 0% 100%', dp: '142 65% 45%' },
  { id: 'violet', lp: '262 83% 58%', lfg: '0 0% 100%', dp: '263 70% 55%' },
  { id: 'sunset', lp: '25 95% 53%', lfg: '0 0% 100%', dp: '21 90% 50%' },
  { id: 'rose', lp: '346 77% 50%', lfg: '0 0% 100%', dp: '346 75% 55%' },
  { id: 'teal', lp: '174 72% 38%', lfg: '0 0% 100%', dp: '173 70% 46%' },
  { id: 'amber', lp: '38 92% 48%', lfg: '30 40% 14%', dp: '41 96% 56%' },
  { id: 'pastel-sky', lp: '205 74% 70%', lfg: '205 50% 22%', dp: '205 60% 64%' },
  { id: 'pastel-mint', lp: '152 48% 66%', lfg: '152 45% 20%', dp: '152 42% 58%' },
  { id: 'pastel-lavender', lp: '258 60% 76%', lfg: '258 45% 28%', dp: '258 48% 68%' },
  { id: 'pastel-rose', lp: '344 72% 78%', lfg: '344 50% 30%', dp: '344 56% 70%' },
  { id: 'pastel-peach', lp: '24 84% 74%', lfg: '20 55% 28%', dp: '22 70% 66%' },
  { id: 'pastel-butter', lp: '46 80% 70%', lfg: '40 55% 24%', dp: '46 66% 62%' },
];

const DARK_SHEET_FG = '0 0% 93%';
out.push('<!-- sidebar level-2 (full accent) audit -->');
out.push('| Theme | L sheet-1 | L sheet-2 | L fg | fg/s1 | fg/s2 | Override | D sheet-1 | D sheet-2 | D fg/s1 | D fg/s2 |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|');
const sheetRows = [];
for (const th of THEMES) {
  const [h, s, l] = parseTriple(th.lp);
  // light: sheet1 = primary verbatim; fg = theme's primaryForeground.
  // If ratio < 4.5: (a) try ink (h 55% 15%); (b) else darken sheet L until white passes.
  let s1 = triple(h, s, l);
  let s2 = triple(h, Math.min(s + 4, 100), l - 6);
  let fg = th.lfg;
  let override = '';
  const ratio = () => Math.min(contrastHex(tripleToHex(fg), tripleToHex(s1)), contrastHex(tripleToHex(fg), tripleToHex(s2)));
  if (ratio() < 4.5) {
    const ink = triple(h, th.gray ? 0 : 55, 15);
    const inkOk = contrastHex(tripleToHex(ink), tripleToHex(s1)) >= 4.5 && contrastHex(tripleToHex(ink), tripleToHex(s2)) >= 4.5;
    if (inkOk) {
      fg = ink;
      override = `fg -> ink \`${ink}\``;
    } else {
      let L = l;
      while (L > 20) {
        L -= 1;
        s1 = triple(h, s, L);
        s2 = triple(h, Math.min(s + 4, 100), L - 6);
        if (ratio() >= 4.5) break;
      }
      override = `sheet L ${l} -> ${parseTriple(s1)[2]}`;
    }
  }
  // dark: deep accent shade, fixed light fg
  const [dh, ds] = parseTriple(th.dp);
  const dsat = ds === 0 ? 0 : clamp(ds * 0.7, 12, 60);
  const d1 = triple(dh, dsat, 24);
  const d2 = triple(dh, dsat, 28.5);
  const rL1 = cr(tripleToHex(fg), tripleToHex(s1));
  const rL2 = cr(tripleToHex(fg), tripleToHex(s2));
  const rD1 = cr(tripleToHex(DARK_SHEET_FG), tripleToHex(d1));
  const rD2 = cr(tripleToHex(DARK_SHEET_FG), tripleToHex(d2));
  out.push(`| ${th.id} | \`${s1}\` | \`${s2}\` | \`${fg}\` | ${rL1} | ${rL2} | ${override || '—'} | \`${d1}\` | \`${d2}\` | ${rD1} | ${rD2} |`);
  sheetRows.push({ id: th.id, s1, s2, fg, d1, d2 });
}
out.push('');

// interfaceIntensity level table for the default theme (illustration)
out.push('<!-- intensity levels, default theme -->');
const dflt = THEMES[0];
const [h0, s0, l0] = parseTriple(dflt.lp);
const row = sheetRows[0];
const lvls = [
  { n: 0, l1: triple(h0, 0, 96), l2: triple(h0, 0, 90.5), fg: '34 9% 19%', d1: triple(h0, 0, 16), d2: triple(h0, 0, 19.5), dfg: '0 0% 82%' },
  { n: 1, l1: triple(h0, 42, 96), l2: triple(h0, 50, 90.5), fg: '34 9% 19%', d1: triple(h0, 34, 16), d2: triple(h0, 40, 19.5), dfg: '0 0% 82%' },
  { n: 2, l1: row.s1, l2: row.s2, fg: row.fg, d1: row.d1, d2: row.d2, dfg: DARK_SHEET_FG },
  // level 3 keeps the level-2 (max) sidebar; only the neutral-surface tint strengthens
  { n: 3, l1: row.s1, l2: row.s2, fg: row.fg, d1: row.d1, d2: row.d2, dfg: DARK_SHEET_FG },
];
out.push('| Level | L sheet-1 | L sheet-2 | L fg | fg/s1 | D sheet-1 | D sheet-2 | D fg | fg/s1 |');
out.push('|---|---|---|---|---|---|---|---|---|');
for (const v of lvls) {
  out.push(`| ${v.n} | \`${v.l1}\` | \`${v.l2}\` | \`${v.fg}\` | ${cr(tripleToHex(v.fg), tripleToHex(v.l1))} | \`${v.d1}\` | \`${v.d2}\` | \`${v.dfg}\` | ${cr(tripleToHex(v.dfg), tripleToHex(v.d1))} |`);
}
out.push('');

// hover/active/press veil: pole OPPOSITE the fg (black veil under light fg,
// white veil under dark fg) so the wash always increases fg contrast.
out.push('<!-- veil wash audit, level 2 (light scheme) -->');
out.push('| Theme | veil | hover (10%) | fg ratio | active (16%) | fg ratio | press (24%) | fg ratio |');
out.push('|---|---|---|---|---|---|---|---|');
for (const rw of sheetRows) {
  const fgHex = tripleToHex(rw.fg);
  const fgL = parseTriple(hexToTriple(fgHex))[2];
  const veil = fgL >= 60 ? '#000000' : '#ffffff';
  const s1Hex = tripleToHex(rw.s1);
  const hov = blend(veil, 0.1, s1Hex), act = blend(veil, 0.16, s1Hex), prs = blend(veil, 0.24, s1Hex);
  out.push(`| ${rw.id} | ${veil === '#000000' ? 'black' : 'white'} | ${hov} | ${cr(fgHex, hov)} | ${act} | ${cr(fgHex, act)} | ${prs} | ${cr(fgHex, prs)} |`);
}
out.push('');
out.push('<!-- veil wash audit, level 2 (dark scheme, white veil, fg 0 0% 93%) -->');
out.push('| Theme | hover | fg ratio | active | fg ratio | press | fg ratio |');
out.push('|---|---|---|---|---|---|---|');
for (const rw of sheetRows) {
  const fgHex = tripleToHex(DARK_SHEET_FG);
  const d1Hex = tripleToHex(rw.d1);
  // dark scheme: fg is light -> veil should be black? No: on a deep surface a
  // black veil vanishes; use WHITE veil but low alpha — fg stays >=4.5 anyway.
  const hov = blend('#ffffff', 0.08, d1Hex), act = blend('#ffffff', 0.13, d1Hex), prs = blend('#ffffff', 0.15, d1Hex);
  out.push(`| ${rw.id} | ${hov} | ${cr(fgHex, hov)} | ${act} | ${cr(fgHex, act)} | ${prs} | ${cr(fgHex, prs)} |`);
}

console.log(out.join('\n'));

// ── scheme-based veil (black in light, white in dark) + muted text audit ────
out = [];
out.push('<!-- light scheme, BLACK veil 10/16/24 -->');
out.push('| Theme | fg | hover | ratio | active | ratio | press | ratio | muted fg@0.85 vs s1 |');
out.push('|---|---|---|---|---|---|---|---|---|');
for (const rw of sheetRows) {
  const fgHex = tripleToHex(rw.fg);
  const s1Hex = tripleToHex(rw.s1);
  const hov = blend('#000000', 0.1, s1Hex), act = blend('#000000', 0.16, s1Hex), prs = blend('#000000', 0.24, s1Hex);
  const mutedFg = blend(fgHex, 0.85, s1Hex);
  out.push(`| ${rw.id} | \`${rw.fg}\` | ${hov} | ${cr(fgHex, hov)} | ${act} | ${cr(fgHex, act)} | ${prs} | ${cr(fgHex, prs)} | ${cr(mutedFg, s1Hex)} |`);
}
// levels 0/1 (light neutral sheets, dark fg) with black veil
const lv01 = [
  { id: 'level-0 light', s1: '40 0% 96%', fg: '34 9% 19%' },
  { id: 'level-1 light (default hue)', s1: '207 42% 96%', fg: '34 9% 19%' },
  { id: 'level-0 dark', s1: '0 0% 16%', fg: '0 0% 82%', dark: true },
  { id: 'level-1 dark (default hue)', s1: '207 34% 16%', fg: '0 0% 82%', dark: true },
];
for (const rw of lv01) {
  const fgHex = tripleToHex(rw.fg);
  const s1Hex = tripleToHex(rw.s1);
  const veil = rw.dark ? '#ffffff' : '#000000';
  const [a1, a2, a3] = rw.dark ? [0.08, 0.13, 0.15] : [0.1, 0.16, 0.24];
  const hov = blend(veil, a1, s1Hex), act = blend(veil, a2, s1Hex), prs = blend(veil, a3, s1Hex);
  const mutedFg = blend(fgHex, 0.85, s1Hex);
  out.push(`| ${rw.id} | \`${rw.fg}\` | ${hov} | ${cr(fgHex, hov)} | ${act} | ${cr(fgHex, act)} | ${prs} | ${cr(fgHex, prs)} | ${cr(mutedFg, s1Hex)} |`);
}
out.push('');
out.push('<!-- dark scheme muted fg@0.85 -->');
for (const rw of sheetRows) {
  const fgHex = tripleToHex(DARK_SHEET_FG);
  const d1Hex = tripleToHex(rw.d1);
  out.push(`- ${rw.id}: ${cr(blend(fgHex, 0.85, d1Hex), d1Hex)}`);
}
console.log(out.join('\n'));
