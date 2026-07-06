/**
 * Runtime plumbing for the canonical data palette (`@book.dev/sdk` dataColors):
 * writes the palette as CSS variables so chips, dots, swatches, charts and
 * status lights all read one live source, and dark-mode / future per-page
 * scheme overrides come free (manifest §4.3).
 *
 * Variables (on `:root`, chip + stroke values flipped by `.dark`):
 *
 *   --data-<token>            fill (mode-invariant)
 *   --data-<token>-chip-bg    select-chip background for the active mode
 *   --data-<token>-chip-fg    select-chip text for the active mode
 *   --data-series-1 … -12     SERIES_ORDER fills (aliases, for charts)
 *   --data-status-ok|warn|bad status-lamp fills (aliases)
 *   --data-stroke             pastel/muted light-mode hairline (else transparent)
 *
 * Consumers should use the `…Var()` helpers below: they carry the
 * default-scheme value as a `var()` fallback so provider-less embeds (the
 * published-site viewer mounts BlockEditor without providers) still render.
 */
import {
  DATA_COLOR_TOKENS,
  DATA_PALETTE,
  DATA_STROKE,
  DEFAULT_DATA_COLOR_SCHEME,
  SERIES_ORDER,
  STATUS_TOKENS,
  isDataColorToken,
  type DataColorScheme,
  type DataColorToken,
} from '@book.dev/sdk';

const DEFAULTS = DATA_PALETTE[DEFAULT_DATA_COLOR_SCHEME];

/** CSS for the given scheme: `:root` light values + a `.dark` flip block. */
export function dataColorCss(scheme: DataColorScheme): string {
  const palette = DATA_PALETTE[scheme];
  const root: string[] = [];
  const dark: string[] = [];
  for (const t of DATA_COLOR_TOKENS) {
    const c = palette[t];
    root.push(`--data-${t}:${c.fill};`, `--data-${t}-chip-bg:${c.chip.light.bg};`, `--data-${t}-chip-fg:${c.chip.light.fg};`);
    // Dot/swatch fill flips to the dark-mode fill; chip bg/fg flip too. (`--data-series-*`
    // and `--data-status-*` alias `--data-<token>`, so they inherit the flip.)
    dark.push(`--data-${t}:${c.fillDark};`, `--data-${t}-chip-bg:${c.chip.dark.bg};`, `--data-${t}-chip-fg:${c.chip.dark.fg};`);
  }
  SERIES_ORDER.forEach((t, i) => root.push(`--data-series-${i + 1}:var(--data-${t});`));
  for (const [state, token] of Object.entries(STATUS_TOKENS)) root.push(`--data-status-${state}:var(--data-${token});`);
  // Hairline: pastel/muted, light mode only.
  root.push(`--data-stroke:${scheme === 'vivid' ? 'transparent' : DATA_STROKE};`);
  dark.push('--data-stroke:transparent;');
  return `:root{${root.join('')}}\n.dark{${dark.join('')}}`;
}

const STYLE_ID = 'ob-data-colors';

/**
 * Install (or swap) the data-colour variables for a scheme. Fixed to the
 * default (pastel) by the caller until the "Data colours" appearance control
 * lands (OB-379) — the scheme parameter is the plumbing for it.
 */
export function applyDataColors(scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const css = dataColorCss(scheme);
  if (el.textContent !== css) el.textContent = css;
}

// ── var() accessors (with default-scheme fallbacks for provider-less mounts) ─

/** The fill colour of a data token as a live CSS value. */
export const dataFillVar = (token: DataColorToken): string => `var(--data-${token}, ${DEFAULTS[token].fill})`;

/** The fill of a select swatch token, or `undefined` for unknown/absent tokens. */
export const swatchColor = (token: string | undefined | null): string | undefined =>
  isDataColorToken(token) ? dataFillVar(token) : undefined;

/** The default (gray) swatch fill. */
export const DEFAULT_SWATCH = dataFillVar('gray');

/** The fill for chart series `i` (cycles over `SERIES_ORDER`). */
export const seriesFillVar = (i: number): string => {
  const n = ((i % SERIES_ORDER.length) + SERIES_ORDER.length) % SERIES_ORDER.length;
  return `var(--data-series-${n + 1}, ${DEFAULTS[SERIES_ORDER[n]].fill})`;
};

// ── Resolved concrete-hex accessors (fixed default scheme) ──────────────────
// For consumers that CANNOT resolve `var()`: `<canvas>` contexts, Leaflet
// markers, and SVG *presentation attributes* (`fill="…"`). They pin to the
// fixed default (pastel) scheme — the "Data colours" control (OB-379) will make
// these reactive; today OB-378 keeps the scheme constant.

/** The resolved (non-var) fill hex for a token, or `undefined` when unknown. */
export const swatchHex = (token: string | undefined | null): string | undefined =>
  isDataColorToken(token) ? DEFAULTS[token].fill : undefined;

/** The resolved (non-var) fill hex for chart series `i` (cycles `SERIES_ORDER`). */
export const seriesHex = (i: number): string => {
  const n = ((i % SERIES_ORDER.length) + SERIES_ORDER.length) % SERIES_ORDER.length;
  return DEFAULTS[SERIES_ORDER[n]].fill;
};

/** Select-chip background/text for a token (gray when unknown). */
export const chipBgVar = (token: string | undefined | null): string => {
  const t = isDataColorToken(token) ? token : 'gray';
  return `var(--data-${t}-chip-bg, ${DEFAULTS[t].chip.light.bg})`;
};
export const chipFgVar = (token: string | undefined | null): string => {
  const t = isDataColorToken(token) ? token : 'gray';
  return `var(--data-${t}-chip-fg, ${DEFAULTS[t].chip.light.fg})`;
};

/** The pastel/muted light-mode hairline stroke (transparent in vivid/dark). */
export const dataStrokeVar = (): string => `var(--data-stroke, ${DATA_STROKE})`;

/** Inset hairline ring for swatch dots and status lamps. */
export const DATA_DOT_RING = `inset 0 0 0 1px ${dataStrokeVar()}`;
