/**
 * Data colours for database views (charts, boards, timelines, swatch dots).
 *
 * Thin layer over the canonical palette (`@book.dev/sdk` dataColors) exposed by
 * `lib/dataColorVars` — the old hard-coded `SWATCH_HEX` / `CHART_PALETTE` lists
 * are gone (OB-378). Swatch dots resolve through {@link swatchColor} (live CSS
 * vars, so dark-mode + a future per-page scheme come free); chart fills resolve
 * to concrete hex via {@link chartColor} because SVG *presentation attributes*
 * (`fill="…"`) don't resolve `var()`. Both read the same canonical `SERIES_ORDER`
 * shared with the kit charts, so every surface agrees.
 */
import type {ChartDatum} from '@book.dev/sdk';
import {DATA_DOT_RING, DEFAULT_SWATCH, seriesHex, swatchColor, swatchHex} from '@/lib/dataColorVars';

export {swatchColor, swatchHex, DEFAULT_SWATCH, DATA_DOT_RING};

/**
 * Resolve a chart slice/bar colour to a **concrete hex** (the group's swatch if
 * any, else the canonical series cycle). Concrete rather than a `var()` because
 * db charts paint SVG via the `fill` presentation attribute, which never
 * resolves custom properties.
 */
export const chartColor = (datum: Pick<ChartDatum, 'color'>, index: number): string =>
  swatchHex(datum.color) ?? seriesHex(index);

/** Inline style for a small swatch dot: token fill + the scheme's hairline ring. */
export const dotStyle = (color: string | undefined | null): {backgroundColor: string; boxShadow: string} => ({
  backgroundColor: swatchColor(color) ?? DEFAULT_SWATCH,
  boxShadow: DATA_DOT_RING,
});
