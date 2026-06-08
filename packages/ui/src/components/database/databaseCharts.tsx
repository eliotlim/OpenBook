import React from 'react';
import {aggregateRows, type DatabaseProperty, type DatabaseView as DbView} from '@open-book/sdk';
import {cn} from '@/lib/utils';
import type {UseDatabase} from './useDatabase';
import {chartColor} from './databaseColors';

/** A short numeric label for a bar/slice value (keeps long sums readable). */
const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, {maximumFractionDigits: 2});
};

const NeedsGrouping: React.FC = () => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
    Pick a property to group by in the view options to chart this data.
  </div>
);

/**
 * A horizontal bar chart: one bar per group of the view's `groupByPropertyId`,
 * sized by its aggregate (count by default, else sum/avg/min/max of a numeric
 * property). Dependency-free — just flexbox bars — so it renders identically in
 * the web app and the desktop WKWebView.
 */
export const BarChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  if (!view.groupByPropertyId) return <NeedsGrouping />;
  const data = aggregateRows(db.visibleRows, view, properties);
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div className="space-y-2 rounded-md border border-border p-4">
      {data.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No data to chart.</div>}
      {data.map((datum, i) => (
        <div key={datum.key} className="flex items-center gap-2 text-sm">
          <div className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground" title={datum.label}>
            {datum.label || '—'}
          </div>
          <div className="relative h-6 flex-1 overflow-hidden rounded bg-muted/40">
            <div
              className="flex h-full items-center rounded transition-all"
              style={{width: `${Math.max(2, (datum.value / max) * 100)}%`, backgroundColor: chartColor(datum, i)}}
            />
          </div>
          <div className="w-12 shrink-0 text-right tabular-nums text-xs font-medium">{fmt(datum.value)}</div>
        </div>
      ))}
    </div>
  );
};

/**
 * A pie chart drawn with a CSS `conic-gradient` plus a legend. Each slice is a
 * group of the view's `groupByPropertyId`, sized by the same aggregate as the
 * bar chart.
 */
export const PieChartView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  if (!view.groupByPropertyId) return <NeedsGrouping />;
  const data = aggregateRows(db.visibleRows, view, properties).filter((d) => d.value > 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return <div className="rounded-md border border-border px-4 py-10 text-center text-sm text-muted-foreground">No data to chart.</div>;
  }

  // Build the conic-gradient stops; each slice spans its share of 360°.
  let acc = 0;
  const stops = data
    .map((datum, i) => {
      const start = (acc / total) * 360;
      acc += datum.value;
      const end = (acc / total) * 360;
      return `${chartColor(datum, i)} ${start}deg ${end}deg`;
    })
    .join(', ');

  return (
    <div className="flex flex-wrap items-center gap-6 rounded-md border border-border p-5">
      <div
        className="h-44 w-44 shrink-0 rounded-full shadow-inner"
        style={{background: `conic-gradient(${stops})`}}
        role="img"
        aria-label="Pie chart"
      />
      <div className="min-w-[10rem] flex-1 space-y-1.5">
        {data.map((datum, i) => (
          <div key={datum.key} className="flex items-center gap-2 text-sm">
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{backgroundColor: chartColor(datum, i)}} />
            <span className="min-w-0 flex-1 truncate" title={datum.label}>
              {datum.label || '—'}
            </span>
            <span className="tabular-nums text-xs text-muted-foreground">{fmt(datum.value)}</span>
            <span className={cn('w-10 text-right tabular-nums text-xs font-medium')}>
              {Math.round((datum.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
