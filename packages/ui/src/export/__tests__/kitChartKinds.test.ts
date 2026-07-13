import {describe, expect, it} from 'vitest';
import {DATA_PALETTE, DEFAULT_DATA_COLOR_SCHEME, SERIES_ORDER} from '@book.dev/sdk';
import {kitChartSvg} from '../kitChart';

// The static/interactive HTML export draws kit charts via the `drawKit` runtime
// string (executed here through kitChartSvg) with ONLY {value, kind, labels} —
// no matrix channel. These assert the DASH-5 kinds export faithfully from the
// same flat value the in-editor kinds read (the export switch, separate from the
// registry, is easy to forget — a kind that renders in-editor but exports blank).

const P0 = DATA_PALETTE[DEFAULT_DATA_COLOR_SCHEME][SERIES_ORDER[0]].fill;

describe('kitChartSvg — KPI kind exports', () => {
  it('renders a scalar as the big figure, with its caption', () => {
    const svg = kitChartSvg(42, 'kpi', ['Revenue']);
    expect(svg).toContain('<svg');
    expect(svg).toContain('>42<');
    expect(svg).toContain('REVENUE'); // caption is upper-cased in the export text
  });

  it('sums a series and omits the progress bar without a target', () => {
    const svg = kitChartSvg([10, 20, 30], 'kpi', []);
    expect(svg).toContain('>60<');
    expect(svg).not.toContain('% of');
  });

  it('draws the target readout + a palette-filled progress bar from {value, target}', () => {
    const svg = kitChartSvg({value: 82, target: 100}, 'kpi', ['Revenue']);
    expect(svg).toContain('>82<');
    expect(svg).toContain('82% of 100');
    expect(svg).toContain(`fill="${P0}"`); // the progress fill uses the canonical palette
  });

  it('returns nothing when there is no numeric figure', () => {
    expect(kitChartSvg({}, 'kpi', [])).toBe('');
  });
});

describe('kitChartSvg — heatmap kind exports', () => {
  it('draws a cell per grid entry with intensity + row/column labels', () => {
    const svg = kitChartSvg({a: [1, 2], b: [3, 4]}, 'heatmap', ['X', 'Y']);
    expect(svg).toContain('<svg');
    // 4 cells, each a palette-hued rect carrying a fill-opacity intensity.
    expect((svg.match(/fill-opacity=/g) ?? []).length).toBe(4);
    expect(svg).toContain(`fill="${P0}"`);
    // Row labels (series names) and column labels (per-point labels).
    expect(svg).toContain('>a<');
    expect(svg).toContain('>b<');
    expect(svg).toContain('>X<');
    expect(svg).toContain('>Y<');
    // In-cell value text.
    expect(svg).toContain('>4<');
  });

  it('returns nothing with no plottable data', () => {
    expect(kitChartSvg({}, 'heatmap', [])).toBe('');
  });
});

describe('kitChartSvg — combo kind exports', () => {
  it('draws the first series as bars and the rest as an overlaid line', () => {
    const svg = kitChartSvg({Sales: [3, 1, 4], Trend: [2, 2, 2]}, 'combo', ['A', 'B', 'C']);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<rect'); // bars
    expect(svg).toContain('<polyline'); // the overlaid trend line
    expect(svg).toContain(`fill="${P0}"`); // bars use the canonical first palette colour
    // A legend for the two named series + the x labels.
    expect(svg).toContain('>Sales<');
    expect(svg).toContain('>Trend<');
    expect(svg).toContain('>A<');
  });

  it('degrades a single series to a plain bar chart (no line)', () => {
    const svg = kitChartSvg([3, 1, 4], 'combo', ['A', 'B', 'C']);
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('<polyline');
  });

  it('returns nothing with no plottable data', () => {
    expect(kitChartSvg(null, 'combo', [])).toBe('');
  });
});
