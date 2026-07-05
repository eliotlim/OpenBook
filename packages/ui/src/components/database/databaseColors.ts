/**
 * Data colours for database views (charts, boards, timelines, swatch dots).
 *
 * Thin layer over the canonical palette (`@book.dev/sdk` dataColors) exposed
 * as live CSS variables by `lib/dataColorVars` — the old hard-coded
 * `SWATCH_HEX` / `CHART_PALETTE` lists are gone (OB-378). Select swatch tokens
 * ({@link SELECT_COLORS}) resolve through {@link swatchColor}; series colours
 * cycle the canonical `SERIES_ORDER` shared with the kit charts.
 */
import type {ChartDatum} from '@book.dev/sdk';
import {DATA_DOT_RING, DEFAULT_SWATCH, seriesFillVar, swatchColor} from '@/lib/dataColorVars';

export {swatchColor, DEFAULT_SWATCH, DATA_DOT_RING};

/** Resolve a chart slice/bar colour: the group's swatch if any, else the canonical series cycle. */
export const chartColor = (datum: Pick<ChartDatum, 'color'>, index: number): string =>
  swatchColor(datum.color) ?? seriesFillVar(index);

/** Inline style for a small swatch dot: token fill + the scheme's hairline ring. */
export const dotStyle = (color: string | undefined | null): {backgroundColor: string; boxShadow: string} => ({
  backgroundColor: swatchColor(color) ?? DEFAULT_SWATCH,
  boxShadow: DATA_DOT_RING,
});
