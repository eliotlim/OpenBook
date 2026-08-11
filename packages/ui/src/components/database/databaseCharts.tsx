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
} from '@book.dev/sdk';
import {cn} from '@/lib/utils';
import {readPageIcon} from '@/lib/pageIcon';
import {PageIcon} from '@/components/PageIcon';
import {KitChartPlot, type ChartDatum, type ChartMatrixInput} from '@/blockeditor/kit/charts';
import {paletteFor} from '@/blockeditor/kit/chartMath';
import type {UseDatabase} from './useDatabase';
import {chartColor} from './databaseColors';
import {useDataScheme} from '@/lib/dataScheme';
import {ViewSetupCard} from './ViewSetupCard';

/**
 * The database bar/pie views render through the KIT chart engine (DASH-4): they
 * fold rows into the SDK {@link aggregateMatrix} and hand it to {@link KitChartPlot}
 * as a {@link ChartMatrixInput}, so a DB bar/pie is the SAME drawn-SVG chart, with
 * the same hover tooltip + highlight, as an in-doc kit chart. The DB-specific
 * chrome — the measure readout, the group/breakdown legend, and the click-to-drill
 * panel — lives here, around the plot; the plot's marks carry each bar/slice's rows
 * so a click drills into them.
 */

/** A short numeric label for a bar/slice value (keeps long sums readable). */
const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, {maximumFractionDigits: 2});
};

/** Square viewBox for the DB pie/sunburst — the kit's default box is wide (640×240). */
const PIE_SIZE = 240;

/** Human label for the view's measure, e.g. `Count` or `Sum of Cost`. */
const measureLabel = (view: DbView, properties: DatabaseProperty[]): string => {
  const agg = view.aggregate ?? {type: 'count'};
  if (agg.type === 'count' || !agg.propertyId) return 'Count';
  const verb = {sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max'}[agg.type] ?? 'Count';
  const prop = properties.find((p) => p.id === agg.propertyId);
  return prop ? `${verb} of ${prop.name}` : verb;
};

const NoData: React.FC = () => (
  <div className="rounded-md border border-border px-4 py-10 text-center text-sm text-muted-foreground">No data to chart.</div>
);

/** What the user clicked into: a label and the rows behind a bar/slice/segment. */
type Drill = {title: string; rows: DatabaseRow[]} | null;
/** What the pointer is over: shown in the chart readout strip. */
type Hover = {label: string; value: number} | null;

/** Build the kit matrix input from an aggregate, resolving each item's semantic swatch. */
const toMatrix = (
  groups: ChartGroup[],
  series: ChartSeries[],
  stacked: boolean,
  scheme: ReturnType<typeof useDataScheme>,
  percent = false,
): ChartMatrixInput => ({
  groups,
  series,
  stacked,
  percent,
  colorOf: (item, i) => chartColor(item, i, scheme),
});

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
    <span className="min-w-[16ch] shrink-0 text-right tabular-nums text-muted-foreground">
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
 * A bar chart: one column per group of the view's `groupByPropertyId`, sized by
 * its aggregate (count by default, else sum/avg/min/max of a numeric property). A
 * `breakdownPropertyId` stacks each column into segments. The drawn SVG + its
 * hover tooltip/highlight come from the kit engine ({@link KitChartPlot}); a bar's
 * mark carries its rows so a click drills into them, and the readout + breakdown
 * legend wrap the plot.
 */
export const BarChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const scheme = useDataScheme();
  const [drill, setDrill] = useState<Drill>(null);
  const [readout, setReadout] = useState<Hover>(null);
  // The series lit from the breakdown legend — passed to the plot to dim the rest.
  const [legendKey, setLegendKey] = useState<string | null>(null);
  if (!view.groupByPropertyId) return <ViewSetupCard kind="chart" db={db} view={view} properties={properties} />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  const matrix = toMatrix(groups, series, stacked, scheme, stacked && !!view.chartStacked100);

  return (
    <div>
      <div className="space-y-3 rounded-md border border-border p-4">
        <ChartReadout view={view} properties={properties} hover={readout} total={total} />
        {groups.length === 0 ? (
          <NoData />
        ) : (
          <KitChartPlot
            kind="bar"
            matrix={matrix}
            palette={paletteFor(scheme)}
            ariaLabel="Bar chart"
            frameless
            mode="action"
            highlightKey={legendKey}
            onSelect={(d: ChartDatum) => setDrill({title: d.label, rows: d.rows ?? []})}
            onActiveChange={(d: ChartDatum | null) => setReadout(d ? {label: d.label, value: d.value} : null)}
          />
        )}
        {stacked && groups.length > 0 && (
          <SeriesLegend
            series={series}
            groups={groups}
            activeKey={legendKey}
            onHover={(key, h) => {
              setLegendKey(key);
              setReadout(h);
            }}
            onLeave={() => {
              setLegendKey(null);
              setReadout(null);
            }}
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
  activeKey: string | null;
  onHover: (key: string, h: Hover) => void;
  onLeave: () => void;
  onPick: (title: string, rows: DatabaseRow[]) => void;
}> = ({series, groups, activeKey, onHover, onLeave, onPick}) => {
  const scheme = useDataScheme();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5">
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
              activeKey === s.key ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{backgroundColor: chartColor(s, si, scheme)}} />
            <span className="max-w-[10rem] truncate">{s.label || '—'}</span>
          </button>
        );
      })}
    </div>
  );
};

/**
 * A pie chart: one slice per group of the view's `groupByPropertyId`. With a
 * `breakdownPropertyId` it becomes a two-ring sunburst — the inner disc is the
 * primary groups, the outer ring their breakdown segments — and the legend nests
 * each group's segments. The drawn SVG (and its hover highlight) comes from the
 * kit engine; the arcs are decorative, so the legend rows here are the accessible,
 * clickable controls that hover for a readout, light the matching slice, and drill.
 */
export const PieChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const scheme = useDataScheme();
  const [drill, setDrill] = useState<Drill>(null);
  const [readout, setReadout] = useState<Hover>(null);
  // The slice/legend the pointer is over — shared so hovering the legend lights up
  // the matching slice (and a slice hover lights its legend row) via the kit plot.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  if (!view.groupByPropertyId) return <ViewSetupCard kind="chart" db={db} view={view} properties={properties} />;

  const {groups, series} = aggregateMatrix(db.visibleRows, view, properties);
  const stacked = series[0]?.key !== CHART_TOTAL_SERIES;
  const live = groups.filter((g) => g.total > 0);
  const total = live.reduce((sum, g) => sum + g.total, 0);
  if (total === 0) return <NoData />;

  const matrix = toMatrix(live, series, stacked, scheme);
  const enter = (key: string, label: string, value: number): void => {
    setHoverKey(key);
    setReadout({label, value});
  };
  const leave = (): void => {
    setHoverKey(null);
    setReadout(null);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-border p-5">
        <div className="h-44 w-44 shrink-0">
          <KitChartPlot
            kind="pie"
            matrix={matrix}
            palette={paletteFor(scheme)}
            ariaLabel={stacked ? 'Sunburst chart' : 'Pie chart'}
            viewW={PIE_SIZE}
            viewH={PIE_SIZE}
            frameless
            mode="decorative"
            highlightKey={hoverKey}
            onSelect={(d: ChartDatum) => setDrill({title: d.label, rows: d.rows ?? []})}
            onActiveChange={(d: ChartDatum | null) => {
              setReadout(d ? {label: d.label, value: d.value} : null);
              setHoverKey(d?.key ?? null);
            }}
          />
        </div>
        <div className="min-w-[12rem] flex-1 space-y-2">
          <ChartReadout view={view} properties={properties} hover={readout} total={total} />
          <div className="space-y-1.5">
            {live.map((g, i) => (
              <div key={g.key}>
                <button
                  onMouseEnter={() => enter(g.key, g.label || '—', g.total)}
                  onMouseLeave={leave}
                  onClick={() => setDrill({title: g.label || '—', rows: g.rows})}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm transition-colors hover:text-foreground',
                    hoverKey === g.key && 'bg-accent/50',
                  )}
                >
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{backgroundColor: chartColor(g, i, scheme)}} />
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
                        const sk = `${g.key}::${seg.seriesKey}`;
                        return (
                          <button
                            key={seg.seriesKey}
                            onMouseEnter={() => enter(sk, label, seg.value)}
                            onMouseLeave={leave}
                            onClick={() => setDrill({title: label, rows: seg.rows})}
                            className={cn(
                              'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                              hoverKey === sk ? 'bg-accent text-foreground' : 'bg-muted/50 text-muted-foreground hover:bg-hover hover:text-foreground',
                            )}
                          >
                            <span className="h-2 w-2 shrink-0 rounded-sm" style={{backgroundColor: chartColor(s, si, scheme)}} />
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
