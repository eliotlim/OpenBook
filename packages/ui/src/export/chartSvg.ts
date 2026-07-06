/**
 * Build a standalone Observable Plot SVG for a set of normalized series — the
 * same line chart the live `ChartBlock` renders, but as a detached element for
 * embedding (vector) into a PDF or static HTML export. Requires a DOM (browser /
 * happy-dom). Returns `null` when there is nothing plottable.
 */
import * as Plot from '@observablehq/plot';
import {DEFAULT_DATA_COLOR_SCHEME, type DataColorScheme} from '@book.dev/sdk';
import {paletteFor} from '../blockeditor/kit/chartMath';
import type {NormalizedSeries} from './chartNormalize';

export function buildChartSvg(
  series: NormalizedSeries[],
  width = 600,
  color = '#111111',
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
): SVGElement | null {
  const usable = series.filter((s) => s.data.length > 0);
  if (usable.length === 0) return null;
  const longData: Array<{i: number; y: number; series: string}> = [];
  for (const s of usable) for (let i = 0; i < s.data.length; i += 1) longData.push({i, y: s.data[i], series: s.name});

  const chart = Plot.plot({
    marks: [Plot.lineY(longData, {x: 'i', y: 'y', stroke: 'series'})],
    width,
    height: Math.round(width * 0.5),
    marginTop: 16,
    marginRight: 16,
    marginBottom: 32,
    marginLeft: 44,
    style: {background: 'transparent', color, fontSize: '12px'},
    grid: true,
    // Series map to the canonical data palette for the active scheme (the same
    // blue-first SERIES_ORDER fills the kit/db charts use), so an exported
    // kind-less chart colour-matches in-app instead of Plot's default scheme.
    // No legend so Plot returns a single <svg> (not a <figure>), which svg2pdf
    // can embed directly.
    color: {range: paletteFor(scheme), legend: false},
  }) as unknown as SVGElement;
  return chart;
}
