import React from 'react';
import {Plus} from 'lucide-react';
import {
  rowDateSpan,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type DateSpan,
} from '@open-book/sdk';
import {readPageIcon} from '@/lib/pageIcon';
import type {UseDatabase} from './useDatabase';
import {SWATCH_HEX} from './databaseColors';

const DAY_MS = 86_400_000;
const ROW_H = 34;
const HEADER_H = 40;
const LABEL_W = 200;
const BAR_PAD = 5;

const diffDays = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const Hint: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>
);

/** Pick a readable day width so the whole range fits without being cramped. */
const dayWidthFor = (totalDays: number): number => {
  if (totalDays <= 21) return 34;
  if (totalDays <= 45) return 20;
  if (totalDays <= 90) return 11;
  if (totalDays <= 200) return 6;
  return 3;
};

interface Laid {
  row: DatabaseRow;
  span: DateSpan;
  index: number;
}

/**
 * Timeline (Gantt) view: each dated row is a bar on a horizontal day axis, sized
 * by its date span (a `dateRange` property, or a start + end property). When the
 * view names a `dependency` property, arrows are drawn from each predecessor's
 * bar end to the dependent's bar start.
 */
export const TimelineView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  const selectProp = properties.find((p) => p.type === 'select');
  const depProp = view.dependencyPropertyId ? properties.find((p) => p.id === view.dependencyPropertyId) : undefined;

  if (!view.datePropertyId) {
    return <Hint>Choose a start date property in the view options to lay rows out on a timeline.</Hint>;
  }

  // Resolve every row's span; keep dated rows (in view order) for the bars.
  const laid: Laid[] = [];
  let undated = 0;
  db.visibleRows.forEach((row) => {
    const span = rowDateSpan(row, view, properties);
    if (span) laid.push({row, span, index: laid.length});
    else undated += 1;
  });

  if (laid.length === 0) {
    return (
      <Hint>
        No rows have a date yet. Set the start date property on a row to place it on the timeline.
        <div className="mt-3">
          <NewRowButton onClick={() => void db.addRow()} />
        </div>
      </Hint>
    );
  }

  // Overall range (padded a day each side for breathing room).
  let min = laid[0].span.start;
  let max = laid[0].span.end;
  for (const l of laid) {
    if (l.span.start < min) min = l.span.start;
    if (l.span.end > max) max = l.span.end;
  }
  min = addDays(min, -1);
  max = addDays(max, 1);
  const totalDays = diffDays(min, max) + 1;
  const dayW = dayWidthFor(totalDays);
  const bodyW = totalDays * dayW;
  const bodyH = laid.length * ROW_H;

  const xOf = (d: Date): number => diffDays(min, d) * dayW;
  const barColor = (row: DatabaseRow): string => {
    if (selectProp) {
      const opt = selectProp.options?.find((o) => o.id === row.properties[selectProp.id]);
      if (opt?.color) return SWATCH_HEX[opt.color] ?? SWATCH_HEX.blue;
    }
    return SWATCH_HEX.blue;
  };

  // Month header segments.
  const months: {label: string; left: number; width: number}[] = [];
  let cursor = new Date(min.getFullYear(), min.getMonth(), 1);
  while (cursor <= max) {
    const monthStart = cursor < min ? min : cursor;
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const segEnd = monthEnd > max ? max : monthEnd;
    months.push({
      label: `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`,
      left: xOf(monthStart),
      width: (diffDays(monthStart, segEnd) + 1) * dayW,
    });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  const today = new Date();
  const todayX = today >= min && today <= max ? xOf(today) + dayW / 2 : null;

  // Dependency arrows: predecessor bar end → dependent bar start.
  const byId = new Map(laid.map((l) => [l.row.id, l]));
  const arrows: {x1: number; y1: number; x2: number; y2: number}[] = [];
  if (depProp) {
    for (const l of laid) {
      const deps = Array.isArray(l.row.properties[depProp.id]) ? (l.row.properties[depProp.id] as string[]) : [];
      for (const predId of deps) {
        const pred = byId.get(predId);
        if (!pred) continue;
        arrows.push({
          x1: xOf(addDays(pred.span.end, 1)),
          y1: pred.index * ROW_H + ROW_H / 2,
          x2: xOf(l.span.start),
          y2: l.index * ROW_H + ROW_H / 2,
        });
      }
    }
  }

  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {/* Fixed label column. */}
      <div className="shrink-0 border-r border-border" style={{width: LABEL_W}}>
        <div className="border-b border-border bg-muted/30" style={{height: HEADER_H}} />
        {laid.map((l) => (
          <button
            key={l.row.id}
            onClick={() => db.openRow(l.row.id)}
            className="flex w-full items-center gap-1.5 border-b border-border/60 px-2 text-left text-sm last:border-0 hover:bg-accent/30"
            style={{height: ROW_H}}
          >
            <span className="shrink-0 text-sm leading-none">{readPageIcon(l.row.id)}</span>
            <span className="truncate">{l.row.name?.trim() || 'Untitled'}</span>
          </button>
        ))}
      </div>

      {/* Scrollable timeline. */}
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div style={{width: bodyW}}>
          {/* Month axis. */}
          <div className="relative border-b border-border bg-muted/30" style={{height: HEADER_H}}>
            {months.map((m, i) => (
              <div
                key={i}
                className="absolute top-0 flex h-full items-center border-l border-border/60 px-2 text-xs font-medium text-muted-foreground"
                style={{left: m.left, width: m.width}}
              >
                {m.width > 48 ? m.label : ''}
              </div>
            ))}
          </div>

          {/* Bars + dependency arrows. */}
          <div className="relative" style={{height: bodyH}}>
            {months.map((m, i) => (
              <div key={i} className="absolute top-0 h-full border-l border-border/30" style={{left: m.left}} />
            ))}
            {todayX !== null && (
              <div className="absolute top-0 z-10 h-full border-l border-brand/60" style={{left: todayX}} title="Today" />
            )}

            {laid.map((l) => {
              const left = xOf(l.span.start);
              const width = Math.max(dayW, (diffDays(l.span.start, l.span.end) + 1) * dayW);
              return (
                <button
                  key={l.row.id}
                  onClick={() => db.openRow(l.row.id)}
                  className="absolute flex items-center overflow-hidden rounded px-1.5 text-left text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
                  style={{
                    left,
                    width,
                    top: l.index * ROW_H + BAR_PAD,
                    height: ROW_H - BAR_PAD * 2,
                    backgroundColor: barColor(l.row),
                  }}
                  title={l.row.name?.trim() || 'Untitled'}
                >
                  <span className="truncate">{l.row.name?.trim() || 'Untitled'}</span>
                </button>
              );
            })}

            {arrows.length > 0 && (
              <svg className="pointer-events-none absolute inset-0" width={bodyW} height={bodyH}>
                <defs>
                  <marker id="ob-dep-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" className="fill-muted-foreground/70" />
                  </marker>
                </defs>
                {arrows.map((a, i) => {
                  const midX = Math.max(a.x1 + 8, a.x2 - 8);
                  return (
                    <path
                      key={i}
                      d={`M ${a.x1} ${a.y1} H ${midX} V ${a.y2} H ${a.x2}`}
                      className="stroke-muted-foreground/60"
                      strokeWidth={1.5}
                      fill="none"
                      markerEnd="url(#ob-dep-arrow)"
                    />
                  );
                })}
              </svg>
            )}
          </div>
        </div>
      </div>

      {/* Footer note + add row. */}
      {undated > 0 && (
        <div className="sr-only">
          {undated} undated row{undated === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
};

const NewRowButton: React.FC<{onClick: () => void}> = ({onClick}) => (
  <button
    onClick={onClick}
    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
  >
    <Plus className="h-4 w-4" /> New row
  </button>
);

export default TimelineView;
