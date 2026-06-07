/**
 * Named color themes. Like zxcv's, each theme keeps the shared warm-minimal
 * neutral base and swaps the accent family (`--primary` / `--ring` plus
 * open-book's `--brand*`), so the design language stays consistent while the
 * highlight color changes. A theme is the full token set (light + dark); the
 * provider writes those HSL-triple vars onto `document.documentElement`. The
 * `.dark` class (Tailwind's dark variant) is still toggled separately by the
 * ThemeProvider — this only sets color values.
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

export interface Theme {
  id: string;
  /** i18n key for the display name (see messages `theme.*`). */
  nameKey: string;
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

const DEFAULT_DARK: ThemeTokens = {
  background: '0 0% 11%',
  foreground: '0 0% 87%',
  card: '0 0% 14.5%',
  cardForeground: '0 0% 87%',
  popover: '0 0% 15%',
  popoverForeground: '0 0% 87%',
  primary: '207 80% 57%',
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 17%',
  secondaryForeground: '0 0% 87%',
  muted: '0 0% 17%',
  mutedForeground: '0 0% 55%',
  accent: '0 0% 21%',
  accentForeground: '0 0% 92%',
  destructive: '4 64% 51%',
  destructiveForeground: '0 0% 100%',
  border: '0 0% 20%',
  input: '0 0% 25%',
  ring: '207 80% 57%',
  sheet1: '0 0% 14%',
  sheet1Foreground: '0 0% 87%',
  sheet2: '0 0% 17.5%',
  sheet2Foreground: '0 0% 87%',
  brand: '207 80% 60%',
  brandForeground: '0 0% 100%',
  brandSubtle: '208 55% 21%',
};

interface Accent {
  primary: string;
  ring?: string;
  brand?: string;
  brandSubtle: string;
  primaryForeground?: string;
}

/** Build a theme that swaps only the accent family over the shared base. */
function accentTheme(id: string, light: Accent, dark: Accent): Theme {
  const apply = (base: ThemeTokens, a: Accent): ThemeTokens => ({
    ...base,
    primary: a.primary,
    primaryForeground: a.primaryForeground ?? '0 0% 100%',
    ring: a.ring ?? a.primary,
    brand: a.brand ?? a.primary,
    brandForeground: '0 0% 100%',
    brandSubtle: a.brandSubtle,
  });
  return {id, nameKey: `theme.${id}`, light: apply(DEFAULT_LIGHT, light), dark: apply(DEFAULT_DARK, dark)};
}

export const DEFAULT_THEME_ID = 'default';

export const themes: Theme[] = [
  {id: 'default', nameKey: 'theme.default', light: DEFAULT_LIGHT, dark: DEFAULT_DARK},
  accentTheme(
    'ocean',
    {primary: '221 83% 53%', brandSubtle: '221 86% 95%'},
    {primary: '217 91% 60%', brandSubtle: '221 55% 21%'},
  ),
  accentTheme(
    'forest',
    {primary: '142 71% 38%', brandSubtle: '142 60% 94%'},
    {primary: '142 65% 45%', brandSubtle: '142 40% 18%'},
  ),
  accentTheme(
    'violet',
    {primary: '262 83% 58%', brandSubtle: '262 80% 96%'},
    {primary: '263 70% 55%', brandSubtle: '263 45% 24%'},
  ),
  accentTheme(
    'sunset',
    {primary: '25 95% 53%', brandSubtle: '28 90% 94%'},
    {primary: '21 90% 50%', brandSubtle: '25 60% 22%'},
  ),
  accentTheme(
    'rose',
    {primary: '346 77% 50%', brandSubtle: '346 80% 96%'},
    {primary: '346 75% 55%', brandSubtle: '346 45% 24%'},
  ),
  accentTheme(
    'graphite',
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

const cssVar = (key: string): string => `--${key.replace(/([A-Z0-9])/g, '-$1').toLowerCase()}`;

/** Write a theme's palette (for the given scheme) onto the document root. */
export function applyTheme(theme: Theme, scheme: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const tokens = scheme === 'dark' ? theme.dark : theme.light;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(cssVar(key), value);
}
