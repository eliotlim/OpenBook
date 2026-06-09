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
import {readPageIcon} from '@/lib/pageIcon';
import type {UseDatabase} from './useDatabase';
import {chartColor} from './databaseColors';

/** A short numeric label for a bar/slice value (keeps long sums readable). */
const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, {maximumFractionDigits: 2});
};

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
        className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
          className="flex w-full cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-sm last:border-0 hover:bg-accent/40"
        >
          <span className="shrink-0 text-base leading-none">{readPageIcon(row.id)}</span>
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
  if (!view.groupByPropertyId) return <NeedsGrouping />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const max = Math.max(1, ...groups.map((g) => g.total));
  const total = groups.reduce((sum, g) => sum + g.total, 0);

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
                    return (
                      <button
                        key={seg.seriesKey}
                        onMouseEnter={() => setHover({label, value: seg.value})}
                        onMouseLeave={() => setHover(null)}
                        onClick={() => setDrill({title: label, rows: seg.rows})}
                        title={`${s.label || '—'}: ${fmt(seg.value)}`}
                        aria-label={`${label}: ${fmt(seg.value)}`}
                        className="h-full cursor-pointer transition-all first:rounded-l last:rounded-r hover:brightness-110"
                        style={{width: `${(seg.value / max) * 100}%`, backgroundColor: chartColor(s, si)}}
                      />
                    );
                  })
                  : (
                    <button
                      onMouseEnter={() => setHover({label: g.label || '—', value: g.total})}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => setDrill({title: g.label || '—', rows: g.rows})}
                      title={fmt(g.total)}
                      aria-label={`${g.label || 'No value'}: ${fmt(g.total)}`}
                      className="h-full cursor-pointer rounded transition-all hover:brightness-110"
                      style={{width: `${Math.max(2, (g.total / max) * 100)}%`, backgroundColor: chartColor(g, gi)}}
                    />
                  )}
              </div>
              <div className="w-12 shrink-0 text-right tabular-nums text-xs font-medium">{fmt(g.total)}</div>
            </div>
          ))}
        </div>
        {stacked && groups.length > 0 && (
          <SeriesLegend series={series} groups={groups} setHover={setHover} onPick={(title, rows) => setDrill({title, rows})} />
        )}
      </div>
      {drill && <DrillPanel db={db} drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};

/** Breakdown legend: a swatch per series, clickable to drill all its rows. */
const SeriesLegend: React.FC<{
  series: ChartSeries[];
  groups: ChartGroup[];
  setHover: (h: Hover) => void;
  onPick: (title: string, rows: DatabaseRow[]) => void;
}> = ({series, groups, setHover, onPick}) => (
  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
    {series.map((s, si) => {
      const rows = groups.flatMap((g) => g.segments.find((seg) => seg.seriesKey === s.key)?.rows ?? []);
      const value = groups.reduce((sum, g) => sum + (g.segments.find((seg) => seg.seriesKey === s.key)?.value ?? 0), 0);
      return (
        <button
          key={s.key}
          onMouseEnter={() => setHover({label: s.label || '—', value})}
          onMouseLeave={() => setHover(null)}
          onClick={() => onPick(s.label || '—', rows)}
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
  if (!view.groupByPropertyId) return <NeedsGrouping />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const live = groups.filter((g) => g.total > 0);
  const total = live.reduce((sum, g) => sum + g.total, 0);
  if (total === 0) return <NoData />;

  // Inner disc (or the whole pie when there's no breakdown): one arc per group.
  let acc = 0;
  const groupStops = live
    .map((g, i) => {
      const start = (acc / total) * 360;
      acc += g.total;
      return `${chartColor(g, i)} ${start}deg ${(acc / total) * 360}deg`;
    })
    .join(', ');

  // Outer ring: each group's arc subdivided into its breakdown segments.
  let acc2 = 0;
  const segStops = stacked
    ? live
      .flatMap((g) =>
        g.segments
          .filter((seg) => seg.value > 0)
          .map((seg) => {
            const si = series.findIndex((s) => s.key === seg.seriesKey);
            const start = (acc2 / total) * 360;
            acc2 += seg.value;
            return `${chartColor(series[si], si)} ${start}deg ${(acc2 / total) * 360}deg`;
          }),
      )
      .join(', ')
    : '';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-border p-5">
        <div className="relative h-44 w-44 shrink-0">
          <div
            className="h-full w-full rounded-full shadow-inner"
            style={{background: `conic-gradient(${stacked ? segStops : groupStops})`}}
            role="img"
            aria-label={stacked ? 'Sunburst chart' : 'Pie chart'}
          />
          {stacked && (
            <div
              className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-inner ring-4 ring-card"
              style={{background: `conic-gradient(${groupStops})`}}
            />
          )}
        </div>
        <div className="min-w-[12rem] flex-1 space-y-2">
          <ChartReadout view={view} properties={properties} hover={hover} total={total} />
          <div className="space-y-1.5">
            {live.map((g, i) => (
              <div key={g.key}>
                <button
                  onMouseEnter={() => setHover({label: g.label || '—', value: g.total})}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => setDrill({title: g.label || '—', rows: g.rows})}
                  className="flex w-full cursor-pointer items-center gap-2 text-sm transition-colors hover:text-foreground"
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
                        return (
                          <button
                            key={seg.seriesKey}
                            onMouseEnter={() => setHover({label, value: seg.value})}
                            onMouseLeave={() => setHover(null)}
                            onClick={() => setDrill({title: label, rows: seg.rows})}
                            title={`${s.label || '—'}: ${fmt(seg.value)}`}
                            className="flex cursor-pointer items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
            ))}
          </div>
        </div>
      </div>
      {drill && <DrillPanel db={db} drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
};
