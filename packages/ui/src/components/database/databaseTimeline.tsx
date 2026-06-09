import React, {useEffect, useRef, useState} from 'react';
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
const pad = (n: number): string => String(n).padStart(2, '0');
const fmtDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

type DragMode = 'move' | 'start' | 'end';
interface DragState {
  rowId: string;
  mode: DragMode;
  startX: number;
  delta: number;
}

/**
 * The scrollable bar area: gridlines, today marker, draggable bars, and
 * dependency arrows. Owns the pointer-drag state (move the whole bar, or drag an
 * edge to resize), so it lives in its own component — `TimelineView` early-returns
 * before this point and must stay hook-free.
 */
const TimelineBody: React.FC<{
  laid: Laid[];
  dayW: number;
  min: Date;
  bodyW: number;
  bodyH: number;
  months: {label: string; left: number; width: number}[];
  todayX: number | null;
  depProp: DatabaseProperty | undefined;
  startProp: DatabaseProperty;
  endProp: DatabaseProperty | undefined;
  canResize: boolean;
  barColor: (row: DatabaseRow) => string;
  db: UseDatabase;
}> = ({laid, dayW, min, bodyW, bodyH, months, todayX, depProp, startProp, endProp, canResize, barColor, db}) => {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // True once a press moved far enough to count as a drag (suppresses the click).
  const movedRef = useRef(false);

  const xOf = (d: Date): number => diffDays(min, d) * dayW;
  const byId = new Map(laid.map((l) => [l.row.id, l]));

  // Persist the new span once a drag ends, honouring the date configuration:
  // a start+end pair, a single `{start,end}` range, or a single day.
  const commit = (d: DragState): void => {
    const item = byId.get(d.rowId);
    if (!item) return;
    let ns = item.span.start;
    let ne = item.span.end;
    if (d.mode === 'move') {
      ns = addDays(ns, d.delta);
      ne = addDays(ne, d.delta);
    } else if (d.mode === 'start') {
      ns = addDays(ns, d.delta);
      if (ns > ne) ns = ne;
    } else {
      ne = addDays(ne, d.delta);
      if (ne < ns) ne = ns;
    }
    const startStr = fmtDay(ns);
    const endStr = fmtDay(ne);
    if (endProp) {
      void db.setRowProperty(d.rowId, startProp.id, startStr);
      void db.setRowProperty(d.rowId, endProp.id, endStr);
    } else if (startProp.dateRange) {
      void db.setRowProperty(d.rowId, startProp.id, {start: startStr, end: ne.getTime() !== ns.getTime() ? endStr : null});
    } else {
      void db.setRowProperty(d.rowId, startProp.id, startStr);
    }
  };

  // While a drag is active, track the pointer on the window (so it keeps working
  // past the bar's edges) and quantise the movement to whole days.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.startX) > 3) movedRef.current = true;
      const delta = Math.round((e.clientX - d.startX) / dayW);
      if (delta !== d.delta) setDrag({...d, delta});
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d && d.delta !== 0) commit(d);
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag?.rowId, dayW]);

  const begin = (e: React.PointerEvent, rowId: string, mode: DragMode): void => {
    e.preventDefault();
    e.stopPropagation();
    movedRef.current = false;
    setDrag({rowId, mode, startX: e.clientX, delta: 0});
  };

  // Dependency arrows: predecessor bar end → dependent bar start.
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
    <div className="relative" style={{height: bodyH}}>
      {months.map((m, i) => (
        <div key={i} className="absolute top-0 h-full border-l border-border/30" style={{left: m.left}} />
      ))}
      {todayX !== null && <div className="absolute top-0 z-10 h-full border-l border-brand/60" style={{left: todayX}} title="Today" />}

      {laid.map((l) => {
        const preview = drag && drag.rowId === l.row.id ? drag : null;
        let left = xOf(l.span.start);
        let width = Math.max(dayW, (diffDays(l.span.start, l.span.end) + 1) * dayW);
        if (preview) {
          const dpx = preview.delta * dayW;
          if (preview.mode === 'move') left += dpx;
          else if (preview.mode === 'start') {
            left = Math.min(left + dpx, xOf(l.span.end));
            width = Math.max(dayW, width - dpx);
          } else {
            width = Math.max(dayW, width + dpx);
          }
        }
        const name = l.row.name?.trim() || 'Untitled';
        return (
          <div
            key={l.row.id}
            role="button"
            tabIndex={0}
            onPointerDown={(e) => begin(e, l.row.id, 'move')}
            onClick={() => {
              if (movedRef.current) {
                movedRef.current = false;
                return;
              }
              db.openRow(l.row.id);
            }}
            onKeyDown={(e) => e.key === 'Enter' && db.openRow(l.row.id)}
            className={cnBar(!!preview)}
            style={{
              left,
              width,
              top: l.index * ROW_H + BAR_PAD,
              height: ROW_H - BAR_PAD * 2,
              backgroundColor: barColor(l.row),
              touchAction: 'none',
            }}
            title={`${name} — drag to reschedule`}
          >
            {canResize && (
              <span
                onPointerDown={(e) => begin(e, l.row.id, 'start')}
                className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-ew-resize rounded-l bg-black/0 transition-colors group-hover/bar:bg-black/25"
                aria-hidden
              />
            )}
            <span className="pointer-events-none truncate">{name}</span>
            {canResize && (
              <span
                onPointerDown={(e) => begin(e, l.row.id, 'end')}
                className="absolute right-0 top-0 z-10 h-full w-1.5 cursor-ew-resize rounded-r bg-black/0 transition-colors group-hover/bar:bg-black/25"
                aria-hidden
              />
            )}
          </div>
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
  );
};

const cnBar = (dragging: boolean): string =>
  `group/bar absolute flex select-none items-center overflow-hidden rounded px-1.5 text-left text-xs font-medium text-white shadow-sm ${
    dragging ? 'cursor-grabbing ring-2 ring-white/60' : 'cursor-grab hover:opacity-90'
  }`;

/**
 * Timeline (Gantt) view: each dated row is a bar on a horizontal day axis, sized
 * by its date span (a `dateRange` property, or a start + end property). Bars are
 * drag-to-reschedule — drag the body to move, or an edge to resize. When the view
 * names a `dependency` property, arrows link each predecessor's bar end to the
 * dependent's bar start.
 */
export const TimelineView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({
  db,
  view,
  properties,
}) => {
  const selectProp = properties.find((p) => p.type === 'select');
  const depProp = view.dependencyPropertyId ? properties.find((p) => p.id === view.dependencyPropertyId) : undefined;
  const startProp = view.datePropertyId ? properties.find((p) => p.id === view.datePropertyId) : undefined;
  const endProp = view.endDatePropertyId ? properties.find((p) => p.id === view.endDatePropertyId) : undefined;

  if (!startProp) {
    return <Hint>Choose a start date property in the view options to lay rows out on a timeline.</Hint>;
  }

  // Resolve every row's span; keep dated rows (in view order) for the bars.
  const laid: Laid[] = [];
  db.visibleRows.forEach((row) => {
    const span = rowDateSpan(row, view, properties);
    if (span) laid.push({row, span, index: laid.length});
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
  const canResize = !!endProp || !!startProp.dateRange;

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

          <TimelineBody
            laid={laid}
            dayW={dayW}
            min={min}
            bodyW={bodyW}
            bodyH={bodyH}
            months={months}
            todayX={todayX}
            depProp={depProp}
            startProp={startProp}
            endProp={endProp}
            canResize={canResize}
            barColor={barColor}
            db={db}
          />
        </div>
      </div>
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
