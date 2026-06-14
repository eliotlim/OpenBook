/**
 * Normalizes a cell value into a list of named numeric series.
 *
 * Accepted shapes:
 *   - `number[]`                                          → one series, named after the cell
 *   - `{ series: Array<{ name?, data: number[] }> }`     → multiple named series from one cell
 *
 * Non-conforming inputs (string, null, malformed objects) return []. Within
 * each series, non-numeric values are filtered out — the chart only plots
 * what's actually plottable. Empty series (zero numeric values) are dropped.
 *
 * The shape is intentionally a union (not a Chart.js-style always-nested
 * object) so the common "one cell, one curve" case is just `[1, 2, 3]`
 * with the cell's display name as the series label, and richer
 * compositions opt into the `{series}` form when they need multiple
 * curves out of one expression.
 */
export type NormalizedSeries = {name: string; data: number[]};

export function normalizeChartInput(value: unknown, fallbackName: string): NormalizedSeries[] {
  if (Array.isArray(value)) {
    const data = value.filter((n): n is number => typeof n === 'number');
    if (data.length === 0) return [];
    return [{name: fallbackName, data}];
  }
  if (value && typeof value === 'object' && 'series' in value) {
    const seriesField = (value as {series: unknown}).series;
    if (!Array.isArray(seriesField)) return [];
    const out: NormalizedSeries[] = [];
    seriesField.forEach((s: unknown, i: number) => {
      if (!s || typeof s !== 'object') return;
      const obj = s as {name?: unknown; data?: unknown};
      const name = typeof obj.name === 'string' ? obj.name : `${fallbackName}.${i}`;
      const data = Array.isArray(obj.data)
        ? obj.data.filter((n): n is number => typeof n === 'number')
        : [];
      if (data.length > 0) out.push({name, data});
    });
    return out;
  }
  return [];
}
