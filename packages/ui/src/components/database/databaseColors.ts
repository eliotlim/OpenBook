import type {ChartDatum} from '@open-book/sdk';

/**
 * Concrete colors for charts/boards. The `select` swatch tokens
 * ({@link SELECT_COLORS}) render as Tailwind classes elsewhere (see
 * `COLOR_CLASSES` in `databaseCells`), but charts need raw color values for
 * inline `conic-gradient` / SVG fills, so this maps each token to a hex color.
 */
export const SWATCH_HEX: Record<string, string> = {
  gray: '#9ca3af',
  brown: '#b08968',
  orange: '#f59e0b',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  red: '#ef4444',
};

/** Fallback palette for groups that carry no swatch token (cycled by index). */
export const CHART_PALETTE = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#6366f1',
  '#f97316',
];

/** Resolve a chart slice/bar color: the group's swatch if any, else the palette. */
export const chartColor = (datum: Pick<ChartDatum, 'color'>, index: number): string =>
  (datum.color && SWATCH_HEX[datum.color]) || CHART_PALETTE[index % CHART_PALETTE.length];
