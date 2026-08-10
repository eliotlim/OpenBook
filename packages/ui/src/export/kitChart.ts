/**
 * Kind-faithful kit-chart drawing (line, area, bar, pie, donut, scatter,
 * funnel, kpi, heatmap, combo) as pure SVG. The dependency-free renderer is a
 * real JS module that is also imported as raw text for the standalone runtime:
 * one implementation, without compiling a source string for static exports.
 */
import {DATA_PALETTE, DEFAULT_DATA_COLOR_SCHEME, SERIES_ORDER, type DataColorScheme} from '@book.dev/sdk';
import {drawKit} from './kitChartRuntime.js';
import KIT_CHART_JS from './kitChartRuntime.js?raw';

export {KIT_CHART_JS};

/** The chart's fixed view-box dimensions (mirrors the runtime source). */
export const KIT_CHART_W = 660;
export const KIT_CHART_H = 300;

const paletteFor = (scheme: DataColorScheme): string[] =>
  SERIES_ORDER.map((token) => DATA_PALETTE[scheme][token].fill);

/** The canonical series fills, as a JS literal prepended to the raw runtime. */
export const kitPaletteJs = (scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  `const KIT_PALETTE=${JSON.stringify(paletteFor(scheme))};`;

/** Palette plus the dependency-free drawing module, ready for an inline module. */
export const kitChartRuntime = (scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  `${kitPaletteJs(scheme)}\n${KIT_CHART_JS}`;

/**
 * Draw a kit chart to an SVG string for a value/kind/labels in `scheme`.
 * Returns '' when there is nothing plottable or malformed input reaches the
 * renderer. Static exports call the renderer directly; no runtime compilation.
 */
export function kitChartSvg(
  value: unknown,
  kind: string,
  labels: string[] = [],
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
): string {
  try {
    return drawKit(value, kind, labels, paletteFor(scheme));
  } catch {
    return '';
  }
}
