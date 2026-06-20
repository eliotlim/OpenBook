import React, {useState} from 'react';
import {X} from 'lucide-react';
import {
  aggregateMatrix,
  CHART_TOTAL_SERIES,
  type ChartGroup,
  type ChartSeries,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
} from '@open-book/sdk';
import {cn} from '@/lib/utils';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import type {UseDatabase} from './useDatabase';
import {chartColor} from './databaseColors';

/** A short numeric label for a bar/slice value (keeps long sums readable). */
const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, {maximumFractionDigits: 2});
};

const TAU = Math.PI * 2;
const polar = (cx: number, cy: number, r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/** SVG path for an annular sector (a pie slice when `rInner` is 0). Angles in radians. */
function arcPath(cx: number, cy: number, rInner: number, rOuter: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [xo0, yo0] = polar(cx, cy, rOuter, a0);
  const [xo1, yo1] = polar(cx, cy, rOuter, a1);
  if (rInner <= 0) {
    return `M ${cx} ${cy} L ${xo0} ${yo0} A ${rOuter} ${rOuter} 0 ${large} 1 ${xo1} ${yo1} Z`;
  }
  const [xi1, yi1] = polar(cx, cy, rInner, a1);
  const [xi0, yi0] = polar(cx, cy, rInner, a0);
  return `M ${xo0} ${yo0} A ${rOuter} ${rOuter} 0 ${large} 1 ${xo1} ${yo1} L ${xi1} ${yi1} A ${rInner} ${rInner} 0 ${large} 0 ${xi0} ${yi0} Z`;
}

/** One drawable slice of the pie/sunburst, carrying its drill-down rows. */
interface Slice {
  key: string;
  a0: number;
  a1: number;
  frac: number;
  rInner: number;
  rOuter: number;
  color: string;
  label: string;
  value: number;
  rows: DatabaseRow[];
}

/** Human label for the view's measure, e.g. `Count` or `Sum of Cost`. */
const measureLabel = (view: DbView, properties: DatabaseProperty[]): string => {
  const agg = view.aggregate ?? {type: 'count'};
  if (agg.type === 'count' || !agg.propertyId) return 'Count';
  const verb = {sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max'}[agg.type] ?? 'Count';
  const prop = properties.find((p) => p.id === agg.propertyId);
  return prop ? `${verb} of ${prop.name}` : verb;
};

const NeedsGrouping: React.FC = () => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
    Pick a property to group by in the view options to chart this data.
  </div>
);

const NoData: React.FC = () => (
  <div className="rounded-md border border-border px-4 py-10 text-center text-sm text-muted-foreground">No data to chart.</div>
);

/** What the user clicked into: a label and the rows behind a bar/slice/segment. */
type Drill = {title: string; rows: DatabaseRow[]} | null;
/** What the pointer is over: shown in the chart readout strip. */
type Hover = {label: string; value: number} | null;

/**
 * A live readout above the chart: the measure (and grand total) by default, or
 * the value + share of whatever bar/slice the pointer is over.
 */
const ChartReadout: React.FC<{view: DbView; properties: DatabaseProperty[]; hover: Hover; total: number}> = ({
  view,
  properties,
  hover,
  total,
}) => (
  <div className="flex items-baseline justify-between gap-2 text-xs">
    <span className="truncate font-medium text-foreground">{hover ? hover.label : measureLabel(view, properties)}</span>
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {hover ? `${fmt(hover.value)}${total > 0 ? ` · ${Math.round((hover.value / total) * 100)}%` : ''}` : `Total ${fmt(total)}`}
    </span>
  </div>
);

/** Rows behind the clicked bar/slice, listed and clickable to open. */
const DrillPanel: React.FC<{db: UseDatabase; drill: NonNullable<Drill>; onClose: () => void}> = ({db, drill, onClose}) => (
  <div className="mt-3 overflow-hidden rounded-md border border-border">
    <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
      <span className="min-w-0 truncate text-xs font-medium">
        {drill.title}
        <span className="ml-1.5 text-muted-foreground">
          {drill.rows.length} {drill.rows.length === 1 ? 'row' : 'rows'}
        </span>
      </span>
      <button
        onClick={onClose}
        aria-label="Close drill-down"
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
    <div className="max-h-56 overflow-y-auto">
      {drill.rows.length === 0 && <div className="px-3 py-3 text-center text-xs text-muted-foreground">No rows.</div>}
      {drill.rows.map((row) => (
        <button
          key={row.id}
          onClick={() => db.openRow(row.id)}
          className="flex w-full cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-sm last:border-0 hover:bg-hover"
        >
          <PageIcon value={readPageIcon(row.id)} className="shrink-0 text-base leading-none" />
          <span className="truncate">{row.name?.trim() || 'Untitled'}</span>
        </button>
      ))}
    </div>
  </div>
);

/**
 * A horizontal bar chart: one bar per group of the view's `groupByPropertyId`,
 * sized by its aggregate (count by default, else sum/avg/min/max of a numeric
 * property). A `breakdownPropertyId` splits each bar into stacked segments. Bars
 * are interactive — hover for a readout, click to drill into the underlying rows.
 * Dependency-free — just flexbox bars — so it renders identically in the web app
 * and the desktop WKWebView.
 */
export const BarChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const [drill, setDrill] = useState<Drill>(null);
  const [hover, setHover] = useState<Hover>(null);
  // The hovered bar/segment, and (from the legend) the hovered series — together
  // they decide which bars stay lit while the rest dim.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [hoverSeries, setHoverSeries] = useState<string | null>(null);
  if (!view.groupByPropertyId) return <NeedsGrouping />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const percent = stacked && !!view.chartStacked100; // 100%-stacked: bars fill the track
  const max = Math.max(1, ...groups.map((g) => g.total));
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const anyHover = hoverKey !== null || hoverSeries !== null;
  const dimOpacity = (lit: boolean): number => (anyHover && !lit ? 0.35 : 1);
  const clear = (): void => {
    setHoverKey(null);
    setHoverSeries(null);
    setHover(null);
  };

  return (
    <div>
      <div className="rounded-md border border-border p-4">
        <ChartReadout view={view} properties={properties} hover={hover} total={total} />
        <div className="mt-3 space-y-2">
          {groups.length === 0 && <NoData />}
          {groups.map((g, gi) => (
            <div key={g.key} className="flex items-center gap-2 text-sm">
              <div className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground" title={g.label}>
                {g.label || '—'}
              </div>
              <div className="relative flex h-6 flex-1 overflow-hidden rounded bg-muted/40">
                {stacked
                  ? g.segments.map((seg) => {
                    if (seg.value <= 0) return null;
                    const si = series.findIndex((s) => s.key === seg.seriesKey);
                    const s = series[si];
                    const label = `${g.label || '—'} · ${s.label || '—'}`;
                    const key = `${g.key}:${seg.seriesKey}`;
                    const lit = hoverKey === key || hoverSeries === seg.seriesKey;
                    return (
                      <button
                        key={seg.seriesKey}
                        onMouseEnter={() => {
                          setHoverKey(key);
                          setHover({label, value: seg.value});
                        }}
                        onMouseLeave={clear}
                        onClick={() => setDrill({title: label, rows: seg.rows})}
                        title={`${s.label || '—'}: ${fmt(seg.value)}`}
                        aria-label={`${label}: ${fmt(seg.value)}`}
                        className="h-full cursor-pointer transition-all first:rounded-l last:rounded-r"
                        style={{width: `${(seg.value / (percent ? g.total || 1 : max)) * 100}%`, backgroundColor: chartColor(s, si), opacity: dimOpacity(lit)}}
                      />
                    );
                  })
                  : (
                    <button
                      onMouseEnter={() => {
                        setHoverKey(g.key);
                        setHover({label: g.label || '—', value: g.total});
                      }}
                      onMouseLeave={clear}
                      onClick={() => setDrill({title: g.label || '—', rows: g.rows})}
                      title={fmt(g.total)}
                      aria-label={`${g.label || 'No value'}: ${fmt(g.total)}`}
                      className="h-full cursor-pointer rounded transition-all"
                      style={{width: `${Math.max(2, (g.total / max) * 100)}%`, backgroundColor: chartColor(g, gi), opacity: dimOpacity(hoverKey === g.key)}}
                    />
                  )}
              </div>
              <div className="w-12 shrink-0 text-right tabular-nums text-xs font-medium">{fmt(g.total)}</div>
            </div>
          ))}
        </div>
        {stacked && groups.length > 0 && (
          <SeriesLegend
            series={series}
            groups={groups}
            hoverSeries={hoverSeries}
            onHover={(key, h) => {
              setHoverSeries(key);
              setHover(h);
            }}
            onLeave={clear}
            onPick={(title, rows) => setDrill({title, rows})}
          />
        )}
      </div>
      {drill && <DrillPanel db={db} drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};

/** Breakdown legend: a swatch per series. Hovering lights that series across all
 *  bars (dimming the rest); clicking drills into all its rows. */
const SeriesLegend: React.FC<{
  series: ChartSeries[];
  groups: ChartGroup[];
  hoverSeries: string | null;
  onHover: (key: string, h: Hover) => void;
  onLeave: () => void;
  onPick: (title: string, rows: DatabaseRow[]) => void;
}> = ({series, groups, hoverSeries, onHover, onLeave, onPick}) => (
  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
    {series.map((s, si) => {
      const rows = groups.flatMap((g) => g.segments.find((seg) => seg.seriesKey === s.key)?.rows ?? []);
      const value = groups.reduce((sum, g) => sum + (g.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0), 0);
      return (
        <button
          key={s.key}
          onMouseEnter={() => onHover(s.key, {label: s.label || '—', value})}
          onMouseLeave={onLeave}
          onClick={() => onPick(s.label || '—', rows)}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 text-xs transition-colors hover:text-foreground',
            hoverSeries === s.key ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{backgroundColor: chartColor(s, si)}} />
          <span className="max-w-[10rem] truncate">{s.label || '—'}</span>
        </button>
      );
    })}
  </div>
);

/**
 * A pie chart drawn with a CSS `conic-gradient` plus an interactive legend. Each
 * slice is a group of the view's `groupByPropertyId`. With a `breakdownPropertyId`
 * it becomes a two-ring sunburst: the inner disc is the primary groups, the outer
 * ring their breakdown segments, and the legend nests each group's segments. Every
 * legend row hovers for a readout and clicks to drill into its rows.
 */
export const PieChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const [drill, setDrill] = useState<Drill>(null);
  const [hover, setHover] = useState<Hover>(null);
  // The slice/legend the pointer is over — drives the slice highlight + readout,
  // and is shared so hovering the legend lights up the matching slice and back.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  if (!view.groupByPropertyId) return <NeedsGrouping />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const live = groups.filter((g) => g.total > 0);
  const total = live.reduce((sum, g) => sum + g.total, 0);
  if (total === 0) return <NoData />;

  const CX = 50;
  const CY = 50;
  const R = 47;
  const RINNER = stacked ? 28 : 0; // donut hole / inner-disc radius for the sunburst

  // Inner disc (or the whole pie when there's no breakdown): one arc per group.
  let ga = -Math.PI / 2;
  const groupSlices: Slice[] = live.map((g, i) => {
    const frac = g.total / total;
    const a0 = ga;
    ga += frac * TAU;
    return {key: `g:${g.key}`, a0, a1: ga, frac, rInner: 0, rOuter: stacked ? RINNER : R, color: chartColor(g, i), label: g.label || '—', value: g.total, rows: g.rows};
  });

  // Outer ring (sunburst): each group's arc subdivided into its breakdown segments.
  let sa = -Math.PI / 2;
  const segSlices: Slice[] = stacked
    ? live.flatMap((g) =>
      g.segments
        .filter((seg) => seg.value > 0)
        .map((seg) => {
          const si = series.findIndex((s) => s.key === seg.seriesKey);
          const s = series[si];
          const frac = seg.value / total;
          const a0 = sa;
          sa += frac * TAU;
          return {key: `s:${g.key}:${seg.seriesKey}`, a0, a1: sa, frac, rInner: RINNER, rOuter: R, color: chartColor(s, si), label: `${g.label || '—'} · ${s.label || '—'}`, value: seg.value, rows: seg.rows};
        }),
    )
    : [];

  // Ring first, inner disc last so the disc cleanly covers the sunburst's centre.
  const slices = [...segSlices, ...groupSlices];
  const enter = (sl: Slice): void => {
    setHoverKey(sl.key);
    setHover({label: sl.label, value: sl.value});
  };
  const leave = (): void => {
    setHoverKey(null);
    setHover(null);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-border p-5">
        <svg viewBox="0 0 100 100" className="h-44 w-44 shrink-0" role="img" aria-label={stacked ? 'Sunburst chart' : 'Pie chart'}>
          {slices.map((sl) => {
            const active = hoverKey === sl.key;
            const dim = hoverKey !== null && !active;
            const common = {
              fill: sl.color,
              style: {
                stroke: active ? 'hsl(var(--foreground))' : 'hsl(var(--card))',
                strokeWidth: active ? 1.2 : 0.6,
                opacity: dim ? 0.3 : 1,
                transition: 'opacity .12s ease, stroke .12s ease',
              },
              className: 'cursor-pointer',
              onMouseEnter: () => enter(sl),
              onMouseLeave: leave,
              onClick: () => setDrill({title: sl.label, rows: sl.rows}),
            };
            return sl.frac >= 0.9999 ? (
              <circle key={sl.key} cx={CX} cy={CY} r={sl.rOuter} {...common} />
            ) : (
              <path key={sl.key} d={arcPath(CX, CY, sl.rInner, sl.rOuter, sl.a0, sl.a1)} {...common} />
            );
          })}
          {stacked && (
            <g style={{pointerEvents: 'none'}}>
              <text x={CX} y={CY - 1} textAnchor="middle" style={{fill: 'hsl(var(--foreground))', fontSize: 11, fontWeight: 700}}>
                {fmt(hover ? hover.value : total)}
              </text>
              <text x={CX} y={CY + 7} textAnchor="middle" style={{fill: 'hsl(var(--muted-foreground))', fontSize: 4.5, letterSpacing: 0.3}}>
                {hover ? 'SELECTED' : 'TOTAL'}
              </text>
            </g>
          )}
        </svg>
        <div className="min-w-[12rem] flex-1 space-y-2">
          <ChartReadout view={view} properties={properties} hover={hover} total={total} />
          <div className="space-y-1.5">
            {live.map((g, i) => {
              const gk = `g:${g.key}`;
              return (
                <div key={g.key}>
                  <button
                    onMouseEnter={() => enter({...groupSlices[i], label: g.label || '—', value: g.total} as Slice)}
                    onMouseLeave={leave}
                    onClick={() => setDrill({title: g.label || '—', rows: g.rows})}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm transition-colors hover:text-foreground',
                      hoverKey === gk && 'bg-accent/50',
                    )}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{backgroundColor: chartColor(g, i)}} />
                    <span className="min-w-0 flex-1 truncate text-left" title={g.label}>
                      {g.label || '—'}
                    </span>
                    <span className="tabular-nums text-xs text-muted-foreground">{fmt(g.total)}</span>
                    <span className="w-10 text-right tabular-nums text-xs font-medium">{Math.round((g.total / total) * 100)}%</span>
                  </button>
                  {stacked && (
                    <div className="ml-5 mt-0.5 flex flex-wrap gap-1">
                      {g.segments
                        .filter((seg) => seg.value > 0)
                        .map((seg) => {
                          const si = series.findIndex((s) => s.key === seg.seriesKey);
                          const s = series[si];
                          const label = `${g.label || '—'} · ${s.label || '—'}`;
                          const sk = `s:${g.key}:${seg.seriesKey}`;
                          return (
                            <button
                              key={seg.seriesKey}
                              onMouseEnter={() => {
                                setHoverKey(sk);
                                setHover({label, value: seg.value});
                              }}
                              onMouseLeave={leave}
                              onClick={() => setDrill({title: label, rows: seg.rows})}
                              title={`${s.label || '—'}: ${fmt(seg.value)}`}
                              className={cn(
                                'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                                hoverKey === sk ? 'bg-accent text-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-hover hover:text-foreground',
                              )}
                            >
                              <span className="h-2 w-2 shrink-0 rounded-sm" style={{backgroundColor: chartColor(s, si)}} />
                              <span className="max-w-[7rem] truncate">{s.label || '—'}</span>
                              <span className="tabular-nums">{fmt(seg.value)}</span>
                            </button>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {drill && <DrillPanel db={db} drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};
