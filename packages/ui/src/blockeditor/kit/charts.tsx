import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  CHART_TOTAL_SERIES,
  PARENT_GROUP_ID,
  type ChartAggregate,
  type ChartGroup,
  type ChartSeries,
  type DatabaseProperty,
  type DatabaseRow,
} from '@book.dev/sdk';
import {BarChart3, Copy} from 'lucide-react';
import {Select} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {blockId, blockProp, setBlockProp, type BlockMap} from '../model';
import {aggregateDbSeries, readDbBinding, DB_AGG_TYPES, NUMERIC_PROP_TYPES, type ChartDbBinding, type ChartSeriesData} from './chartData';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockDef, CustomBlockProps} from '../registry';
import {useCachedEval, useCachedInputScope} from './useCachedEval';
import {useKitLock, useKitPageLock} from './lock';
import {appendVar, ConfigField, ConfigInput, KitInlineText, NameDescriptionFields, ScopeHints} from './KitFrame';
import {KitSettings} from './KitSettings';
import {axisTickLabel, extent, funnelRows, linePoints, paletteFor, pieArcs, scale, ticks, toLabelled, toPoints, toSeries} from './chartMath';
import {useDataScheme} from '@/lib/dataScheme';
import {useOptionalData} from '@/data';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The kit's chart block: one block, many kinds (line, area, bar, pie, donut,
 * scatter, funnel, kpi, heatmap, combo). Data comes from an expression over the document's named
 * inputs, so a stepper click or radio pick redraws every chart that reads it
 * — that's the artifact loop. Rendering is plain SVG: no chart library, both
 * themes, and identical markup in the interactive HTML export.
 */

/** Serialized chart `kind`. Dynamic — the set is whatever the registry holds. */
export type ChartKind = string;

const W = 640;
const H = 240;
const PAD = 28;

const setProp = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

const splitLabels = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Compact number formatting for tooltips/menus (mirrors the DB charts). */
export const fmtChartValue = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, {maximumFractionDigits: 2});

/** SVG coord → clamped percentage of a span, so an overlay stays inside the plot. */
const pctIn = (v: number, span: number, min = 6, max = 94): number => Math.max(min, Math.min(max, (v / span) * 100));

/** Truncate a label to `max` chars with an ellipsis (drives the DB bar x-labels,
 *  which have no truncation of their own — a long/many-group label set overflows
 *  otherwise). Returns the original when it already fits. */
const ellipsize = (label: string, max: number): string =>
  label.length > max ? `${label.slice(0, Math.max(1, max - 1)).trimEnd()}…` : label;

// ── Interactivity (DASH-2): hover tooltip, highlight, context menu ───────────
//
// The seven kinds each draw their own SVG, but the interaction behaviour is
// SHARED: a kind only wraps each datum in <Mark>. The Mark reads the ambient
// {@link ChartInteractions} (provided by the live block) and, for that datum,
// wires hover/focus → tooltip+highlight and right-click/keyboard → the shared
// context menu. Outside a live chart — the static export path, a provider-less
// viewer mount, or a unit test that calls `render` with only {value, labels,
// palette} — the context is null and <Mark> is an inert passthrough, so the SVG
// is byte-identical to the pre-interactivity output.

/** SVG-space (viewBox) anchor a tooltip/menu points at. */
export interface ChartPoint {
  x: number;
  y: number;
}

/** One interactive datum: what the tooltip shows and the menu acts on. */
export interface ChartDatum {
  /** Stable identity across every mark in the chart — drives highlight. */
  key: string;
  /** Human-readable label (x-label / slice / stage, series-prefixed when multi). */
  label: string;
  /** The plotted numeric value. */
  value: number;
  /**
   * Additive DASH-4 channel — set only by matrix (database) charts:
   * The rows behind this mark, so a click can drill into them (the DB bar/pie
   * views). Absent for expression charts — nothing to drill into.
   */
  rows?: DatabaseRow[];
  /**
   * Highlight tokens this mark answers to (its group key + series key), so an
   * EXTERNAL highlight — a legend hover that names a whole group or series —
   * lights every matching mark. Absent for expression charts (a legend hover
   * there matches a single mark by `key`).
   */
  tags?: string[];
}

/**
 * Interaction wiring handed to a kind's `render` via the OPTIONAL
 * {@link ChartRenderArgs.interactions} field. A kind never touches this
 * directly — it wraps data in {@link Mark}, which pulls it from context.
 */
export interface ChartInteractions {
  /** Props spread onto a datum's `<g>` wrapper: handlers, focusability, aria, active/dim class. */
  markProps: (datum: ChartDatum, at: ChartPoint) => React.SVGProps<SVGGElement>;
}

const ChartInteractionContext = React.createContext<ChartInteractions | null>(null);

/**
 * Wrap a datum's SVG so it gains hover tooltip, highlight, keyboard focus, and
 * the shared context menu. Renders children unchanged when there's no live
 * interaction context (export/viewer/tests) — the additive, no-op default.
 */
export const Mark: React.FC<{datum: ChartDatum; at: ChartPoint; children: React.ReactNode}> = ({datum, at, children}) => {
  const ix = React.useContext(ChartInteractionContext);
  if (!ix) return <>{children}</>;
  return <g {...ix.markProps(datum, at)}>{children}</g>;
};

/** Light horizontal grid + tick labels shared by the XY kinds. */
const Grid: React.FC<{d: ReturnType<typeof extent>}> = ({d}) => (
  <g className="obe-chart-grid">
    {ticks(d).map((t) => {
      const y = scale(t, d, H - PAD, PAD);
      return (
        <g key={t}>
          <line x1={PAD} x2={W - PAD} y1={y} y2={y} />
          <text x={PAD - 6} y={y + 3}>
            {axisTickLabel(t)}
          </text>
        </g>
      );
    })}
  </g>
);

/** Compact top-right legend for named multi-series data. `glyph` picks the
 *  swatch per series (default a square) — line/area/combo pass `'line'` for
 *  their line series so the legend glyph matches the mark it stands for. */
const SeriesLegend: React.FC<{series: Array<{name: string}>; palette: string[]; glyph?: (index: number) => 'bar' | 'line'}> = ({series, palette, glyph}) => {
  const named = series.filter((s) => s.name);
  if (named.length < 2) return null;
  return (
    <g className="obe-chart-legend">
      {named.map((s, i) => {
        const color = palette[i % palette.length];
        return (
          <g key={s.name} transform={`translate(${W - PAD - 90}, ${16 + i * 18})`}>
            {glyph?.(i) === 'line' ? (
              <line className="obe-chart-legend-line" x1={0} y1={5} x2={12} y2={5} stroke={color} strokeWidth={2} strokeLinecap="round" />
            ) : (
              <rect width={10} height={10} rx={2} fill={color} />
            )}
            <text x={16} y={9}>
              {s.name}
            </text>
          </g>
        );
      })}
    </g>
  );
};

/** X-axis labels under the plot, when the block provides them. */
const XLabels: React.FC<{labels: string[]; n: number}> = ({labels, n}) => {
  if (labels.length === 0 || n === 0) return null;
  const span = W - PAD * 2;
  return (
    <g className="obe-chart-xlabels">
      {labels.slice(0, n).map((l, i) => (
        <text key={i} x={n === 1 ? W / 2 : PAD + (i / (n - 1)) * span} y={H - 8}>
          {l}
        </text>
      ))}
    </g>
  );
};

const LineArea: React.FC<{value: unknown; area: boolean; labels: string[]; palette: string[]}> = ({value, area, labels, palette}) => {
  const series = toSeries(value);
  if (series.length === 0) return null;
  const d = extent(series.flatMap((s) => s.values));
  const multi = series.length > 1;
  return (
    <>
      <Grid d={d} />
      {series.map((s, i) => {
        const pts = linePoints(s.values, d, W, H, PAD);
        const base = scale(Math.max(d.min, 0), d, H - PAD, PAD);
        const coords = pts.split(' ');
        const first = coords[0]?.split(',')[0];
        const last = coords[coords.length - 1]?.split(',')[0];
        const n = s.values.length;
        return (
          <g key={i}>
            {area && <polygon points={`${first},${base} ${pts} ${last},${base}`} fill={palette[i % palette.length]} opacity={0.15} />}
            <polyline points={pts} fill="none" stroke={palette[i % palette.length]} strokeWidth={2} strokeLinejoin="round" />
            {s.values.map((v, j) => {
              const x = n === 1 ? W / 2 : PAD + (j / (n - 1)) * (W - PAD * 2);
              const y = scale(v, d, H - PAD, PAD);
              const lbl = labels[j] ?? `#${j + 1}`;
              return (
                <Mark key={j} datum={{key: `p-${i}-${j}`, label: multi && s.name ? `${s.name} · ${lbl}` : lbl, value: v}} at={{x, y}}>
                  <circle className="obe-chart-dot" cx={x} cy={y} r={5} fill={palette[i % palette.length]} />
                </Mark>
              );
            })}
          </g>
        );
      })}
      <SeriesLegend series={series} palette={palette} glyph={() => 'line'} />
      <XLabels labels={labels} n={Math.max(...series.map((s) => s.values.length))} />
    </>
  );
};

const Bars: React.FC<{value: unknown; labels: string[]; palette: string[]}> = ({value, labels, palette}) => {
  const series = toSeries(value);
  if (series.length === 0) return null;
  const d = extent(series.flatMap((s) => s.values));
  const n = Math.max(...series.map((s) => s.values.length));
  const groupW = (W - PAD * 2) / n;
  const barW = Math.max((groupW * 0.7) / series.length, 2);
  const zero = scale(Math.max(d.min, 0), d, H - PAD, PAD);
  return (
    <>
      <Grid d={d} />
      {series.map((s, si) =>
        s.values.map((v, i) => {
          const y = scale(v, d, H - PAD, PAD);
          const x = PAD + i * groupW + groupW * 0.15 + si * barW;
          const lbl = labels[i] ?? `#${i + 1}`;
          return (
            <Mark
              key={`${si}-${i}`}
              datum={{key: `b-${si}-${i}`, label: series.length > 1 && s.name ? `${s.name} · ${lbl}` : lbl, value: v}}
              at={{x: x + (barW - 1) / 2, y: Math.min(y, zero)}}
            >
              <rect x={x} y={Math.min(y, zero)} width={barW - 1} height={Math.max(Math.abs(zero - y), 1)} rx={2} fill={palette[si % palette.length]} />
            </Mark>
          );
        }),
      )}
      {labels.length > 0 && (
        // Truncate to the per-group width with a hover title, matching the static
        // export (kitChart.ts) so an in-doc bar and its export read the same.
        <g className="obe-chart-xlabels">
          {labels.slice(0, n).map((l, i) => {
            const budget = Math.max(3, Math.floor(groupW / 6));
            const shown = ellipsize(l, budget);
            return (
              <text key={i} x={PAD + i * groupW + groupW / 2} y={H - 8}>
                {shown}
                {shown !== l && <title>{l}</title>}
              </text>
            );
          })}
        </g>
      )}
      <SeriesLegend series={series} palette={palette} />
    </>
  );
};

const PieDonut: React.FC<{value: unknown; labels: string[]; donut: boolean; palette: string[]}> = ({value, labels, donut, palette}) => {
  const slices = toLabelled(value, labels).filter((s) => s.value > 0);
  if (slices.length === 0) return null;
  const r = H / 2 - 16;
  const arcs = pieArcs(slices.map((s) => s.value), H / 2, H / 2, r, donut ? r * 0.55 : 0);
  return (
    <>
      {arcs.map((a, i) => (
        <Mark key={i} datum={{key: `slice-${i}`, label: slices[i].label, value: slices[i].value}} at={a.labelAt(donut ? r * 0.78 : r * 0.6)}>
          <path d={a.path} fill={palette[i % palette.length]} stroke="hsl(var(--background, 0 0% 100%))" strokeWidth={1.5} />
        </Mark>
      ))}
      <g className="obe-chart-legend">
        {slices.map((s, i) => (
          <g key={i} transform={`translate(${H + 24}, ${28 + i * 20})`}>
            <rect width={10} height={10} rx={2} fill={palette[i % palette.length]} />
            <text x={16} y={9}>
              {s.label} · {Math.round((arcs[i]?.fraction ?? 0) * 100)}%
            </text>
          </g>
        ))}
      </g>
    </>
  );
};

const Scatter: React.FC<{value: unknown; palette: string[]}> = ({value, palette}) => {
  const pts = toPoints(value);
  if (pts.length === 0) return null;
  const dx = extent(pts.map((p) => p.x));
  const dy = extent(pts.map((p) => p.y));
  return (
    <>
      <Grid d={dy} />
      {pts.map((p, i) => {
        const cx = scale(p.x, dx, PAD, W - PAD);
        const cy = scale(p.y, dy, H - PAD, PAD);
        return (
          <Mark key={i} datum={{key: `pt-${i}`, label: `(${fmtChartValue(p.x)}, ${fmtChartValue(p.y)})`, value: p.y}} at={{x: cx, y: cy}}>
            <circle cx={cx} cy={cy} r={4} fill={palette[0]} opacity={0.75} />
          </Mark>
        );
      })}
    </>
  );
};

const Funnel: React.FC<{value: unknown; labels: string[]; palette: string[]}> = ({value, labels, palette}) => {
  const stages = toLabelled(value, labels);
  if (stages.length === 0) return null;
  const rows = funnelRows(stages.map((s) => s.value), W - PAD * 2, H - PAD);
  return (
    <>
      {rows.map((r, i) => (
        <g key={i}>
          <Mark datum={{key: `row-${i}`, label: stages[i].label, value: stages[i].value}} at={{x: W / 2, y: 12 + r.y + r.height / 2}}>
            <rect x={PAD + r.x} y={12 + r.y} width={r.width} height={r.height} rx={4} fill={palette[i % palette.length]} opacity={0.85} />
          </Mark>
          <text className="obe-chart-funnel-label" x={W / 2} y={12 + r.y + r.height / 2 + 4}>
            {stages[i].label} · {stages[i].value}
          </text>
        </g>
      ))}
    </>
  );
};

// ── Matrix (database) data channel (DASH-4) ──────────────────────────────────
//
// The database chart-views group rows into a {@link ChartMatrix} — primary
// groups, each split across a shared series set (a breakdown). That's richer
// than the flat expression `value` (a single series-or-labelled set), so it
// rides an ADDITIVE, OPTIONAL {@link ChartRenderArgs.matrix} channel: the `bar`
// and `pie` kinds render stacked bars / a sunburst from it, while every other
// path (expression charts, static export, the other kinds) ignores it and stays
// byte-identical. Each mark carries its group/segment rows so the shared
// interaction scaffold can drill, and its group+series keys as highlight `tags`
// so a legend hover lights the whole group/series.

/** The DB aggregate lifted into the kit engine (SDK {@link ChartGroup}/{@link ChartSeries}). */
export interface ChartMatrixInput {
  groups: ChartGroup[];
  series: ChartSeries[];
  /** A real breakdown is present (segments beyond the synthetic total series). */
  stacked: boolean;
  /** 100%-stacked: every bar fills its track (each group normalised to its own total). */
  percent?: boolean;
  /**
   * Concrete-hex colour for a group/series item. Defaults to the positional
   * palette; the DB views pass their semantic swatch resolver so a "Done" bar
   * stays green rather than taking a palette slot.
   */
  colorOf?: (item: {key: string; color?: string}, index: number) => string;
}

const matrixColor = (m: ChartMatrixInput, item: {key: string; color?: string}, index: number, palette: string[]): string =>
  m.colorOf?.(item, index) ?? palette[index % palette.length];

/**
 * Vertical bars from a {@link ChartMatrixInput}: one column per group, stacked
 * into its breakdown segments (or a single total bar without a breakdown). Every
 * segment/bar is a {@link Mark} carrying its rows + group/series highlight tags,
 * so the shared scaffold gives hover, highlight, tooltip, and click-to-drill.
 */
const MatrixBars: React.FC<{matrix: ChartMatrixInput; palette: string[]}> = ({matrix, palette}) => {
  const {groups, series, stacked, percent} = matrix;
  if (groups.length === 0) return null;
  const max = Math.max(1, ...groups.map((g) => g.total));
  const n = groups.length;
  const groupW = (W - PAD * 2) / n;
  const barW = Math.max(groupW * 0.62, 2);
  const track = H - PAD * 2;
  const seriesColorOf = (seriesKey: string): string => {
    const si = series.findIndex((s) => s.key === seriesKey);
    return matrixColor(matrix, series[si] ?? {key: seriesKey}, si, palette);
  };
  return (
    <>
      <Grid d={extent([0, max])} />
      {groups.map((g, gi) => {
        const cx = PAD + gi * groupW + groupW / 2;
        const x = cx - barW / 2;
        const denom = percent ? g.total || 1 : max;
        // Stack the segments bottom-up; a no-breakdown group is one full bar.
        const segs = stacked ? g.segments.filter((s) => s.value > 0) : [{seriesKey: CHART_TOTAL_SERIES, value: g.total, rows: g.rows}];
        let acc = 0;
        return (
          <g key={g.key}>
            {segs.map((seg) => {
              const h = (seg.value / denom) * track;
              const yTop = H - PAD - (acc + h);
              acc += h;
              const s = series.find((x) => x.key === seg.seriesKey);
              const label = stacked && s?.label ? `${g.label} · ${s.label}` : g.label;
              const fill = stacked ? seriesColorOf(seg.seriesKey) : matrixColor(matrix, g, gi, palette);
              return (
                <Mark
                  key={seg.seriesKey}
                  datum={{key: stacked ? `${g.key}::${seg.seriesKey}` : g.key, label, value: seg.value, rows: seg.rows, tags: [g.key, seg.seriesKey]}}
                  at={{x: cx, y: yTop}}
                >
                  <rect x={x} y={yTop} width={barW} height={Math.max(h, 1)} rx={2} fill={fill} />
                </Mark>
              );
            })}
          </g>
        );
      })}
      {/* X-labels: the DB bar has no truncation of its own, so long/many-group
          labels collide or overflow. Truncate each to its column width (budget
          scales with `groupW`, so labels shrink as groups multiply and never
          collide) with a hover <title> carrying the full text. Kept horizontal
          and centred — angled labels clip against the fixed-height viewBox — and
          identical to the flat `Bars` + static export so all three read alike. */}
      <g className="obe-chart-xlabels">
        {groups.map((g, i) => {
          const label = g.label ?? '';
          const shown = ellipsize(label, Math.max(3, Math.floor(groupW / 6)));
          return (
            <text key={g.key} x={PAD + i * groupW + groupW / 2} y={H - 8}>
              {shown}
              {shown !== label && <title>{label}</title>}
            </text>
          );
        })}
      </g>
    </>
  );
};

/**
 * Pie (no breakdown) or two-ring sunburst (with a breakdown) from a
 * {@link ChartMatrixInput}: inner disc = groups, outer ring = their segments.
 * Every arc is a {@link Mark} carrying its rows + highlight tags. The DB views
 * render the accessible legend + readout around this, so these arcs are
 * decorative pointer targets (mark mode `'decorative'`).
 */
const MatrixPie: React.FC<{matrix: ChartMatrixInput; palette: string[]; size?: number; active?: ChartDatum | null}> = ({
  matrix,
  palette,
  size = H,
  active = null,
}) => {
  const {groups, series, stacked} = matrix;
  const live = groups.filter((g) => g.total > 0);
  const total = live.reduce((s, g) => s + g.total, 0);
  if (total === 0) return null;
  const CX = size / 2;
  const CY = size / 2;
  const R = size / 2 - 12;
  const RINNER = stacked ? R * 0.58 : 0;
  const seriesColorOf = (seriesKey: string): string => {
    const si = series.findIndex((s) => s.key === seriesKey);
    return matrixColor(matrix, series[si] ?? {key: seriesKey}, si, palette);
  };
  const stroke = 'hsl(var(--card))';
  // Inner disc (or the whole pie without a breakdown): one arc per group.
  const groupArcs = pieArcs(live.map((g) => g.total), CX, CY, stacked ? RINNER : R, 0);
  // Outer ring (sunburst): each group's arc subdivided into its segments.
  const segEntries = stacked ? live.flatMap((g) => g.segments.filter((seg) => seg.value > 0).map((seg) => ({g, seg}))) : [];
  const segArcs = pieArcs(segEntries.map((e) => e.seg.value), CX, CY, R, RINNER);
  return (
    <>
      {/* Ring first, inner disc last so the disc cleanly covers the sunburst centre. */}
      {segArcs.map((a, i) => {
        const {g, seg} = segEntries[i];
        const s = series.find((x) => x.key === seg.seriesKey);
        return (
          <Mark
            key={`${g.key}::${seg.seriesKey}`}
            datum={{key: `${g.key}::${seg.seriesKey}`, label: `${g.label} · ${s?.label ?? '—'}`, value: seg.value, rows: seg.rows, tags: [g.key, seg.seriesKey]}}
            at={a.labelAt((R + RINNER) / 2)}
          >
            <path d={a.path} fill={seriesColorOf(seg.seriesKey)} stroke={stroke} strokeWidth={0.75} />
          </Mark>
        );
      })}
      {groupArcs.map((a, i) => {
        const g = live[i];
        const fill = matrixColor(matrix, g, i, palette);
        return (
          <Mark key={g.key} datum={{key: g.key, label: g.label, value: g.total, rows: g.rows, tags: [g.key]}} at={a.labelAt(stacked ? RINNER * 0.5 : R * 0.6)}>
            {a.fraction >= 0.9999 ? (
              <circle cx={CX} cy={CY} r={stacked ? RINNER : R} fill={fill} stroke={stroke} strokeWidth={0.75} />
            ) : (
              <path d={a.path} fill={fill} stroke={stroke} strokeWidth={0.75} />
            )}
          </Mark>
        );
      })}
      {/* Sunburst centre readout (DASH-4 restore): the grand total at rest, the
          hovered/focused slice while a pointer is over one. A card-tinted disc
          keeps it legible over the group ring without changing the arc geometry
          the DB pie spec counts. Absent for a flat pie (no ring, RINNER = 0). */}
      {stacked && (
        <g className="obe-chart-center" aria-hidden pointerEvents="none">
          <circle cx={CX} cy={CY} r={RINNER * 0.72} fill="hsl(var(--card))" opacity={0.94} />
          <text className="obe-chart-center-value" x={CX} y={active ? CY - 1 : CY + 3} textAnchor="middle">
            {fmtChartValue(active ? active.value : total)}
          </text>
          {active && (
            <text className="obe-chart-center-label" x={CX} y={CY + 16} textAnchor="middle">
              {ellipsize(active.label, 16)}
            </text>
          )}
        </g>
      )}
    </>
  );
};

// ── New built-in kinds (DASH-5): KPI tile, heatmap, combo ────────────────────
//
// Each is a plain registry entry consuming the SAME render contract as the seven
// originals: flat `value` (a reactive expression OR a DB-source single series)
// with the OPTIONAL {@link ChartRenderArgs.matrix} fast-path, wrapping every
// datum in {@link Mark} for the shared hover/highlight/menu scaffold. No
// switch/selector/slash edit — registration alone lights them in the Kind
// selector + Change-kind menu, and their static-export drawing lives in the
// export runtime string (see `export/kitChart.ts`).

const finiteNum = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/** A KPI's single figure + optional goal, coerced from the flat chart value. */
export interface KpiDatum {
  value: number;
  target?: number;
}

/**
 * Reduce the chart value to one KPI figure (+ optional target). A scalar shows
 * as-is; a number array sums (a DB-source series → its grand total); an object
 * may name its figure (`value`/`current`/`total`) and a goal (`target`/`goal`),
 * else its numeric entries sum. Returns null when there's nothing numeric — the
 * chart shows its placeholder. Kept in sync with `kitKpi` in the export runtime.
 */
export function toKpi(value: unknown): KpiDatum | null {
  const n = finiteNum(value);
  if (n !== undefined) return {value: n};
  if (Array.isArray(value) && value.every((v) => finiteNum(v) !== undefined)) {
    return value.length ? {value: (value as number[]).reduce((a, b) => a + b, 0)} : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const target = finiteNum(o.target) ?? finiteNum(o.goal);
    const main = finiteNum(o.value) ?? finiteNum(o.current) ?? finiteNum(o.total);
    if (main !== undefined) return {value: main, target};
    const entries = Object.entries(o).filter(([k, v]) => finiteNum(v) !== undefined && k !== 'target' && k !== 'goal');
    if (entries.length) return {value: entries.reduce((a, [, v]) => a + (v as number), 0), target};
  }
  const s = toSeries(value);
  if (s.length && s[0].values.length) return {value: s[0].values.reduce((a, b) => a + b, 0)};
  return null;
}

/** Percent of target, clamped 0–100, or null without a positive target. */
const targetPct = (value: number, target?: number): number | null =>
  target && target > 0 ? Math.max(0, Math.min(100, Math.round((value / target) * 100))) : null;

/**
 * KPI / number tile: one large figure with an optional caption (the first
 * label), a target readout and a progress bar — the {@link MetricCard} look
 * rendered as SVG so it rides the same in-editor + export chart pipeline. The
 * figure is a {@link Mark}, so it gains the shared hover tooltip + keyboard focus.
 */
const Kpi: React.FC<{value: unknown; labels: string[]; palette: string[]}> = ({value, labels, palette}) => {
  const kpi = toKpi(value);
  if (!kpi) return null;
  // The caption names the single figure — meaningful only when there's exactly
  // one label (an expression KPI's `labels: 'Revenue'`). A DB-source KPI folds a
  // GROUPED series to one grand total, so its many group labels don't caption the
  // total; there the chart's own title carries the name (leave the SVG caption off).
  const caption = labels.length === 1 ? labels[0] : '';
  const pct = targetPct(kpi.value, kpi.target);
  const barW = W * 0.5;
  const barX = (W - barW) / 2;
  const barY = 190;
  return (
    <>
      {caption && (
        <text className="obe-chart-kpi-caption" x={W / 2} y={58}>
          {caption}
        </text>
      )}
      <Mark datum={{key: 'kpi', label: caption || 'Value', value: kpi.value}} at={{x: W / 2, y: pct !== null ? 108 : 128}}>
        <text className="obe-chart-kpi-value" x={W / 2} y={pct !== null ? 128 : 148}>
          {fmtChartValue(kpi.value)}
        </text>
      </Mark>
      {pct !== null && (
        <>
          <text className="obe-chart-kpi-sub" x={W / 2} y={170}>
            {`${pct}% of ${fmtChartValue(kpi.target!)}`}
          </text>
          <rect className="obe-chart-kpi-track" x={barX} y={barY} width={barW} height={8} rx={4} />
          <rect x={barX} y={barY} width={(barW * pct) / 100} height={8} rx={4} fill={palette[0]} />
        </>
      )}
    </>
  );
};

/** A rows×cols grid the heatmap + combo share, from a matrix (groups×series) or
 *  the flat multi-series value. Cells may be `undefined` (ragged series). */
interface ChartGrid {
  /** Row names (series names / breakdown labels); '' when unnamed. */
  rows: string[];
  /** Column labels (per-point labels / group labels). */
  cols: string[];
  cells: Array<Array<number | undefined>>;
}

function toGrid(value: unknown, labels: string[], matrix?: ChartMatrixInput): ChartGrid {
  if (matrix && matrix.groups.length) {
    const cols = matrix.groups.map((g) => g.label);
    const breakdown = matrix.stacked && matrix.series.length > 0;
    const rows = breakdown ? matrix.series.map((s) => s.label || s.key) : [''];
    const cells = (breakdown ? matrix.series : [{key: CHART_TOTAL_SERIES}]).map((s) =>
      matrix.groups.map((g) => (breakdown ? g.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0 : g.total)),
    );
    return {rows, cols, cells};
  }
  const series = toSeries(value);
  const nCols = series.reduce((m, s) => Math.max(m, s.values.length), 0);
  const cols = Array.from({length: nCols}, (_, c) => labels[c] ?? `#${c + 1}`);
  const rows = series.map((s) => s.name);
  const cells = series.map((s) => cols.map((_, c) => s.values[c]));
  return {rows, cols, cells};
}

/** Kept in sync with `kitGrid` in the export runtime. */
const gridValues = (g: ChartGrid): number[] => g.cells.flat().filter((v): v is number => typeof v === 'number');

/** Above this fill intensity the cell is a near-opaque pale fill, so the in-cell
 *  label switches to a fixed dark ink instead of the theme foreground (which
 *  would wash out on it in dark mode). Mirrored in the export runtime. */
const HEAT_LABEL_INK_THRESHOLD = 0.6;

/**
 * Heatmap: a groups×series grid where a cell's colour intensity encodes its
 * value (a single-hue ramp over the first palette colour, so it stays on-theme
 * and recolours with the scheme). Reads the flat multi-series value (each named
 * series a row) or the matrix channel; every cell is a {@link Mark} for
 * hover/tooltip, with a legible in-cell number when it fits.
 */
const Heatmap: React.FC<{value: unknown; labels: string[]; palette: string[]; matrix?: ChartMatrixInput}> = ({value, labels, palette, matrix}) => {
  const {rows, cols, cells} = toGrid(value, labels, matrix);
  const flat = gridValues({rows, cols, cells});
  if (rows.length === 0 || cols.length === 0 || flat.length === 0) return null;
  const min = Math.min(...flat);
  const max = Math.max(...flat);
  const showRowLabels = rows.some((r) => r !== '');
  const gutter = showRowLabels ? 64 : PAD;
  const gridX = gutter;
  const gridY = 14;
  const gridW = W - gutter - PAD;
  const gridH = H - gridY - 22; // 22px for column labels
  const cw = gridW / cols.length;
  const ch = gridH / rows.length;
  const base = palette[0];
  const intensity = (v: number): number => (max === min ? 0.55 : 0.14 + 0.82 * ((v - min) / (max - min)));
  return (
    <>
      {rows.map((rowName, r) =>
        cols.map((colLabel, c) => {
          const v = cells[r]?.[c];
          const x = gridX + c * cw;
          const y = gridY + r * ch;
          if (typeof v !== 'number') {
            return <rect key={`${r}-${c}`} className="obe-chart-heat-empty" x={x + 1} y={y + 1} width={cw - 2} height={ch - 2} rx={3} />;
          }
          return (
            <Mark key={`${r}-${c}`} datum={{key: `h-${r}-${c}`, label: `${rowName ? `${rowName} · ` : ''}${colLabel}`, value: v}} at={{x: x + cw / 2, y: y + ch / 2}}>
              <rect x={x + 1} y={y + 1} width={cw - 2} height={ch - 2} rx={3} fill={base} fillOpacity={intensity(v)} />
              {cw > 34 && ch > 18 && (
                // Pick the ink by cell INTENSITY, not the theme foreground: a
                // high-intensity cell is a near-opaque pale fill in BOTH themes,
                // so the flipping `--foreground` washes out on it in dark mode —
                // a fixed dark ink above the threshold keeps the number legible
                // regardless of theme (DASH-6 fine-tunes the threshold).
                <text className={cn('obe-chart-heat-label', intensity(v) > HEAT_LABEL_INK_THRESHOLD && 'obe-chart-heat-label-strong')} x={x + cw / 2} y={y + ch / 2 + 4}>
                  {fmtChartValue(v)}
                </text>
              )}
            </Mark>
          );
        }),
      )}
      {showRowLabels &&
        rows.map((rowName, r) =>
          rowName ? (
            <text key={`rl-${r}`} className="obe-chart-heat-rowlabel" x={gutter - 8} y={gridY + r * ch + ch / 2 + 3}>
              {rowName}
            </text>
          ) : null,
        )}
      <g className="obe-chart-xlabels">
        {cols.map((colLabel, c) => (
          <text key={`cl-${c}`} x={gridX + c * cw + cw / 2} y={H - 7}>
            {colLabel}
          </text>
        ))}
      </g>
    </>
  );
};

const comboLabel = (name: string, col: string): string => (name ? `${name} · ${col}` : col);

/**
 * Combo: the first series drawn as bars, the remaining series overlaid as lines
 * on one shared scale — the classic "measure vs. trend/target" pairing. Reads the
 * flat multi-series value (or the matrix channel); bars + line points are each a
 * {@link Mark}. A single series degrades to a plain bar chart.
 */
const Combo: React.FC<{value: unknown; labels: string[]; palette: string[]; matrix?: ChartMatrixInput}> = ({value, labels, palette, matrix}) => {
  const {rows, cols, cells} = toGrid(value, labels, matrix);
  const flat = gridValues({rows, cols, cells});
  if (rows.length === 0 || cols.length === 0 || flat.length === 0) return null;
  const d = extent(flat);
  const n = cols.length;
  const groupW = (W - PAD * 2) / n;
  const zero = scale(Math.max(d.min, 0), d, H - PAD, PAD);
  const barW = Math.max(groupW * 0.5, 2);
  const px = (c: number): number => PAD + c * groupW + groupW / 2;
  return (
    <>
      <Grid d={d} />
      {cells[0].map((v, c) => {
        if (typeof v !== 'number') return null;
        const y = scale(v, d, H - PAD, PAD);
        const x = PAD + c * groupW + (groupW - barW) / 2;
        return (
          <Mark key={`bar-${c}`} datum={{key: `cb-0-${c}`, label: comboLabel(rows[0], cols[c]), value: v}} at={{x: x + barW / 2, y: Math.min(y, zero)}}>
            <rect x={x} y={Math.min(y, zero)} width={barW} height={Math.max(Math.abs(zero - y), 1)} rx={2} fill={palette[0]} />
          </Mark>
        );
      })}
      {rows.slice(1).map((rowName, li) => {
        const r = li + 1;
        const color = palette[r % palette.length];
        const pts = cells[r]
          .map((v, c) => (typeof v === 'number' ? `${px(c)},${scale(v, d, H - PAD, PAD)}` : null))
          .filter(Boolean)
          .join(' ');
        return (
          <g key={`line-${r}`}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
            {cells[r].map((v, c) =>
              typeof v === 'number' ? (
                <Mark key={`ln-${r}-${c}`} datum={{key: `cb-${r}-${c}`, label: comboLabel(rowName, cols[c]), value: v}} at={{x: px(c), y: scale(v, d, H - PAD, PAD)}}>
                  <circle className="obe-chart-dot" cx={px(c)} cy={scale(v, d, H - PAD, PAD)} r={5} fill={color} />
                </Mark>
              ) : null,
            )}
          </g>
        );
      })}
      <g className="obe-chart-xlabels">
        {cols.map((l, c) => (
          <text key={c} x={px(c)} y={H - 8}>
            {l}
          </text>
        ))}
      </g>
      <SeriesLegend series={rows.map((name) => ({name}))} palette={palette} glyph={(i) => (i === 0 ? 'bar' : 'line')} />
    </>
  );
};

/**
 * Chart-kind registry. Rendering, the config Kind selector, and the slash menu
 * all DERIVE from this map, so a new kind (DASH-2/3/5) is one
 * {@link registerChartKind} call — no `switch` or array to edit.
 */

export interface ChartRenderArgs {
  /** Evaluated result of the chart's `source` expression. */
  value: unknown;
  /** Parsed comma-separated labels, one per point/slice/stage. */
  labels: string[];
  /** Concrete-hex series palette for the active data-colour scheme. */
  palette: string[];
  // ── Additive DASH-2 interaction channel ────────────────────────────────────
  // All OPTIONAL. Absent for static export, provider-less viewer mounts, and
  // unit tests that call `render({value, labels, palette})` — kinds that ignore
  // them (or wrap data in <Mark>, which no-ops without a live context) render
  // byte-identically to the pre-interactivity output.
  /**
   * Live hover/highlight/menu wiring. The seven built-ins never read this
   * directly — they wrap each datum in {@link Mark}, which pulls the same object
   * from context — but it's exposed here so a custom kind that draws outside
   * `<Mark>` can still wire its own handlers.
   */
  interactions?: ChartInteractions;
  /**
   * Grouped + optionally broken-down data (DASH-4). When present the `bar`/`pie`
   * kinds render stacked bars / a sunburst from it instead of the flat `value`
   * path; each mark carries its rows for drill. Absent for expression charts.
   */
  matrix?: ChartMatrixInput;
  /**
   * The datum currently hovered/focused (DASH-4). Lets a kind reflect the active
   * selection in its own chrome — the DB sunburst's centre readout shows this
   * slice's value while a pointer is over one, the grand total otherwise.
   */
  active?: ChartDatum | null;
  /** The chart block, for kind-level actions (a custom kind mutating props). */
  block?: BlockMap;
  /** The editor controller, for kind-level actions (transactional prop writes). */
  editor?: BlockEditorController;
  /** SVG viewBox dimensions, so a kind can place its own overlays. */
  width?: number;
  height?: number;
}

export interface ChartKindConfigArgs {
  block: BlockMap;
  editor: BlockEditorController;
  /** Transactionally writes a prop on this chart block. */
  setProp: (key: string, value: unknown) => void;
}

export interface ChartKindDef {
  /** Serialized `kind` string — part of the block model; keep it stable. */
  kind: string;
  /** Label shown in the ⚙ config Kind selector (also the option text). */
  label: string;
  /** Renders the SVG body for this kind. */
  render: (args: ChartRenderArgs) => React.ReactNode;
  /**
   * Whether the data has anything to plot; drives the "no plottable data"
   * placeholder. Defaults to the series-or-labelled check the value kinds
   * share. Point-based kinds (scatter) override it so a stray value still
   * renders an empty plot rather than the placeholder.
   */
  hasData?: (value: unknown, labels: string[]) => boolean;
  /**
   * Optional per-kind config fields rendered under the shared Kind/Data/Labels
   * controls. Unused by the built-ins today — an extension point for future
   * kinds (DASH-3 DB source, DASH-5 new kinds).
   */
  configFields?: (args: ChartKindConfigArgs) => React.ReactNode;
}

const registry = new Map<string, ChartKindDef>();

/**
 * Register a chart kind. Re-registering an existing `kind` replaces it. The
 * render dispatch and Kind selector both read from the registry, so this is
 * the ONLY edit needed to add a kind.
 */
export function registerChartKind(def: ChartKindDef): void {
  registry.set(def.kind, def);
}

/** Look up a registered kind. */
export const getChartKind = (kind: string): ChartKindDef | undefined => registry.get(kind);

/** All registered kinds, in registration order. */
export const chartKinds = (): ChartKindDef[] => [...registry.values()];

/** The default series-or-labelled emptiness check most kinds use. */
const hasPlottable = (value: unknown, labels: string[]): boolean =>
  toSeries(value).length > 0 || toLabelled(value, labels).length > 0;

// The seven built-in kinds. Each is a plain registry entry — the former
// switch(kind) render dispatch and the CHART_KINDS array both derive from here.
registerChartKind({
  kind: 'line',
  label: 'line',
  render: ({value, labels, palette}) => <LineArea value={value} area={false} labels={labels} palette={palette} />,
});
registerChartKind({
  kind: 'area',
  label: 'area',
  render: ({value, labels, palette}) => <LineArea value={value} area labels={labels} palette={palette} />,
});
registerChartKind({
  kind: 'bar',
  label: 'bar',
  render: ({value, labels, palette, matrix}) =>
    matrix ? <MatrixBars matrix={matrix} palette={palette} /> : <Bars value={value} labels={labels} palette={palette} />,
});
registerChartKind({
  kind: 'pie',
  label: 'pie',
  render: ({value, labels, palette, matrix, height, active}) =>
    matrix ? <MatrixPie matrix={matrix} palette={palette} size={height ?? H} active={active} /> : <PieDonut value={value} labels={labels} donut={false} palette={palette} />,
});
registerChartKind({
  kind: 'donut',
  label: 'donut',
  render: ({value, labels, palette}) => <PieDonut value={value} labels={labels} donut palette={palette} />,
});
registerChartKind({
  kind: 'scatter',
  label: 'scatter',
  hasData: () => true,
  render: ({value, palette}) => <Scatter value={value} palette={palette} />,
});
registerChartKind({
  kind: 'funnel',
  label: 'funnel',
  render: ({value, labels, palette}) => <Funnel value={value} labels={labels} palette={palette} />,
});
// DASH-5 kinds — register-only; they appear in the Kind selector + Change-kind
// menu (both derive from the registry) with no dispatch edit.
registerChartKind({
  kind: 'kpi',
  label: 'KPI',
  hasData: (value) => toKpi(value) !== null,
  render: ({value, labels, palette}) => <Kpi value={value} labels={labels} palette={palette} />,
});
registerChartKind({
  kind: 'heatmap',
  label: 'heatmap',
  render: ({value, labels, palette, matrix}) => <Heatmap value={value} labels={labels} palette={palette} matrix={matrix} />,
});
registerChartKind({
  kind: 'combo',
  label: 'combo',
  render: ({value, labels, palette, matrix}) => <Combo value={value} labels={labels} palette={palette} matrix={matrix} />,
});

/** Kind strings of the currently-registered kinds (re-exported by the kit). */
export const CHART_KINDS: readonly string[] = chartKinds().map((d) => d.kind);

// ── Data source: reactive expression (default) OR a database binding ─────────
//
// A chart's `source` is EITHER an expression over the page's inputs (the
// original, unchanged path — `sourceMode` absent or `'expr'`) OR a database
// binding (`sourceMode === 'database'`): group a database's rows by a property
// and fold a measure, reusing the SDK aggregate pipeline the DB chart-views use.
// The render contract stays source-agnostic — both paths produce `{value,
// labels}`; the kind's `render` never learns where the data came from. The pure
// data logic lives in `./chartData` so the (sync) export path can share it.

// Re-exported so existing importers (and tests) keep resolving these from the
// chart module even though the pure logic now lives in `./chartData`.
export {readDbBinding, aggregateDbSeries};
export type {ChartDbBinding};

/**
 * Resolve a database binding's rows to a `{value, labels}` series, live, for
 * on-screen display. Seeds from {@link DataClient.listRows} and re-aggregates on
 * {@link DataClient.subscribeRows} row edits (the same reactivity the DB
 * chart-views ride). Returns `null` outside a `<DataProvider>` (a provider-less
 * mount) — the chart shows its placeholder there; static exports resolve their
 * own series at export time (see `resolveDbChartSeries`), never from the doc.
 */
function useDbChartSeries(binding: ChartDbBinding | null, filterValue?: unknown): {series: ChartSeriesData | null} {
  const client = useOptionalData();
  const dbId = binding?.dbId ?? '';
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [properties, setProperties] = useState<DatabaseProperty[]>([]);
  useEffect(() => {
    if (!client || !dbId) {
      setRows([]);
      setProperties([]);
      return;
    }
    let cancelled = false;
    void client.getDatabase(dbId).then((db) => {
      if (!cancelled) setProperties(db?.schema.properties ?? []);
    });
    void client.listRows(dbId).then((initial) => {
      if (!cancelled) setRows(initial);
    });
    const unsubscribe = client.subscribeRows(dbId, (next) => setRows(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, dbId]);
  const groupBy = binding?.groupBy ?? '';
  const aggType = binding?.aggType ?? 'count';
  const aggProp = binding?.aggProp;
  const filterInput = binding?.filterInput;
  const filterProp = binding?.filterProp;
  // A JSON key of the resolved filter value so the memo re-aggregates when the
  // bound control changes (arrays and scalars alike), not on every render.
  const filterKey = JSON.stringify(filterValue ?? null);
  const series = useMemo(() => {
    if (!client || !dbId || !groupBy) return null;
    // `filterKey` (a stable JSON key of `filterValue`) stands in for the value in
    // the dep list, so the memo re-aggregates when the bound control changes.
    return aggregateDbSeries(rows, properties, {dbId, groupBy, aggType, aggProp, filterInput, filterProp}, filterValue);
  }, [client, rows, properties, dbId, groupBy, aggType, aggProp, filterInput, filterProp, filterKey]);
  return {series};
}

/**
 * The database-source config: a database picker, a group-by property, and a
 * measure (count / sum / avg / min / max of a numeric property). Rendered inside
 * the ⚙ popover — which only mounts within the app's providers — so its
 * {@link useNavigation}/{@link useOptionalData} reads never run in the
 * provider-less viewer.
 */
const selectClass = 'w-full rounded-md border border-border bg-card px-2 py-1 text-sm';

const ChartDbConfig: React.FC<{block: BlockMap; editor: BlockEditorController; setProp: (key: string, value: unknown) => void; readOnly: boolean}> = ({block, editor, setProp, readOnly}) => {
  const {pages} = useNavigation();
  const client = useOptionalData();
  const dbId = blockProp<string>(block, 'dbId') ?? '';
  const groupBy = blockProp<string>(block, 'dbGroupBy') ?? '';
  const aggType = blockProp<ChartAggregate['type']>(block, 'dbAggType') ?? 'count';
  const aggProp = blockProp<string>(block, 'dbAggProp') ?? '';
  const filterInput = blockProp<string>(block, 'dbFilterInput') ?? '';
  const filterProp = blockProp<string>(block, 'dbFilterProp') ?? '';
  const [properties, setProperties] = useState<DatabaseProperty[]>([]);
  const reactiveScope = useCachedInputScope(editor).value ?? {};
  useEffect(() => {
    if (!client || !dbId) {
      setProperties([]);
      return;
    }
    let cancelled = false;
    void client.getDatabase(dbId).then((db) => {
      if (!cancelled) setProperties(db?.schema.properties ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [client, dbId]);
  const databases = pages.filter((p) => p.hostedDatabaseId);
  const numericProps = properties.filter((p) => NUMERIC_PROP_TYPES.has(p.type));
  const noNumericMeasure = aggType !== 'count' && numericProps.length === 0;

  // With exactly one database to bind, pick it — one less click when the author
  // just switched to Database mode (mirrors the DB views auto-picking a group-by).
  const loneDbId = databases.length === 1 ? databases[0].hostedDatabaseId : undefined;
  useEffect(() => {
    if (!readOnly && !dbId && loneDbId) setProp('dbId', loneDbId);
  }, [readOnly, dbId, loneDbId, setProp]);

  // Once a database is chosen, auto-pick a sensible group-by so the chart draws
  // immediately (measure defaults to `count`, which needs no numeric property):
  // the first select/status column is the natural "one bar/slice per value" axis,
  // else the first non-numeric column, else anything. This makes the slash → Chart
  // → Database flow land on a real chart without a manual group-by step.
  const preferredGroupBy = useMemo(() => {
    if (properties.length === 0) return '';
    const categorical = properties.find((p) => p.type === 'select' || p.type === 'status');
    if (categorical) return categorical.id;
    const nonNumeric = properties.find((p) => !NUMERIC_PROP_TYPES.has(p.type));
    return (nonNumeric ?? properties[0]).id;
  }, [properties]);
  useEffect(() => {
    if (!readOnly && dbId && !groupBy && preferredGroupBy) setProp('dbGroupBy', preferredGroupBy);
  }, [readOnly, dbId, groupBy, preferredGroupBy, setProp]);

  // Cross-filter (DASH-7): the page's named inputs that can drive a filter — a
  // single-value selection (dropdown/radio/text/number/toggle) or a multi-select
  // (checklist/tag field, an array). Grouped bags and the location object aren't
  // scalar match sources, so they're excluded. A dashboard author picks one here
  // + a property; every chart bound to the same input re-scopes together.
  const filterInputNames = useMemo(() => {
    return Object.keys(reactiveScope)
      .filter((k) => {
        const v = reactiveScope[k];
        return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v);
      })
      .sort();
  }, [reactiveScope]);
  // When an input is chosen but no property is set yet, suggest one whose name
  // matches the input's (region → "Region"), else the first select/status column
  // — the natural categorical axis a cross-filter slices.
  const preferredFilterProp = useMemo(() => {
    if (!filterInput || properties.length === 0) return '';
    const byName = properties.find((p) => p.name.trim().toLowerCase() === filterInput.trim().toLowerCase());
    if (byName) return byName.id;
    const categorical = properties.find((p) => p.type === 'select' || p.type === 'status');
    return categorical?.id ?? '';
  }, [filterInput, properties]);
  useEffect(() => {
    if (!readOnly && filterInput && !filterProp && preferredFilterProp) setProp('dbFilterProp', preferredFilterProp);
  }, [readOnly, filterInput, filterProp, preferredFilterProp, setProp]);

  return (
    <>
      <ConfigField label="Database" hint="Aggregate a database's rows.">
        <Select unstyled className={selectClass} value={dbId} disabled={readOnly} onChange={(e) => setProp('dbId', e.target.value)}>
          <option value="">Choose a database…</option>
          {databases.map((p) => (
            <option key={p.hostedDatabaseId!} value={p.hostedDatabaseId!}>
              {p.name?.trim() || 'Untitled'}
            </option>
          ))}
        </Select>
      </ConfigField>
      {dbId && (
        <ConfigField label="Group by" hint="One bar/slice per value.">
          <Select unstyled className={selectClass} value={groupBy} disabled={readOnly} onChange={(e) => setProp('dbGroupBy', e.target.value)}>
            <option value="">Choose a property…</option>
            <option value={PARENT_GROUP_ID}>Sub-items (parent)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </ConfigField>
      )}
      {dbId && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-foreground/80">Measure</span>
              <Select unstyled className={selectClass} value={aggType} disabled={readOnly} onChange={(e) => setProp('dbAggType', e.target.value)}>
                {DB_AGG_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </label>
            {aggType !== 'count' && (
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-foreground/80">Of</span>
                <Select unstyled className={selectClass} value={aggProp} disabled={readOnly} onChange={(e) => setProp('dbAggProp', e.target.value || undefined)}>
                  <option value="">—</option>
                  {numericProps.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {noNumericMeasure && (
            <span className="text-[0.7rem] text-muted-foreground">No numeric property to measure — add a number column to this database.</span>
          )}
        </div>
      )}
      {dbId && (
        // Cross-filter binding. Optional: with no input picked the chart shows the
        // whole database (unchanged). Bind an input + a property and the chart
        // re-scopes to that input's value — pick the SAME input on several charts
        // to build a dashboard-wide filter.
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-foreground/80">Filter by input</span>
              <Select unstyled className={selectClass} value={filterInput} disabled={readOnly} aria-label="Cross-filter input" onChange={(e) => {
                const next = e.target.value;
                setProp('dbFilterInput', next || undefined);
                // Clearing the input clears the paired property, so a half-set
                // binding never lingers and silently filters nothing.
                if (!next) setProp('dbFilterProp', undefined);
              }}>
                <option value="">No filter</option>
                {filterInputNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
            {filterInput && (
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-foreground/80">On property</span>
                <Select unstyled className={selectClass} value={filterProp} disabled={readOnly} aria-label="Cross-filter property" onChange={(e) => setProp('dbFilterProp', e.target.value || undefined)}>
                  <option value="">Choose a property…</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {filterInput && filterInputNames.length === 0 ? (
            <span className="text-[0.7rem] text-muted-foreground">No named inputs on this page yet — add a dropdown or radio input to filter by.</span>
          ) : (
            <span className="text-[0.7rem] text-muted-foreground">Scope this chart to a control’s value — reuse the same input across charts for a dashboard-wide filter.</span>
          )}
        </div>
      )}
    </>
  );
};

// ── Shared interactive plot (extracted from ChartBlock for DASH-4) ───────────
//
// The tooltip + highlight + context-menu scaffold used to live inside
// ChartBlock. It's lifted here so the database chart-views render through the
// SAME engine: KitChartPlot owns the interaction state, the {@link Mark}
// context, the tooltip, and the context menu, and calls the
// registered kind's `render`. Callers vary only the mark MODE and the optional
// drill/highlight/readout hooks — see {@link ChartMarkMode}.

/**
 * How a datum's mark presents + behaves:
 * - `'menu'` (default, in-doc charts): a `role="button"` with
 *   `aria-haspopup="menu"`; right-click / keyboard opens the shared context menu
 *   (Copy value + `menuExtra`). The shared `openMenu` stops propagation in every
 *   mode so an ancestor's context menu does not open too.
 * - `'action'` (DB bar): a `role="button"` whose click / Enter runs `onSelect`
 *   (drill-down). Right-click still opens Copy value without changing the
 *   mark's button semantics.
 * - `'decorative'` (DB pie/sunburst): an `aria-hidden` pointer target; click runs
 *   `onSelect`. The arcs are NOT exposed as buttons (the legend buttons are the
 *   accessible controls) — otherwise a legend-name `getByRole('button')` would
 *   also match the arcs and break the pie spec's single-button lookup. A
 *   pointer right-click still opens Copy value.
 */
export type ChartMarkMode = 'menu' | 'action' | 'decorative';

export interface KitChartPlotProps {
  /** Registered kind to render (`getChartKind`); unknown kinds fall back to `line`. */
  kind: string;
  /** Flat expression data (the original path). Ignored when `matrix` is set. */
  value?: unknown;
  /** Grouped/broken-down data (DB charts) — the `bar`/`pie` kinds read this. */
  matrix?: ChartMatrixInput;
  /** Per-point labels for the flat path. */
  labels?: string[];
  /** Concrete-hex palette for the active data-colour scheme. */
  palette: string[];
  /** The svg's accessible name (`role="group"`). DB pie passes `Sunburst chart`/`Pie chart`. */
  ariaLabel: string;
  /** viewBox width/height. Default 640×240 (the wide plot); the DB pie passes a square box. */
  viewW?: number;
  viewH?: number;
  /** Drop the SVG's own border/radius/card background. The DB chart-views wrap
   *  the plot in their own readout card, so the default frame would nest a second
   *  concentric border inside it — a bare plot avoids the double frame (DASH-4). */
  frameless?: boolean;
  /** When set, the plot shows this placeholder (error / empty) instead of the chart. */
  message?: React.ReactNode;
  block?: BlockMap;
  editor?: BlockEditorController;
  /** Mark presentation + behaviour. Defaults to `'menu'` (in-doc charts). */
  mode?: ChartMarkMode;
  /** Extra context-menu items after Copy value (`'menu'` mode) — e.g. Change kind. */
  menuExtra?: (datum: ChartDatum) => React.ReactNode;
  /** Click/Enter a mark (`'action'`/`'decorative'` modes) — DB drill-down. */
  onSelect?: (datum: ChartDatum) => void;
  /** External highlight (a legend hover): lights marks whose key/tags match; dims the rest. */
  highlightKey?: string | null;
  /** Reports the hovered/focused datum (drives the DB readout strip). */
  onActiveChange?: (datum: ChartDatum | null) => void;
}

export const KitChartPlot: React.FC<KitChartPlotProps> = ({
  kind,
  value,
  matrix,
  labels = [],
  palette,
  ariaLabel,
  viewW = W,
  viewH = H,
  frameless = false,
  message,
  block,
  editor,
  mode = 'menu',
  menuExtra,
  onSelect,
  highlightKey = null,
  onActiveChange,
}) => {
  // `active` drives the tooltip + highlight from hover OR keyboard focus; `menu`
  // is the open context-menu target (null = closed). Both key off the datum so
  // identity survives re-render. When the menu closes we return focus to its mark.
  const [active, setActive] = useState<{datum: ChartDatum; at: ChartPoint} | null>(null);
  const [menu, setMenu] = useState<{datum: ChartDatum; at: ChartPoint} | null>(null);
  const menuReturnRef = useRef<SVGGElement | null>(null);
  // Surface the hovered/focused datum to the caller (the DB readout) without
  // coupling the active-state logic below — which stays byte-identical to in-doc.
  // Fire on `active` only — the callback identity is unstable, and re-subscribing
  // on it would loop; the caller reads the latest active via this notification.
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  useEffect(() => {
    onActiveChangeRef.current?.(active?.datum ?? null);
  }, [active]);

  const interactions = useMemo<ChartInteractions>(
    () => ({
      markProps: (datum, at) => {
        const clearIfMine = (cur: {datum: ChartDatum; at: ChartPoint} | null) => (cur?.datum.key === datum.key ? null : cur);
        const externalLit = highlightKey != null && (datum.key === highlightKey || !!datum.tags?.includes(highlightKey));
        const isActive = active?.datum.key === datum.key || externalLit;
        const anyHighlight = active != null || highlightKey != null;
        const className = cn('obe-chart-mark', anyHighlight && (isActive ? 'is-active' : 'is-dim'));
        const hover = {
          onPointerEnter: () => setActive({datum, at}),
          onPointerLeave: () => setActive(clearIfMine),
          onFocus: () => setActive({datum, at}),
          onBlur: () => setActive(clearIfMine),
        };
        const openMenu: React.MouseEventHandler<SVGGElement> = (e) => {
          e.preventDefault();
          // Database charts sit inside DatabaseContextMenu. The datum's copy
          // menu must win rather than also opening the active-view menu.
          e.stopPropagation();
          menuReturnRef.current = e.currentTarget;
          setActive({datum, at});
          setMenu({datum, at});
        };
        if (mode === 'decorative') {
          // Arcs are decorative pointer targets; the caller's legend is the a11y control.
          return {
            className,
            'aria-hidden': true,
            onPointerEnter: hover.onPointerEnter,
            onPointerLeave: hover.onPointerLeave,
            onClick: onSelect ? () => onSelect(datum) : undefined,
            onContextMenu: openMenu,
          };
        }
        if (mode === 'action') {
          return {
            className,
            tabIndex: 0,
            role: 'button',
            'aria-label': `${datum.label}: ${fmtChartValue(datum.value)}`,
            ...hover,
            onClick: onSelect ? () => onSelect(datum) : undefined,
            onContextMenu: openMenu,
            onKeyDown: (e) => {
              if ((e.key === 'Enter' || e.key === ' ') && onSelect) {
                e.preventDefault();
                onSelect(datum);
              }
            },
          };
        }
        // 'menu' — in-doc charts: role=button + context menu (right-click/keyboard).
        return {
          tabIndex: 0,
          role: 'button',
          'aria-haspopup': 'menu',
          'aria-label': `${datum.label}: ${fmtChartValue(datum.value)}`,
          className,
          ...hover,
          onContextMenu: openMenu,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu') {
              e.preventDefault();
              menuReturnRef.current = e.currentTarget;
              setMenu({datum, at});
            } else if (e.key === 'Escape') {
              setActive(null);
            }
          },
        };
      },
    }),
    [active, highlightKey, mode, onSelect],
  );

  const def = getChartKind(kind) ?? getChartKind('line')!;
  const body =
    message != null ? (
      <text className="obe-chart-msg" x={viewW / 2} y={viewH / 2}>
        {message}
      </text>
    ) : (
      def.render({value, labels, palette, interactions, matrix, active: active?.datum ?? null, block, editor, width: viewW, height: viewH})
    );

  return (
    <div className="obe-chart-plot">
      {/* role="group" (not "img"): the marks are interactive `role="button"`
          children now, and an img is an ARIA leaf that would hide them (and
          their `label: value` names) from assistive tech. A labelled group
          keeps the chart's accessible name while exposing every mark. */}
      <svg viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={ariaLabel} className={cn('obe-chart-svg', frameless && 'obe-chart-svg-bare')}>
        <ChartInteractionContext.Provider value={interactions}>{body}</ChartInteractionContext.Provider>
      </svg>
      {/* The floating tooltip is the in-doc idiom. In DB-view mode ('action'/
          'decorative') the persistent ChartReadout strip already names the
          hovered datum, so suppress the tooltip there — no double readout. */}
      {active && !menu && mode === 'menu' && (
        // aria-hidden: the focused/hovered mark already carries the label+value
        // in its aria-label, so the visual tooltip must not double-announce.
        // Flips below the mark near the top edge so it never escapes the plot.
        <div
          className={cn('obe-chart-tooltip', active.at.y < viewH * 0.16 && 'obe-chart-tooltip-below')}
          aria-hidden
          style={{left: `${pctIn(active.at.x, viewW)}%`, top: `${(active.at.y / viewH) * 100}%`}}
        >
          <span className="obe-chart-tt-label">{active.datum.label}</span>
          <span className="obe-chart-tt-value">{fmtChartValue(active.datum.value)}</span>
        </div>
      )}
      {(mode === 'menu' || menu) && (
        <DropdownMenu open={!!menu} onOpenChange={(o) => !o && setMenu(null)}>
          {/* A zero-size anchor at the datum: the context menu (right-click or
              keyboard) positions against it, so mouse and keyboard open the same
              menu in the same place. */}
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              tabIndex={-1}
              className="obe-chart-menu-anchor"
              style={menu ? {left: `${pctIn(menu.at.x, viewW)}%`, top: `${(menu.at.y / viewH) * 100}%`} : undefined}
            />
          </DropdownMenuTrigger>
          {menu && (
            <DropdownMenuContent
              align="start"
              className="min-w-44"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                menuReturnRef.current?.focus?.();
              }}
            >
              <DropdownMenuLabel className="max-w-64 truncate">
                {menu.datum.label}: {fmtChartValue(menu.datum.value)}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void navigator.clipboard?.writeText(`${menu.datum.label}: ${fmtChartValue(menu.datum.value)}`)}>
                <Copy className="mr-2 h-4 w-4" /> Copy value
              </DropdownMenuItem>
              {menuExtra?.(menu.datum)}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      )}
    </div>
  );
};

const ChartBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const kind = (blockProp<string>(block, 'kind') as ChartKind) ?? 'line';
  const source = blockProp<string>(block, 'source') ?? '';
  const labels = splitLabels(blockProp<string>(block, 'labels') ?? '');
  const title = blockProp<string>(block, 'title') ?? '';
  const description = blockProp<string>(block, 'description') ?? '';
  // Whether the inline title/description are edit affordances here. Under a
  // page lock (read-only viewer, the export viewer) KitInlineText renders its
  // locked branch — a plain span of `value || placeholder` — so an EMPTY field
  // must not render at all or the placeholder shows as ghost text ("Chart
  // title" / "Add a description…") on a locked page. Empty + editable keeps
  // rendering: present mode hides it via the :placeholder-shown CSS instead.
  const pageLocked = useKitPageLock();
  const groupLocked = useKitLock();
  const chromeEditable = !editor.readOnly && !pageLocked;
  // Change-kind writes the block, so it's offered only when the chart is truly
  // editable — never in the read-only viewer, a locked group, or an export. Copy
  // value stays available everywhere (present mode included), matching the
  // existing config Kind selector's gate plus the group/page locks.
  const canChangeKind = !editor.readOnly && !pageLocked && !groupLocked;
  const dbBinding = readDbBinding(block);
  const reactiveScope = useCachedInputScope(editor).value ?? {};
  // Cross-filter (DASH-7): a DB chart bound to a named input reads that input's
  // LIVE value from the page scope and scopes its rows to it. ChartBlock already
  // re-renders on any doc change (the reactive backbone), so picking a new value
  // in the bound control recomputes this and re-aggregates the series below.
  const filterValue = dbBinding?.filterInput ? reactiveScope[dbBinding.filterInput] : undefined;
  const {series: dbSeries} = useDbChartSeries(dbBinding, filterValue);
  const evaluated = useCachedEval(editor, blockId(block), source, 'expression', !dbBinding);

  // Resolve the plotted data from whichever source is active. Expression mode is
  // the original path (evaluated over the page's inputs). Database mode reads the
  // live aggregated series from the data client for on-screen display ONLY — it
  // never persists derived data to the doc (viewing/presenting a DB chart must
  // cause zero writes). The static export resolves its own series at export time.
  let value: unknown;
  let error: string | undefined;
  let effectiveLabels = labels;
  if (dbBinding) {
    value = dbSeries?.value;
    effectiveLabels = dbSeries?.labels ?? [];
  } else {
    value = evaluated.value;
    error = evaluated.error;
  }

  // Concrete-hex series fills for the active data-colour scheme (OB-379): the SVG
  // `fill=` attribute can't read a CSS var, so resolve the palette here — it
  // recolours live when the scheme switches.
  const palette = paletteFor(useDataScheme());

  // Unknown kinds fall back to `line`, matching the former switch `default`.
  const def = getChartKind(kind) ?? getChartKind('line')!;
  const hasData = def.hasData ?? hasPlottable;
  const message: React.ReactNode = error ? (
    <>⚠ {error}</>
  ) : value === undefined || !hasData(value, effectiveLabels) ? (
    dbBinding
      ? dbBinding.dbId && dbBinding.groupBy
        ? 'no rows to chart'
        : 'configure a database ⚙ — pick a database and a group-by'
      : source.trim()
        ? 'no plottable data'
        : 'configure data ⚙ — e.g. [3, 1, 4, 1, 5] or {a: [1,2], b: [3,4]}'
  ) : null;

  return (
    <figure className="obe-kit obe-kit-chart" contentEditable={false} data-chart-kind={kind}>
      <figcaption className="obe-kit-chart-head">
        {(chromeEditable || title) && (
          <KitInlineText
            className="obe-kit-chart-title"
            value={title}
            placeholder="Chart title"
            readOnly={editor.readOnly}
            ariaLabel="Chart title"
            onCommit={(v) => setProp(editor, block, 'title', v)}
          />
        )}
        {(chromeEditable || description) && (
          <KitInlineText
            className="obe-kit-desc obe-kit-desc-edit"
            value={description}
            placeholder="Add a description…"
            readOnly={editor.readOnly}
            ariaLabel="Description"
            onCommit={(v) => setProp(editor, block, 'description', v)}
          />
        )}
      </figcaption>
      <KitChartPlot
        kind={kind}
        value={value}
        labels={effectiveLabels}
        palette={palette}
        ariaLabel={title || `${kind} chart`}
        message={message}
        block={block}
        editor={editor}
        menuExtra={
          canChangeKind
            ? () => (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <BarChart3 className="mr-2 h-4 w-4" /> Change chart kind
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={kind} onValueChange={(k) => setProp(editor, block, 'kind', k)}>
                    {chartKinds().map((k) => (
                      <DropdownMenuRadioItem key={k.kind} value={k.kind}>
                        {k.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
            : undefined
        }
      />
      <KitSettings blockId={blockId(block)} title={title || `${kind} chart`}>
        <div className="flex flex-col gap-3">
          <NameDescriptionFields block={block} editor={editor} nameKey="title" namePlaceholder="Chart title" />
          <ConfigField label="Kind">
            <Select unstyled
              className={selectClass}
              value={kind}
              disabled={editor.readOnly}
              aria-label="Chart kind"
              onChange={(e) => setProp(editor, block, 'kind', e.target.value)}
            >
              {chartKinds().map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </Select>
          </ConfigField>
          <ConfigField label="Source">
            <div className="flex gap-1 rounded-md border border-border bg-card p-0.5" role="group" aria-label="Chart data source">
              {([['expr', 'Reactive inputs'], ['database', 'Database']] as const).map(([mode, lbl]) => {
                const active = (mode === 'database') === !!dbBinding;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={editor.readOnly}
                    aria-pressed={active}
                    onClick={() => setProp(editor, block, 'sourceMode', mode)}
                    className={cn(
                      'flex-1 cursor-pointer rounded px-2 py-1 text-xs transition-colors',
                      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>
          </ConfigField>
          {dbBinding ? (
            <ChartDbConfig block={block} editor={editor} setProp={(key, v) => setProp(editor, block, key, v)} readOnly={editor.readOnly} />
          ) : (
            <>
              <ConfigField label="Data" hint="An expression over the page's inputs.">
                <ConfigInput
                  mono
                  value={source}
                  readOnly={editor.readOnly}
                  spellCheck={false}
                  aria-label="Chart data expression"
                  placeholder="[x, x*2, x*3]  ·  {a: [1,2,3], b: [2,4,6]}"
                  onChange={(e) => setProp(editor, block, 'source', e.target.value)}
                />
                <ScopeHints editor={editor} onPick={(name) => setProp(editor, block, 'source', appendVar(source, name))} />
              </ConfigField>
              <ConfigField label="Labels" hint="Comma-separated, one per point.">
                <ConfigInput value={blockProp<string>(block, 'labels') ?? ''} readOnly={editor.readOnly} aria-label="Labels (comma-separated)" placeholder="A, B, C" onChange={(e) => setProp(editor, block, 'labels', e.target.value)} />
              </ConfigField>
            </>
          )}
          {def.configFields?.({block, editor, setProp: (key, v) => setProp(editor, block, key, v)})}
        </div>
      </KitSettings>
    </figure>
  );
};

// The chart block is a single `kitchart` type that renders any registered
// kind. Insertion lives in SlashMenu's core "Chart" item (first in the
// interactive group, IA-8) — one insertion source — so this only registers
// the renderer. No edit needed here to add a kind.
export const CHART_BLOCKS: CustomBlockDef[] = [{type: 'kitchart', render: ChartBlock}];
