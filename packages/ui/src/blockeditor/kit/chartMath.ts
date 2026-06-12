/**
 * Pure geometry for the kit's charts — no DOM, no deps, unit-testable. The
 * chart block evaluates an expression into one of a few friendly shapes and
 * these helpers turn it into coordinates; the block just draws SVG.
 *
 * Accepted data shapes:
 *  - `number[]`                      → one series
 *  - `{name: number[], …}`           → named series (overlaid)
 *  - `[{x, y}, …]`                   → scatter points
 *  - `{label: number, …}` (pie/bar/funnel) → labelled values
 */

export interface Series {
  name: string;
  values: number[];
}

export interface LabelledValue {
  label: string;
  value: number;
}

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));

const isPointArray = (v: unknown): v is Array<{x: number; y: number}> =>
  Array.isArray(v) && v.length > 0 && v.every((p) => p && typeof p === 'object' && Number.isFinite((p as {x: number}).x) && Number.isFinite((p as {y: number}).y));

const isSeriesShape = (v: unknown): v is {series: Array<{name?: unknown; data?: unknown}>} =>
  Boolean(v) && typeof v === 'object' && Array.isArray((v as {series?: unknown}).series);

/** Coerce an evaluated value into series for line/area/bar charts. Accepts
 *  the classic reactive shape `{series: [{name, data: number[]}]}` too. */
export function toSeries(value: unknown): Series[] {
  if (isSeriesShape(value)) {
    return value.series
      .filter((s) => isNumberArray(s.data) && (s.data as number[]).length > 0)
      .map((s) => ({name: String(s.name ?? ''), values: s.data as number[]}));
  }
  if (isNumberArray(value)) return value.length ? [{name: '', values: value}] : [];
  if (Array.isArray(value) && value.every(isNumberArray)) {
    return (value as number[][]).filter((v) => v.length).map((values, i) => ({name: `s${i + 1}`, values}));
  }
  if (isPointArray(value)) return [{name: '', values: value.map((p) => p.y)}];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => isNumberArray(v));
    return entries.filter(([, v]) => (v as number[]).length).map(([name, v]) => ({name, values: v as number[]}));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [{name: '', values: [value]}];
  return [];
}

/** Coerce an evaluated value into labelled slices for pie/donut/funnel. */
export function toLabelled(value: unknown, labels: string[]): LabelledValue[] {
  let values: number[] = [];
  if (isNumberArray(value)) values = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v as number));
    if (entries.length) return entries.map(([label, v]) => ({label, value: v as number}));
  }
  return values.map((v, i) => ({label: labels[i] ?? `#${i + 1}`, value: v}));
}

/** Scatter points from the evaluated value ({x,y}[] or number[] by index). */
export function toPoints(value: unknown): Array<{x: number; y: number}> {
  if (isPointArray(value)) return value;
  if (isNumberArray(value)) return value.map((y, x) => ({x, y}));
  return [];
}

export interface Extent {
  min: number;
  max: number;
}

export function extent(values: number[]): Extent {
  if (values.length === 0) return {min: 0, max: 1};
  let min = Math.min(...values, 0); // charts read better anchored at zero
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  return {min, max};
}

/** Map a value into pixel space (SVG y grows downward — pass flipped range). */
export const scale = (v: number, d: Extent, r0: number, r1: number): number => r0 + ((v - d.min) / (d.max - d.min)) * (r1 - r0);

/** Polyline points attribute for one series across the plot area. */
export function linePoints(values: number[], d: Extent, w: number, h: number, pad: number): string {
  const n = values.length;
  return values
    .map((v, i) => {
      const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2);
      const y = scale(v, d, h - pad, pad);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

export interface Arc {
  path: string;
  /** Mid-angle anchor for a label, on a circle of radius `at`. */
  labelAt: (at: number) => {x: number; y: number};
  fraction: number;
}

/** Pie/donut arcs (cx,cy centre; r outer radius; r0 inner radius for donuts). */
export function pieArcs(values: number[], cx: number, cy: number, r: number, r0 = 0): Arc[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return [];
  let angle = -Math.PI / 2;
  return values.map((raw) => {
    const v = Math.max(0, raw);
    const sweep = (v / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number): string => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
    // Full-circle arcs collapse to nothing in SVG — split just shy of 2π.
    const end = sweep >= Math.PI * 2 - 1e-6 ? a1 - 1e-4 : a1;
    const path =
      r0 > 0
        ? `M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(end, r)} L ${p(end, r0)} A ${r0} ${r0} 0 ${large} 0 ${p(a0, r0)} Z`
        : `M ${cx},${cy} L ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(end, r)} Z`;
    const mid = (a0 + a1) / 2;
    return {path, labelAt: (at: number) => ({x: cx + Math.cos(mid) * at, y: cy + Math.sin(mid) * at}), fraction: v / total};
  });
}

export interface FunnelRow {
  x: number;
  width: number;
  y: number;
  height: number;
  fraction: number;
}

/** Centered descending funnel rows in a w×h box. */
export function funnelRows(values: number[], w: number, h: number, gap = 3): FunnelRow[] {
  const max = Math.max(...values.map((v) => Math.max(0, v)), 0);
  if (max <= 0 || values.length === 0) return [];
  const rowH = (h - gap * (values.length - 1)) / values.length;
  return values.map((raw, i) => {
    const v = Math.max(0, raw);
    const width = Math.max((v / max) * w, 2);
    return {x: (w - width) / 2, width, y: i * (rowH + gap), height: rowH, fraction: max ? v / max : 0};
  });
}

/** Nice round tick values across an extent (for the y axis grid). */
export function ticks(d: Extent, count = 3): number[] {
  const span = d.max - d.min;
  const step = 10 ** Math.floor(Math.log10(span / count));
  const candidates = [step, step * 2, step * 5, step * 10];
  const chosen = candidates.find((s) => span / s <= count + 1) ?? step * 10;
  const out: number[] = [];
  for (let v = Math.ceil(d.min / chosen) * chosen; v <= d.max + 1e-9; v += chosen) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** The kit palette — readable on both themes, in series order. */
export const PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#14b8a6'];
