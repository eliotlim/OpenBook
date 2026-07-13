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
import {computeScope, evalExpr} from './scope';
import {useKitLock, useKitPageLock} from './lock';
import {appendVar, ConfigField, ConfigInput, KitInlineText, NameDescriptionFields, ScopeHints} from './KitFrame';
import {KitSettings} from './KitSettings';
import {extent, funnelRows, linePoints, paletteFor, pieArcs, scale, ticks, toLabelled, toPoints, toSeries} from './chartMath';
import {useDataScheme} from '@/lib/dataScheme';
import {useOptionalData} from '@/data';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The kit's chart block: one block, many kinds (line, area, bar, pie, donut,
 * scatter, funnel). Data comes from an expression over the document's named
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
            {t}
          </text>
        </g>
      );
    })}
  </g>
);

/** Compact top-right legend for named multi-series data. */
const SeriesLegend: React.FC<{series: Array<{name: string}>; palette: string[]}> = ({series, palette}) => {
  const named = series.filter((s) => s.name);
  if (named.length < 2) return null;
  return (
    <g className="obe-chart-legend">
      {named.map((s, i) => (
        <g key={s.name} transform={`translate(${W - PAD - 90}, ${16 + i * 18})`}>
          <rect width={10} height={10} rx={2} fill={palette[i % palette.length]} />
          <text x={16} y={9}>
            {s.name}
          </text>
        </g>
      ))}
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
      <SeriesLegend series={series} palette={palette} />
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
        <g className="obe-chart-xlabels">
          {labels.slice(0, n).map((l, i) => (
            <text key={i} x={PAD + i * groupW + groupW / 2} y={H - 8}>
              {l}
            </text>
          ))}
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
      <g className="obe-chart-xlabels">
        {groups.map((g, i) => (
          <text key={g.key} x={PAD + i * groupW + groupW / 2} y={H - 8}>
            {g.label}
          </text>
        ))}
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
const MatrixPie: React.FC<{matrix: ChartMatrixInput; palette: string[]; size?: number}> = ({matrix, palette, size = H}) => {
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
  /**
   * Optional slash-menu entry that inserts a chart. Today only the default
   * `line` kind carries one — a single "Chart" item. The block `type` is
   * always `kitchart`; the kind is switched from config, not the slash menu.
   */
  slash?: CustomBlockDef['slash'];
}

const registry = new Map<string, ChartKindDef>();

/**
 * Register a chart kind. Re-registering an existing `kind` replaces it. The
 * render dispatch, Kind selector, and slash menu all read from the registry,
 * so this is the ONLY edit needed to add a kind.
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
  slash: {
    label: 'Chart',
    hint: 'Line, bar, pie, scatter, funnel — live over inputs',
    keywords: 'chart graph plot line bar pie donut scatter funnel visualization',
    make: () => ({type: 'kitchart', props: {kind: 'line', source: '[3, 1, 4, 1, 5, 9, 2, 6]'}}),
  },
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
  render: ({value, labels, palette, matrix, height}) =>
    matrix ? <MatrixPie matrix={matrix} palette={palette} size={height ?? H} /> : <PieDonut value={value} labels={labels} donut={false} palette={palette} />,
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
function useDbChartSeries(binding: ChartDbBinding | null): {series: ChartSeriesData | null} {
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
  const series = useMemo(() => {
    if (!client || !dbId || !groupBy) return null;
    return aggregateDbSeries(rows, properties, {dbId, groupBy, aggType, aggProp});
  }, [client, rows, properties, dbId, groupBy, aggType, aggProp]);
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

const ChartDbConfig: React.FC<{block: BlockMap; setProp: (key: string, value: unknown) => void; readOnly: boolean}> = ({block, setProp, readOnly}) => {
  const {pages} = useNavigation();
  const client = useOptionalData();
  const dbId = blockProp<string>(block, 'dbId') ?? '';
  const groupBy = blockProp<string>(block, 'dbGroupBy') ?? '';
  const aggType = blockProp<ChartAggregate['type']>(block, 'dbAggType') ?? 'count';
  const aggProp = blockProp<string>(block, 'dbAggProp') ?? '';
  const [properties, setProperties] = useState<DatabaseProperty[]>([]);
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
    </>
  );
};

// ── Shared interactive plot (extracted from ChartBlock for DASH-4) ───────────
//
// The tooltip + highlight + context-menu scaffold used to live inside
// ChartBlock. It's lifted here so the database chart-views render through the
// SAME engine: KitChartPlot owns the interaction state, the {@link Mark}
// context, the tooltip, and (in `'menu'` mode) the context menu, and calls the
// registered kind's `render`. Callers vary only the mark MODE and the optional
// drill/highlight/readout hooks — see {@link ChartMarkMode}.

/**
 * How a datum's mark presents + behaves:
 * - `'menu'` (default, in-doc charts): a `role="button"` with
 *   `aria-haspopup="menu"`; right-click / keyboard opens the shared context menu
 *   (Copy value + `menuExtra`). Byte-identical to the pre-extraction wiring.
 * - `'action'` (DB bar): a `role="button"` whose click / Enter runs `onSelect`
 *   (drill-down). No context menu — so a `getByRole('button', {name})` still
 *   resolves the bar the way the database e2e specs expect.
 * - `'decorative'` (DB pie/sunburst): an `aria-hidden` pointer target; click runs
 *   `onSelect`. The arcs are NOT exposed as buttons (the legend buttons are the
 *   accessible controls) — otherwise a legend-name `getByRole('button')` would
 *   also match the arcs and break the pie spec's single-button lookup.
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
        if (mode === 'decorative') {
          // Arcs are decorative pointer targets; the caller's legend is the a11y control.
          return {
            className,
            'aria-hidden': true,
            onPointerEnter: hover.onPointerEnter,
            onPointerLeave: hover.onPointerLeave,
            onClick: onSelect ? () => onSelect(datum) : undefined,
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
          onContextMenu: (e) => {
            e.preventDefault();
            menuReturnRef.current = e.currentTarget;
            setActive({datum, at});
            setMenu({datum, at});
          },
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
      def.render({value, labels, palette, interactions, matrix, block, editor, width: viewW, height: viewH})
    );

  return (
    <div className="obe-chart-plot">
      {/* role="group" (not "img"): the marks are interactive `role="button"`
          children now, and an img is an ARIA leaf that would hide them (and
          their `label: value` names) from assistive tech. A labelled group
          keeps the chart's accessible name while exposing every mark. */}
      <svg viewBox={`0 0 ${viewW} ${viewH}`} role="group" aria-label={ariaLabel} className="obe-chart-svg">
        <ChartInteractionContext.Provider value={interactions}>{body}</ChartInteractionContext.Provider>
      </svg>
      {active && !menu && (
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
      {mode === 'menu' && (
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
  const {series: dbSeries} = useDbChartSeries(dbBinding);

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
    const evaluated = evalExpr(source, computeScope(editor.doc).scope);
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
            <ChartDbConfig block={block} setProp={(key, v) => setProp(editor, block, key, v)} readOnly={editor.readOnly} />
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

// The chart block is a single `kitchart` type that renders any kind; the slash
// menu entry is derived from the registry (today only `line` declares one, so
// this yields exactly one "Chart" item). No edit needed to add a kind.
export const CHART_BLOCKS: CustomBlockDef[] = chartKinds()
  .filter((d) => d.slash)
  .map((d) => ({type: 'kitchart', render: ChartBlock, slash: d.slash}));
