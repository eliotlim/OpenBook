/**
 * Named color themes + a small parametric appearance model on top of them.
 *
 * Like zxcv's, each theme keeps the shared warm-minimal neutral base and swaps
 * the *accent* family (`--primary` / `--ring` plus open-book's `--brand*`), so
 * the design language stays consistent while the highlight color changes.
 *
 * On top of the accent palette the user controls four knobs (see
 * {@link AppearanceOptions}): the **neutral temperature** (warm / cool /
 * neutral gray), the **interface intensity** (how saturated those grays are),
 * the **control intensity** of the faded control accent (`--accent`), and
 * whether the **sidebar adopts the accent**. {@link composeAppearance} folds an
 * accent palette + those knobs into one token set; {@link applyAppearance}
 * writes it onto an element (the document root globally, or a page wrapper for a
 * per-page override).
 *
 * The crucial invariant: {@link DEFAULT_APPEARANCE} composes to the *exact*
 * legacy palette (verbatim from index.css) in both schemes, so the parametric
 * system is a no-op until the user actually turns a knob.
 *
 * `--radius` is intentionally not themed (it's part of the brand geometry).
 */

/** One palette: every themable token as an `H S% L%` triple (no `hsl(...)`). */
export interface ThemeTokens {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sheet1: string;
  sheet1Foreground: string;
  sheet2: string;
  sheet2Foreground: string;
  brand: string;
  brandForeground: string;
  brandSubtle: string;
}

/** Accent palettes are grouped in the picker so bold and soft hues don't mix. */
export type AccentGroup = 'bold' | 'pastel' | 'neutral';

export interface Theme {
  id: string;
  /** i18n key for the display name (see messages `theme.*`). */
  nameKey: string;
  /** Picker grouping (default `bold`). */
  group?: AccentGroup;
  light: ThemeTokens;
  dark: ThemeTokens;
}

// The current warm-minimal palette (verbatim from index.css) — the Default theme.
const DEFAULT_LIGHT: ThemeTokens = {
  background: '0 0% 100%',
  foreground: '34 9% 19%',
  card: '0 0% 100%',
  cardForeground: '34 9% 19%',
  popover: '0 0% 100%',
  popoverForeground: '34 9% 19%',
  primary: '207 75% 49%',
  primaryForeground: '0 0% 100%',
  secondary: '40 9% 96%',
  secondaryForeground: '34 9% 19%',
  muted: '40 9% 96%',
  mutedForeground: '40 3% 48%',
  accent: '40 12% 93%',
  accentForeground: '34 9% 19%',
  destructive: '4 74% 53%',
  destructiveForeground: '0 0% 100%',
  border: '40 8% 90%',
  input: '40 8% 87%',
  ring: '207 75% 49%',
  sheet1: '40 14% 97.5%',
  sheet1Foreground: '34 9% 19%',
  sheet2: '40 11% 93.5%',
  sheet2Foreground: '34 9% 19%',
  brand: '207 76% 47%',
  brandForeground: '0 0% 100%',
  brandSubtle: '207 86% 95%',
};

// Softened 2026-06-13 to lower dark-mode contrast (must stay in lockstep with
// the `.dark` block in index.css — applyAppearance writes these inline).
const DEFAULT_DARK: ThemeTokens = {
  background: '0 0% 13%',
  foreground: '0 0% 82%',
  card: '0 0% 16%',
  cardForeground: '0 0% 82%',
  popover: '0 0% 16.5%',
  popoverForeground: '0 0% 82%',
  primary: '207 68% 55%',
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 18.5%',
  secondaryForeground: '0 0% 82%',
  muted: '0 0% 18.5%',
  mutedForeground: '0 0% 56%',
  accent: '0 0% 22%',
  accentForeground: '0 0% 86%',
  destructive: '4 58% 52%',
  destructiveForeground: '0 0% 100%',
  border: '0 0% 22%',
  input: '0 0% 26%',
  ring: '207 68% 55%',
  sheet1: '0 0% 15.5%',
  sheet1Foreground: '0 0% 82%',
  sheet2: '0 0% 18.5%',
  sheet2Foreground: '0 0% 82%',
  brand: '207 70% 57%',
  brandForeground: '0 0% 100%',
  brandSubtle: '208 48% 22%',
};

interface Accent {
  primary: string;
  ring?: string;
  brand?: string;
  brandSubtle: string;
  primaryForeground?: string;
}

/** Build a theme that swaps only the accent family over the shared base. */
function accentTheme(id: string, group: AccentGroup, light: Accent, dark: Accent): Theme {
  const apply = (base: ThemeTokens, a: Accent): ThemeTokens => ({
    ...base,
    primary: a.primary,
    primaryForeground: a.primaryForeground ?? '0 0% 100%',
    ring: a.ring ?? a.primary,
    brand: a.brand ?? a.primary,
    brandForeground: a.primaryForeground ?? '0 0% 100%',
    brandSubtle: a.brandSubtle,
  });
  return {id, nameKey: `theme.${id}`, group, light: apply(DEFAULT_LIGHT, light), dark: apply(DEFAULT_DARK, dark)};
}

export const DEFAULT_THEME_ID = 'default';

export const themes: Theme[] = [
  {id: 'default', nameKey: 'theme.default', group: 'bold', light: DEFAULT_LIGHT, dark: DEFAULT_DARK},
  // ── Bold accents ─────────────────────────────────────────────────────────
  accentTheme(
    'ocean',
    'bold',
    {primary: '221 83% 53%', brandSubtle: '221 86% 95%'},
    {primary: '217 91% 60%', brandSubtle: '221 55% 21%'},
  ),
  accentTheme(
    'forest',
    'bold',
    {primary: '142 71% 38%', brandSubtle: '142 60% 94%'},
    {primary: '142 65% 45%', brandSubtle: '142 40% 18%'},
  ),
  accentTheme(
    'violet',
    'bold',
    {primary: '262 83% 58%', brandSubtle: '262 80% 96%'},
    {primary: '263 70% 55%', brandSubtle: '263 45% 24%'},
  ),
  accentTheme(
    'sunset',
    'bold',
    {primary: '25 95% 53%', brandSubtle: '28 90% 94%'},
    {primary: '21 90% 50%', brandSubtle: '25 60% 22%'},
  ),
  accentTheme(
    'rose',
    'bold',
    {primary: '346 77% 50%', brandSubtle: '346 80% 96%'},
    {primary: '346 75% 55%', brandSubtle: '346 45% 24%'},
  ),
  accentTheme(
    'teal',
    'bold',
    {primary: '174 72% 38%', brandSubtle: '174 60% 93%'},
    {primary: '173 70% 46%', brandSubtle: '174 45% 18%'},
  ),
  accentTheme(
    'amber',
    'bold',
    {primary: '38 92% 48%', primaryForeground: '30 40% 14%', brandSubtle: '40 90% 92%'},
    {primary: '41 96% 56%', primaryForeground: '30 45% 12%', brandSubtle: '38 55% 20%'},
  ),
  // ── Pastel accents (soft fills, dark ink so buttons stay legible) ─────────
  accentTheme(
    'pastel-sky',
    'pastel',
    {primary: '205 74% 70%', primaryForeground: '205 50% 22%', brandSubtle: '205 70% 95%'},
    {primary: '205 60% 64%', primaryForeground: '205 45% 14%', brandSubtle: '205 38% 24%'},
  ),
  accentTheme(
    'pastel-mint',
    'pastel',
    {primary: '152 48% 66%', primaryForeground: '152 45% 20%', brandSubtle: '152 50% 94%'},
    {primary: '152 42% 58%', primaryForeground: '152 45% 12%', brandSubtle: '152 32% 22%'},
  ),
  accentTheme(
    'pastel-lavender',
    'pastel',
    {primary: '258 60% 76%', primaryForeground: '258 45% 28%', brandSubtle: '258 60% 96%'},
    {primary: '258 48% 68%', primaryForeground: '258 40% 14%', brandSubtle: '258 35% 26%'},
  ),
  accentTheme(
    'pastel-rose',
    'pastel',
    {primary: '344 72% 78%', primaryForeground: '344 50% 30%', brandSubtle: '344 72% 96%'},
    {primary: '344 56% 70%', primaryForeground: '344 45% 14%', brandSubtle: '344 38% 26%'},
  ),
  accentTheme(
    'pastel-peach',
    'pastel',
    {primary: '24 84% 74%', primaryForeground: '20 55% 28%', brandSubtle: '26 84% 94%'},
    {primary: '22 70% 66%', primaryForeground: '20 50% 14%', brandSubtle: '24 45% 24%'},
  ),
  accentTheme(
    'pastel-butter',
    'pastel',
    {primary: '46 80% 70%', primaryForeground: '40 55% 24%', brandSubtle: '46 84% 92%'},
    {primary: '46 66% 62%', primaryForeground: '40 50% 12%', brandSubtle: '44 42% 22%'},
  ),
  // ── Neutral accent ───────────────────────────────────────────────────────
  accentTheme(
    'graphite',
    'neutral',
    {primary: '215 25% 35%', brandSubtle: '215 25% 92%'},
    {primary: '215 20% 65%', primaryForeground: '215 28% 12%', brandSubtle: '215 18% 24%'},
  ),
];

export const getTheme = (id: string): Theme => themes.find((t) => t.id === id) ?? themes[0];

/** Resolve the OS color-scheme preference. */
export function getSystemColorScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ── Parametric appearance ────────────────────────────────────────────────────

/**
 * The temperature of the neutral grays. The interface is always a gray; this
 * only leans it warm or cool (or keeps it dead neutral). There's no longer a
 * "tint the whole UI with the accent" option — that mechanism was removed.
 */
export type NeutralFamily = 'warm' | 'cool' | 'neutral';

/** 0 = off … 3 = strong. Shared scale for the interface- and control-intensity knobs. */
export type Level = 0 | 1 | 2 | 3;

/**
 * The user's full appearance choice. `DEFAULT_APPEARANCE` reproduces the legacy
 * palette exactly, so any field left at its default is a visual no-op.
 */
export interface AppearanceOptions {
  /** Accent palette id (see {@link themes}). */
  themeId: string;
  /** Temperature of the neutral grays (warm / cool / neutral). */
  neutral: NeutralFamily;
  /** How saturated the neutral surfaces are. */
  interfaceIntensity: Level;
  /** How colored the faded control surface (`--accent`) is. */
  controlIntensity: Level;
  /** Sidebar sheets adopt the accent hue. */
  tintedSidebar: boolean;
  /** Optional page-canvas tint (a {@link PAGE_BACKGROUNDS} token). Mostly used
   *  per page; unset means the canvas keeps the theme's default `--background`. */
  background?: string;
}

/** Soft full-canvas tints for the per-page "Background" control (token → HSL). */
export const PAGE_BACKGROUNDS: Record<string, {light: string; dark: string}> = {
  gray: {light: '0 0% 96.5%', dark: '0 0% 15%'},
  red: {light: '6 60% 97.5%', dark: '4 26% 14.5%'},
  orange: {light: '28 70% 96.5%', dark: '24 28% 14.5%'},
  yellow: {light: '46 78% 96%', dark: '44 26% 14%'},
  green: {light: '140 42% 96.5%', dark: '140 22% 14%'},
  blue: {light: '210 58% 97.5%', dark: '210 28% 15%'},
  purple: {light: '265 48% 97.5%', dark: '265 24% 15.5%'},
  pink: {light: '330 58% 97.5%', dark: '330 24% 15.5%'},
};

export const DEFAULT_APPEARANCE: AppearanceOptions = {
  themeId: DEFAULT_THEME_ID,
  neutral: 'warm',
  interfaceIntensity: 2,
  controlIntensity: 2,
  tintedSidebar: false,
};

/** A per-page override: any subset of the global appearance. */
export type AppearanceOverride = Partial<AppearanceOptions>;

/**
 * Migrate a persisted (possibly older-shape) appearance to the current model:
 * `tint`→`interfaceIntensity`, `accentIntensity`→`controlIntensity`, and the
 * dropped neutral families (`gray`→`neutral`, `match`→`warm`). Unknown keys are
 * dropped by the `{...DEFAULT_APPEARANCE, ...}` merge at the call site.
 */
export function normalizeAppearance(raw: Record<string, unknown>): AppearanceOverride {
  const out: Record<string, unknown> = {...raw};
  if (out.tint !== undefined && out.interfaceIntensity === undefined) out.interfaceIntensity = out.tint;
  if (out.accentIntensity !== undefined && out.controlIntensity === undefined) out.controlIntensity = out.accentIntensity;
  delete out.tint;
  delete out.accentIntensity;
  if (out.neutral === 'gray') out.neutral = 'neutral';
  if (out.neutral === 'match') out.neutral = 'warm';
  return out as AppearanceOverride;
}

/** Merge a (possibly partial) override over a base, dropping undefined keys. */
export function mergeAppearance(base: AppearanceOptions, override?: AppearanceOverride | null): AppearanceOptions {
  if (!override) return base;
  const out = {...base};
  for (const k of Object.keys(override) as Array<keyof AppearanceOptions>) {
    const v = override[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Parse an `H S% L%` triple (the token format used throughout). */
function parseHsl(triple: string): Hsl {
  const [h, s, l] = triple.replace(/%/g, '').trim().split(/\s+/).map(Number);
  return {h: h || 0, s: s || 0, l: l || 0};
}

const num = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

const toTriple = ({h, s, l}: Hsl): string =>
  `${num(((h % 360) + 360) % 360)} ${num(clamp(s, 0, 100))}% ${num(clamp(l, 0, 100))}%`;

const hueOf = (triple: string): number => parseHsl(triple).h;

// Saturation multipliers applied to a surface's *base* saturation. Index by the
// tint level. Level 2 is the default → multiplier 1, so the default reproduces
// the base palette exactly.
const TINT_MUL = [0, 0.55, 1, 1.5] as const;
// A minimum saturation (× per-surface weight) that only engages at the strong
// level, so even fully-desaturated dark surfaces can pick up a hue when asked.
const TINT_FLOOR_LIGHT = [0, 0, 0, 3] as const;
const TINT_FLOOR_DARK = [0, 0, 0, 6] as const;

// `--accent` (the faded control surface) follows the same idea on its own scale.
const ACCENT_MUL = [0, 0.55, 1, 1.7] as const;
const ACCENT_FLOOR_LIGHT = [0, 0, 0, 6] as const;
const ACCENT_FLOOR_DARK = [0, 0, 0, 11] as const;

// Per-surface saturation weight (how strongly each neutral takes the tint). The
// canvas (background/card/popover) carries the least so the page stays paper.
const SURFACE_WEIGHT: Record<string, number> = {
  background: 0.35,
  card: 0.35,
  popover: 0.32,
  secondary: 0.85,
  muted: 0.85,
  input: 0.9,
  border: 0.85,
  sheet1: 1.2,
  sheet2: 1.3,
};

const NEUTRAL_KEYS = Object.keys(SURFACE_WEIGHT) as Array<keyof ThemeTokens>;

const FAMILY_HUE: Record<NeutralFamily, number> = {
  warm: 40,
  cool: 220,
  neutral: 0, // saturation forced to 0; hue irrelevant
};

/**
 * Fold an accent palette + the appearance knobs into a full token set for one
 * color scheme. Pure (no DOM) so it powers both the global apply and the inline
 * per-page style, and is unit-testable.
 */
export function composeAppearance(opts: AppearanceOptions, scheme: 'light' | 'dark'): ThemeTokens {
  const theme = getTheme(opts.themeId);
  const base = scheme === 'dark' ? theme.dark : theme.light;
  const tokens: ThemeTokens = {...base};

  const accentHue = hueOf(base.primary);
  const familyHue = FAMILY_HUE[opts.neutral];
  const gray = opts.neutral === 'neutral';
  const tintFloor = (scheme === 'dark' ? TINT_FLOOR_DARK : TINT_FLOOR_LIGHT)[opts.interfaceIntensity];

  // Neutral surfaces: keep their base lightness, restyle hue + saturation.
  for (const key of NEUTRAL_KEYS) {
    const c = parseHsl(base[key]);
    const weight = SURFACE_WEIGHT[key];
    const sat = gray ? 0 : Math.max(c.s * TINT_MUL[opts.interfaceIntensity], tintFloor * weight);
    const hue = gray ? c.h : familyHue;
    tokens[key] = toTriple({h: hue, s: sat, l: c.l});
  }

  // The faded control accent (`--accent`): hue follows the neutral family (so it
  // sits on the surfaces), saturation is the user's control-intensity knob.
  {
    const c = parseHsl(base.accent);
    const accentFloor = (scheme === 'dark' ? ACCENT_FLOOR_DARK : ACCENT_FLOOR_LIGHT)[opts.controlIntensity];
    const sat = gray ? 0 : Math.max(c.s * ACCENT_MUL[opts.controlIntensity], accentFloor);
    const hue = gray ? c.h : familyHue;
    tokens.accent = toTriple({h: hue, s: sat, l: c.l});
  }

  // Optional page-canvas tint (per-page background). Only the canvas surfaces
  // shift; cards/popovers keep their own fill so they lift off the tint.
  if (opts.background && PAGE_BACKGROUNDS[opts.background]) {
    tokens.background = PAGE_BACKGROUNDS[opts.background][scheme];
  }

  // Tinted sidebar: the sheets adopt the accent hue as a soft colored panel.
  if (opts.tintedSidebar) {
    if (scheme === 'dark') {
      tokens.sheet1 = toTriple({h: accentHue, s: 26, l: 16});
      tokens.sheet2 = toTriple({h: accentHue, s: 30, l: 19.5});
    } else {
      tokens.sheet1 = toTriple({h: accentHue, s: 30, l: 96});
      tokens.sheet2 = toTriple({h: accentHue, s: 34, l: 91});
    }
  }

  return tokens;
}

const cssVar = (key: string): string => `--${key.replace(/([A-Z0-9])/g, '-$1').toLowerCase()}`;

/** A composed appearance as a CSS-variable map, for use as an inline `style`. */
export function appearanceStyle(opts: AppearanceOptions, scheme: 'light' | 'dark'): Record<string, string> {
  const tokens = composeAppearance(opts, scheme);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) out[cssVar(key)] = value;
  return out;
}

/** Write a composed appearance onto an element (defaults to the document root). */
export function applyAppearance(
  opts: AppearanceOptions,
  scheme: 'light' | 'dark',
  target?: HTMLElement,
): void {
  const el = target ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!el) return;
  const tokens = composeAppearance(opts, scheme);
  for (const [key, value] of Object.entries(tokens)) el.style.setProperty(cssVar(key), value);
}

/** Write a theme's palette (for the given scheme) onto the document root.
 *  Legacy entry point — prefer {@link applyAppearance}. */
export function applyTheme(theme: Theme, scheme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const tokens = scheme === 'dark' ? theme.dark : theme.light;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(cssVar(key), value);
}
