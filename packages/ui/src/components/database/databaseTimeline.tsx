import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {CalendarCheck, ChevronRight, GripVertical} from 'lucide-react';
import {
  groupRowsBy,
  rowDateSpan,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView as DbView,
  type DateSpan,
} from '@open-book/sdk';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';
import {Select} from '@/components/ui/select';
import type {UseDatabase} from './useDatabase';
import {SWATCH_HEX} from './databaseColors';
import {RowChips, RowContextMenu} from './databaseLayouts';

const DAY_MS = 86_400_000;
const ROW_H = 34;
/** Two-tier date header (a coarse context row above the scale-unit row). */
const HEADER_H = 46;
/** Height of a collapsible swimlane band header row (when grouped). */
const BAND_H = 30;
const LABEL_W = 200;
const BAR_PAD = 5;
/** A bar never renders narrower than this, so it stays visible (and clickable) at coarse zooms. */
const BAR_MIN = 7;
/** How close (px) to an edge before the range grows for infinite scrolling. */
const GROW_THRESHOLD = 280;

const diffDays = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / DAY_MS);
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad = (n: number): string => String(n).padStart(2, '0');
const fmtDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfToday = (): Date => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const Hint: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>
);

// ── Zoom scales ──────────────────────────────────────────────────────────────

/** The timeline's zoom level. Drives the day width and the header granularity. */
export type TimelineScale = 'day' | 'week' | 'month' | 'quarter' | 'year';
const SCALES: TimelineScale[] = ['day', 'week', 'month', 'quarter', 'year'];
const SCALE_LABEL: Record<TimelineScale, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  quarter: 'Quarterly',
  year: 'Yearly',
};
/** Pixels per day at each zoom (coarser scales fit more time per screen). */
const SCALE_DAY_W: Record<TimelineScale, number> = {
  day: 30,
  week: 13,
  month: 4.3,
  quarter: 1.6,
  year: 0.62,
};
/** Initial (and per-grow) padding around the data, in days — sized so each zoom
 *  starts with a comfortable, scrollable margin on both sides of today. */
const SCALE_PAD_DAYS: Record<TimelineScale, number> = {
  day: 120,
  week: 260,
  month: 760,
  quarter: 1500,
  year: 3650,
};

/** A sensible default zoom for a dataset spanning `days`, when the user hasn't picked one. */
const defaultScale = (days: number): TimelineScale => {
  if (days <= 28) return 'day';
  if (days <= 120) return 'week';
  if (days <= 550) return 'month';
  if (days <= 1500) return 'quarter';
  return 'year';
};

interface Tick {
  key: string;
  label: string;
  left: number;
  width: number;
}

const monthTicks = (min: Date, max: Date, xOf: (d: Date) => number, dayW: number, withYear: boolean): Tick[] => {
  const out: Tick[] = [];
  let c = new Date(min.getFullYear(), min.getMonth(), 1);
  while (c <= max) {
    const segStart = c < min ? min : c;
    const mEnd = new Date(c.getFullYear(), c.getMonth() + 1, 0);
    const segEnd = mEnd > max ? max : mEnd;
    out.push({
      key: `m${c.getFullYear()}-${c.getMonth()}`,
      label: withYear ? `${MONTHS[c.getMonth()]} ${c.getFullYear()}` : MONTHS[c.getMonth()],
      left: xOf(segStart),
      width: (diffDays(segStart, segEnd) + 1) * dayW,
    });
    c = new Date(c.getFullYear(), c.getMonth() + 1, 1);
  }
  return out;
};

const yearTicks = (min: Date, max: Date, xOf: (d: Date) => number, dayW: number): Tick[] => {
  const out: Tick[] = [];
  for (let y = min.getFullYear(); y <= max.getFullYear(); y += 1) {
    const segStart = y === min.getFullYear() ? min : new Date(y, 0, 1);
    const yEnd = new Date(y, 11, 31);
    const segEnd = yEnd > max ? max : yEnd;
    out.push({key: `y${y}`, label: String(y), left: xOf(segStart), width: (diffDays(segStart, segEnd) + 1) * dayW});
  }
  return out;
};

const quarterTicks = (min: Date, max: Date, xOf: (d: Date) => number, dayW: number): Tick[] => {
  const out: Tick[] = [];
  let c = new Date(min.getFullYear(), Math.floor(min.getMonth() / 3) * 3, 1);
  while (c <= max) {
    const segStart = c < min ? min : c;
    const qEnd = new Date(c.getFullYear(), c.getMonth() + 3, 0);
    const segEnd = qEnd > max ? max : qEnd;
    const q = Math.floor(c.getMonth() / 3) + 1;
    out.push({key: `q${c.getFullYear()}-${q}`, label: `Q${q}`, left: xOf(segStart), width: (diffDays(segStart, segEnd) + 1) * dayW});
    c = new Date(c.getFullYear(), c.getMonth() + 3, 1);
  }
  return out;
};

const dayTicks = (min: Date, max: Date, xOf: (d: Date) => number, dayW: number): Tick[] => {
  const out: Tick[] = [];
  const n = diffDays(min, max);
  for (let i = 0; i <= n; i += 1) {
    const d = addDays(min, i);
    out.push({key: `d${i}`, label: String(d.getDate()), left: xOf(d), width: dayW});
  }
  return out;
};

const weekTicks = (min: Date, max: Date, xOf: (d: Date) => number, dayW: number): Tick[] => {
  const out: Tick[] = [];
  const startDow = (min.getDay() + 6) % 7; // 0 = Monday
  let c = addDays(min, -startDow);
  let i = 0;
  while (c <= max) {
    const segStart = c < min ? min : c;
    const wEnd = addDays(c, 6);
    const segEnd = wEnd > max ? max : wEnd;
    out.push({
      key: `w${i}`,
      label: `${MONTHS[segStart.getMonth()]} ${segStart.getDate()}`,
      left: xOf(segStart),
      width: (diffDays(segStart, segEnd) + 1) * dayW,
    });
    c = addDays(c, 7);
    i += 1;
  }
  return out;
};

/** The header axis for a zoom level: a coarse context tier (`top`) above the
 *  scale-unit tier (`bottom`). `top` is empty at year zoom (years are the unit). */
const buildAxis = (scale: TimelineScale, min: Date, max: Date, xOf: (d: Date) => number, dayW: number): {top: Tick[]; bottom: Tick[]} => {
  switch (scale) {
  case 'day':
    return {top: monthTicks(min, max, xOf, dayW, true), bottom: dayTicks(min, max, xOf, dayW)};
  case 'week':
    return {top: monthTicks(min, max, xOf, dayW, true), bottom: weekTicks(min, max, xOf, dayW)};
  case 'month':
    return {top: yearTicks(min, max, xOf, dayW), bottom: monthTicks(min, max, xOf, dayW, false)};
  case 'quarter':
    return {top: yearTicks(min, max, xOf, dayW), bottom: quarterTicks(min, max, xOf, dayW)};
  case 'year':
    return {top: [], bottom: yearTicks(min, max, xOf, dayW)};
  }
};

interface Laid {
  row: DatabaseRow;
  /** The resolved date span (a bar), or `null` for an unscheduled row (an empty,
   *  click-to-place lane). */
  span: DateSpan | null;
  /** The row's position in the body, in pixels from the top (band-aware). */
  top: number;
}

/** A collapsible Gantt swimlane band (when the timeline groups by a property). */
interface Band {
  key: string;
  label: string;
  color?: string;
  count: number;
  top: number;
  collapsed: boolean;
}

type DragMode = 'move' | 'start' | 'end';
interface DragState {
  rowId: string;
  mode: DragMode;
  startX: number;
  delta: number;
}

/** An in-progress drag-to-link of one bar onto another (a dependency edge). */
interface LinkState {
  sourceRowId: string;
  toX: number;
  toY: number;
  targetId: string | null;
}

const cnBar = (dragging: boolean): string =>
  `group/bar absolute flex select-none items-center overflow-hidden rounded px-1.5 text-left text-xs font-medium text-white shadow-sm ${
    dragging ? 'cursor-grabbing ring-2 ring-white/60' : 'cursor-grab hover:opacity-90'
  }`;

/**
 * Timeline (Gantt) view: each dated row is a bar on a horizontal day axis, sized
 * by its date span (a `dateRange` property, or a start + end property). Bars are
 * drag-to-reschedule (drag the body to move, an edge to resize) and drag-to-link
 * (the finish-edge handle onto another bar adds a dependency). The axis is
 * zoomable (daily…yearly), today is marked and centred, and the canvas scrolls
 * indefinitely either way. Clicking empty canvas places an item — a new row at
 * that date, or the row armed from the "Unscheduled" tray.
 *
 * `TimelineView` resolves the date configuration and early-returns a hint when it
 * can't lay anything out; the hook-bearing work lives in `TimelineCanvas`, which
 * is only mounted once a start-date property exists (so its hooks run
 * unconditionally).
 */
export const TimelineView: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  /** Properties to show as chips under each rail label (the dates drive placement). */
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, cardProperties}) => {
  const startProp = view.datePropertyId ? properties.find((p) => p.id === view.datePropertyId) : undefined;
  if (!startProp) {
    return <Hint>Choose a start date property in the view options to lay rows out on a timeline.</Hint>;
  }
  return <TimelineCanvas db={db} view={view} properties={properties} startProp={startProp} cardProperties={cardProperties} />;
};

const TimelineCanvas: React.FC<{
  db: UseDatabase;
  view: DbView;
  properties: DatabaseProperty[];
  startProp: DatabaseProperty;
  cardProperties?: DatabaseProperty[];
}> = ({db, view, properties, startProp, cardProperties}) => {
  // Collapsed swimlane bands persist per view (mirrors the board's lane folds).
  const [collapsedBands, setCollapsedBands] = useState<Set<string>>(() => readBandFolds(view.id));
  const toggleBand = (key: string): void =>
    setCollapsedBands((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeBandFolds(view.id, next);
      return next;
    });

  // Band (swimlane) reorder by dragging the gutter, mirroring the board lanes.
  const [dragBand, setDragBand] = useState<string | null>(null);
  const [overBand, setOverBand] = useState<string | null>(null);
  const groupProp = view.groupByPropertyId ? properties.find((p) => p.id === view.groupByPropertyId) : undefined;
  const canMoveBand = groupProp?.type === 'select' || groupProp?.type === 'status';
  const isBandOption = (key: string): boolean => canMoveBand && key !== '__none__' && key !== '__all__';
  const reorderBand = (fromKey: string, toKey: string): void => {
    if (!groupProp || !canMoveBand) return;
    const opts = [...(groupProp.options ?? [])];
    const from = opts.findIndex((o) => o.id === fromKey);
    const to = opts.findIndex((o) => o.id === toKey);
    if (from >= 0 && to >= 0 && from !== to) {
      const [moved] = opts.splice(from, 1);
      opts.splice(to, 0, moved);
      void db.updateProperty(groupProp.id, {options: opts});
    }
    setDragBand(null);
    setOverBand(null);
  };

  // Bars colour by the view's chosen colour property (a select/status), falling
  // back to the first select property.
  const configuredColor = view.cardColorPropertyId ? properties.find((p) => p.id === view.cardColorPropertyId) : undefined;
  const selectProp = configuredColor ?? properties.find((p) => p.type === 'select');
  // Use the view's dependency property, else the first `dependency` column, so a
  // timeline with a dependency column draws arrows (and allows drag-to-link) out
  // of the box.
  const depProp =
    (view.dependencyPropertyId ? properties.find((p) => p.id === view.dependencyPropertyId) : undefined) ??
    properties.find((p) => p.type === 'dependency');
  const endProp = view.endDatePropertyId ? properties.find((p) => p.id === view.endDatePropertyId) : undefined;
  const railProps = (cardProperties ?? []).filter((p) => p.id !== view.datePropertyId && p.id !== view.endDatePropertyId);
  const rowH = railProps.length > 0 ? 52 : ROW_H;
  const canResize = !!endProp || !!startProp.dateRange;

  // Resolve every visible row's span. Dated rows become bars; the rest still get
  // a lane (label + empty track) you can click to place them on the timeline.
  const spanOf = new Map<string, DateSpan>();
  const datedRows: DatabaseRow[] = [];
  db.visibleRows.forEach((row) => {
    const span = rowDateSpan(row, view, properties);
    if (span) {
      spanOf.set(row.id, span);
      datedRows.push(row);
    }
  });

  // Swimlane bands: timeline grouping reuses `groupByPropertyId`. Each band is a
  // labelled, collapsible Gantt row band; every row gets a lane within its band.
  const grouped = !!view.groupByPropertyId;
  const groups = grouped
    ? groupRowsBy(db.visibleRows, view.groupByPropertyId, properties).filter((g) => g.rows.length > 0)
    : [{key: '__all__', label: 'All', color: undefined, rows: db.visibleRows}];

  const laid: Laid[] = [];
  const bands: Band[] = [];
  let y = 0;
  for (const g of groups) {
    const collapsed = grouped && collapsedBands.has(g.key);
    if (grouped) {
      bands.push({key: g.key, label: g.label, color: g.color, count: g.rows.length, top: y, collapsed});
      y += BAND_H;
    }
    if (!collapsed) {
      for (const row of g.rows) {
        laid.push({row, span: spanOf.get(row.id) ?? null, top: y});
        y += rowH;
      }
    }
  }
  const bodyH = Math.max(y, rowH * 3);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const today = startOfToday();
  // Data extent (today included so the marker always has a place), used to size
  // the default zoom and anchor the padded range.
  let dataMin = datedRows.length ? spanOf.get(datedRows[0].id)!.start : today;
  let dataMax = dataMin;
  for (const row of datedRows) {
    const span = spanOf.get(row.id)!;
    if (span.start < dataMin) dataMin = span.start;
    if (span.end > dataMax) dataMax = span.end;
  }
  if (today < dataMin) dataMin = today;
  if (today > dataMax) dataMax = today;
  const dataDays = diffDays(dataMin, dataMax) + 1;

  // The user's chosen zoom sticks (per view); otherwise it tracks the data span.
  const [scalePref, setScalePref] = useState<TimelineScale | null>(() => readScale(view.id));
  const scale = scalePref ?? defaultScale(dataDays);
  const setScale = (s: TimelineScale): void => {
    setScalePref(s);
    writeScale(view.id, s);
  };
  const dayW = SCALE_DAY_W[scale];
  const padDays = SCALE_PAD_DAYS[scale];

  // Infinite scroll: the rendered range grows in `padDays` chunks as the user
  // nears either edge (`extra*` are the accumulated extensions).
  const [extraBefore, setExtraBefore] = useState(0);
  const [extraAfter, setExtraAfter] = useState(0);
  const min = addDays(dataMin, -(padDays + extraBefore));
  const max = addDays(dataMax, padDays + extraAfter);
  const totalDays = diffDays(min, max) + 1;
  const bodyW = totalDays * dayW;
  const xOf = (d: Date): number => diffDays(min, d) * dayW;
  const todayX = xOf(today) + dayW / 2;
  const axis = buildAxis(scale, min, max, xOf, dayW);
  const topH = axis.top.length ? 22 : 0;
  const gridTicks = axis.top.length ? axis.top : axis.bottom;

  const barColor = (row: DatabaseRow): string => {
    if (selectProp) {
      const opt = selectProp.options?.find((o) => o.id === row.properties[selectProp.id]);
      if (opt?.color) return SWATCH_HEX[opt.color] ?? SWATCH_HEX.blue;
    }
    return SWATCH_HEX.blue;
  };

  // ── Scroll: centre today, and extend the range near the edges ───────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScale = useRef<TimelineScale | null>(null);
  const prevExtraBefore = useRef(0);
  const growPending = useRef(false);

  const centreToday = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, todayX - el.clientWidth / 2);
  };

  // Centre on today on mount and whenever the zoom changes; when the leading edge
  // grows, shift scrollLeft by the inserted width so the view stays put.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevScale.current !== scale) {
      centreToday();
      prevScale.current = scale;
      prevExtraBefore.current = extraBefore;
      growPending.current = false;
      return;
    }
    if (extraBefore !== prevExtraBefore.current) {
      el.scrollLeft += (extraBefore - prevExtraBefore.current) * dayW;
      prevExtraBefore.current = extraBefore;
    }
    growPending.current = false;
  }, [scale, extraBefore, extraAfter, dayW, todayX]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el || growPending.current) return;
    if (el.scrollLeft < GROW_THRESHOLD) {
      growPending.current = true;
      setExtraBefore((v) => v + padDays);
    } else if (el.scrollWidth - el.clientWidth - el.scrollLeft < GROW_THRESHOLD) {
      growPending.current = true;
      setExtraAfter((v) => v + padDays);
    }
  };

  // ── Click-to-place ──────────────────────────────────────────────────────────
  const bodyRef = useRef<HTMLDivElement>(null);
  // The start value shaped for the configured date property (a range vs a plain day).
  const startValueAt = (date: Date): unknown => (startProp.dateRange ? {start: fmtDay(date), end: null} : fmtDay(date));
  /** The day under a horizontal client x, in the body's date space. */
  const dayAtClientX = (clientX: number): Date => {
    const rect = bodyRef.current?.getBoundingClientRect();
    return addDays(min, Math.floor((clientX - (rect?.left ?? 0)) / dayW));
  };
  /** Schedule an unscheduled row by clicking its lane (gives its start date a value). */
  const scheduleRow = (rowId: string, clientX: number): void => {
    void db.setRowProperty(rowId, startProp.id, startValueAt(dayAtClientX(clientX)));
  };

  // ── Drag-to-reschedule + drag-to-link (pointer drags on the body) ────────────
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const movedRef = useRef(false);
  const byId = new Map(laid.map((l) => [l.row.id, l]));

  const commit = (d: DragState): void => {
    const item = byId.get(d.rowId);
    if (!item?.span) return;
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
      // One atomic write: two sequential single-property writes raced, the second
      // reverting the first (a drag that moved only one edge of the bar).
      void db.setRowProperties(d.rowId, {[startProp.id]: startStr, [endProp.id]: endStr});
    } else if (startProp.dateRange) {
      void db.setRowProperty(d.rowId, startProp.id, {start: startStr, end: ne.getTime() !== ns.getTime() ? endStr : null});
    } else {
      void db.setRowProperty(d.rowId, startProp.id, startStr);
    }
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.startX) > 3) movedRef.current = true;
      const delta = Math.round((e.clientX - d.startX) / dayW);
      if (delta !== d.delta) setDrag({...d, delta});
    };
    const onUp = (): void => {
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

  const [link, setLink] = useState<LinkState | null>(null);
  const linkRef = useRef<LinkState | null>(null);
  linkRef.current = link;

  const linkAnchor = (rowId: string): {x: number; y: number} | null => {
    const l = byId.get(rowId);
    return l?.span ? {x: xOf(addDays(l.span.end, 1)), y: l.top + rowH / 2} : null;
  };
  const targetAt = (px: number, py: number, sourceRowId: string): string | null => {
    for (const l of laid) {
      if (l.row.id === sourceRowId || !l.span) continue;
      if (py < l.top + BAR_PAD || py > l.top + rowH - BAR_PAD) continue;
      const left = xOf(l.span.start);
      const w = Math.max(BAR_MIN, (diffDays(l.span.start, l.span.end) + 1) * dayW);
      if (px >= left && px <= left + w) return l.row.id;
    }
    return null;
  };
  const toBody = (e: PointerEvent | React.PointerEvent): {x: number; y: number} => {
    const rect = bodyRef.current?.getBoundingClientRect();
    return {x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0)};
  };
  const beginLink = (e: React.PointerEvent, rowId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    const {x, y} = toBody(e);
    setLink({sourceRowId: rowId, toX: x, toY: y, targetId: null});
  };

  useEffect(() => {
    if (!link || !depProp) return;
    const onMove = (e: PointerEvent): void => {
      const cur = linkRef.current;
      if (!cur) return;
      const {x, y} = toBody(e);
      setLink({...cur, toX: x, toY: y, targetId: targetAt(x, y, cur.sourceRowId)});
    };
    const onUp = (): void => {
      const cur = linkRef.current;
      if (cur?.targetId) {
        const target = byId.get(cur.targetId);
        const deps = Array.isArray(target?.row.properties[depProp.id]) ? (target!.row.properties[depProp.id] as string[]) : [];
        if (!deps.includes(cur.sourceRowId)) void db.setRowProperty(cur.targetId, depProp.id, [...deps, cur.sourceRowId]);
      }
      setLink(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [link?.sourceRowId, depProp, dayW]);

  // Click empty canvas (no row's lane) → create a new row dated there.
  const onCreateClick = (e: React.MouseEvent): void => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    void db.addRow({[startProp.id]: startValueAt(dayAtClientX(e.clientX))});
  };

  // Dependency arrows: predecessor bar end → dependent bar start (dated rows only).
  const arrows: {x1: number; y1: number; x2: number; y2: number}[] = [];
  if (depProp) {
    for (const l of laid) {
      if (!l.span) continue;
      const deps = Array.isArray(l.row.properties[depProp.id]) ? (l.row.properties[depProp.id] as string[]) : [];
      for (const predId of deps) {
        const pred = byId.get(predId);
        if (!pred?.span) continue;
        arrows.push({
          x1: xOf(addDays(pred.span.end, 1)),
          y1: pred.top + rowH / 2,
          x2: xOf(l.span.start),
          y2: l.top + rowH / 2,
        });
      }
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar: zoom + recentre on today. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Timeline scale"
          value={scale}
          onChange={(e) => setScale(e.target.value as TimelineScale)}
          inputSize="sm"
          wrapperClassName="w-32"
        >
          {SCALES.map((s) => (
            <option key={s} value={s}>
              {SCALE_LABEL[s]}
            </option>
          ))}
        </Select>
        <button
          onClick={centreToday}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <CalendarCheck className="h-3.5 w-3.5" /> Today
        </button>
      </div>

      <div className="flex overflow-hidden rounded-md border border-border">
        {/* Fixed label column: band headers (when grouped) interleaved with row labels. */}
        <div className="shrink-0 border-r border-border" style={{width: LABEL_W}}>
          <div className="border-b border-border bg-muted/30" style={{height: HEADER_H}} />
          {groups.map((g) => {
            const collapsed = grouped && collapsedBands.has(g.key);
            return (
              <div key={g.key}>
                {grouped && (
                  <div
                    data-band-key={g.key}
                    onDragOver={(e) => {
                      if (dragBand && isBandOption(g.key)) {
                        e.preventDefault();
                        setOverBand(g.key);
                      }
                    }}
                    onDrop={() => dragBand && reorderBand(dragBand, g.key)}
                    className={cn(
                      'flex w-full items-center border-b border-border/60 bg-muted/20 text-xs font-medium text-muted-foreground transition-colors',
                      dragBand === g.key && 'opacity-40',
                      overBand === g.key && 'ring-1 ring-inset ring-brand/40',
                    )}
                    style={{height: BAND_H}}
                  >
                    {isBandOption(g.key) && (
                      <span
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          setDragBand(g.key);
                        }}
                        onDragEnd={() => {
                          setDragBand(null);
                          setOverBand(null);
                        }}
                        aria-label={`Reorder ${g.label} band`}
                        className="flex h-full cursor-grab items-center pl-1 text-muted-foreground/30 transition-colors hover:text-muted-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                    )}
                    <button
                      onClick={() => toggleBand(g.key)}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${g.label} band`}
                      className={cn(
                        'flex h-full flex-1 items-center gap-1 px-2 text-left transition-colors hover:bg-hover hover:text-foreground',
                        isBandOption(g.key) && 'pl-1',
                      )}
                    >
                      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                      {g.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{backgroundColor: SWATCH_HEX[g.color] ?? '#9ca3af'}} />}
                      <span className="truncate">{g.label}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground/60">{g.rows.length}</span>
                    </button>
                  </div>
                )}
                {!collapsed &&
                  g.rows.map((row) => (
                    <RowContextMenu key={row.id} db={db} rowId={row.id}>
                      <button
                        onClick={() => db.openRow(row.id)}
                        className="flex w-full flex-col justify-center gap-0.5 border-b border-border/60 px-2 text-left text-sm last:border-0 hover:bg-hover"
                        style={{height: rowH}}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="shrink-0 text-sm leading-none">{readPageIcon(row.id)}</span>
                          <span className="truncate">{row.name?.trim() || 'Untitled'}</span>
                        </span>
                        {railProps.length > 0 && (
                          <span className="flex h-[18px] items-center overflow-hidden">
                            <RowChips row={row} properties={railProps} rows={db.rows} />
                          </span>
                        )}
                      </button>
                    </RowContextMenu>
                  ))}
              </div>
            );
          })}
        </div>

        {/* Scrollable timeline. */}
        <div ref={scrollRef} onScroll={onScroll} className="min-w-0 flex-1 overflow-x-auto">
          <div style={{width: bodyW}}>
            {/* Date axis (two tiers). */}
            <div className="relative border-b border-border bg-muted/30" style={{height: HEADER_H}}>
              {axis.top.map((t) => (
                <div
                  key={t.key}
                  className="absolute top-0 flex items-center border-l border-border/60 text-xs font-medium text-muted-foreground"
                  style={{left: t.left, width: t.width, height: topH}}
                >
                  {/* Sticky so the year/month stays visible while scrolling within it
                      (the label slides to the segment's edge instead of off-screen). */}
                  {t.width > 48 && <span className="sticky left-2 whitespace-nowrap pr-2">{t.label}</span>}
                </div>
              ))}
              {axis.bottom.map((t) => (
                <div
                  key={t.key}
                  className="absolute flex items-center justify-center border-l border-border/40 text-[11px] text-muted-foreground/80"
                  style={{left: t.left, top: topH, width: t.width, height: HEADER_H - topH}}
                >
                  {t.width > 18 ? t.label : ''}
                </div>
              ))}
              {/* Today marker tag, aligned with the body's vertical bar. */}
              <div
                className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-b bg-brand px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                style={{left: todayX, top: 0}}
              >
                Today
              </div>
            </div>

            <div ref={bodyRef} className="relative" style={{height: bodyH}}>
              {/* Background: clicking empty canvas (no row lane) adds a new row here. */}
              <div className="absolute inset-0 z-0" onClick={onCreateClick} title="Click to add a new item here" />
              {gridTicks.map((t) => (
                <div key={t.key} className="pointer-events-none absolute top-0 h-full border-l border-border/25" style={{left: t.left}} />
              ))}
              {bands.map((b) => (
                <div
                  key={b.key}
                  className="pointer-events-none absolute left-0 z-[1] border-b border-border/60 bg-muted/20"
                  style={{top: b.top, width: bodyW, height: BAND_H}}
                />
              ))}
              <div className="pointer-events-none absolute top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-brand/70" style={{left: todayX}} title="Today" />

              {laid.length === 0 && (
                <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  No rows have a date yet — click anywhere on the timeline to add one.
                </div>
              )}

              {laid.map((l) => {
                const name = l.row.name?.trim() || 'Untitled';
                // Unscheduled row: an empty lane spanning the width — click anywhere
                // on it to give this row a date (place its bar there).
                if (!l.span) {
                  return (
                    <button
                      key={l.row.id}
                      onClick={(e) => {
                        if (movedRef.current) {
                          movedRef.current = false;
                          return;
                        }
                        scheduleRow(l.row.id, e.clientX);
                      }}
                      aria-label={`Schedule ${name} on the timeline`}
                      title="Click to place this item on the timeline"
                      className="group/lane absolute left-0 z-[1] flex cursor-copy items-center"
                      style={{top: l.top + BAR_PAD, height: rowH - BAR_PAD * 2, width: bodyW}}
                    >
                      <span className="sticky left-2 rounded border border-dashed border-border bg-background/70 px-2 py-0.5 text-xs text-muted-foreground/70 transition-colors group-hover/lane:border-brand group-hover/lane:text-brand">
                        Click to schedule
                      </span>
                    </button>
                  );
                }
                const preview = drag && drag.rowId === l.row.id ? drag : null;
                let left = xOf(l.span.start);
                let width = Math.max(BAR_MIN, (diffDays(l.span.start, l.span.end) + 1) * dayW);
                if (preview) {
                  const dpx = preview.delta * dayW;
                  if (preview.mode === 'move') left += dpx;
                  else if (preview.mode === 'start') {
                    left = Math.min(left + dpx, xOf(l.span.end));
                    width = Math.max(BAR_MIN, width - dpx);
                  } else {
                    width = Math.max(BAR_MIN, width + dpx);
                  }
                }
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
                    className={cn(cnBar(!!preview), 'z-[2]', link?.targetId === l.row.id && 'ring-2 ring-brand')}
                    style={{
                      left,
                      width,
                      top: l.top + BAR_PAD,
                      height: rowH - BAR_PAD * 2,
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
                    {depProp && (
                      <span
                        onPointerDown={(e) => beginLink(e, l.row.id)}
                        onClick={(e) => e.stopPropagation()}
                        // Inside the bar's right edge — the bar is `overflow-hidden`,
                        // so a handle placed outside would be clipped.
                        className="absolute right-0.5 top-1/2 z-20 h-2.5 w-2.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-white/30 opacity-0 transition-opacity group-hover/bar:opacity-100"
                        aria-label="Link dependency"
                        title="Drag onto another row to add a dependency"
                      />
                    )}
                  </div>
                );
              })}

              {link && (() => {
                const a = linkAnchor(link.sourceRowId);
                return a ? (
                  <svg className="pointer-events-none absolute inset-0 z-30" width={bodyW} height={bodyH}>
                    <path d={`M ${a.x} ${a.y} L ${link.toX} ${link.toY}`} className="stroke-brand" strokeWidth={2} strokeDasharray="4 3" fill="none" />
                  </svg>
                ) : null;
              })()}

              {arrows.length > 0 && (
                <svg className="pointer-events-none absolute inset-0 z-[3]" width={bodyW} height={bodyH}>
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
      </div>
    </div>
  );
};

/** Per-view persistence of collapsed swimlane bands (mirrors the board's lane folds). */
const bandFoldsKey = (viewId: string): string => `ob.timeline.bands.${viewId}`;
function readBandFolds(viewId: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(bandFoldsKey(viewId));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}
function writeBandFolds(viewId: string, folds: Set<string>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(bandFoldsKey(viewId), JSON.stringify([...folds]));
  } catch {
    /* quota / private mode — fold still works in-session. */
  }
}

/** Per-view persistence of the chosen zoom scale. */
const scaleKey = (viewId: string): string => `ob.timeline.scale.${viewId}`;
function readScale(viewId: string): TimelineScale | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(scaleKey(viewId));
    return raw && (SCALES as string[]).includes(raw) ? (raw as TimelineScale) : null;
  } catch {
    return null;
  }
}
function writeScale(viewId: string, scale: TimelineScale): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(scaleKey(viewId), scale);
  } catch {
    /* quota / private mode — zoom still works in-session. */
  }
}

export default TimelineView;
