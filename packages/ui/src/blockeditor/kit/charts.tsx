import React, {useEffect, useMemo, useState} from 'react';
import {aggregateRows, PARENT_GROUP_ID, type ChartAggregate, type DatabaseProperty, type DatabaseRow, type DatabaseView} from '@book.dev/sdk';
import {Select} from '@/components/ui/select';
import {blockId, blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockDef, CustomBlockProps} from '../registry';
import {computeScope, evalExpr} from './scope';
import {useKitPageLock} from './lock';
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
  return (
    <>
      <Grid d={d} />
      {series.map((s, i) => {
        const pts = linePoints(s.values, d, W, H, PAD);
        const base = scale(Math.max(d.min, 0), d, H - PAD, PAD);
        const coords = pts.split(' ');
        const first = coords[0]?.split(',')[0];
        const last = coords[coords.length - 1]?.split(',')[0];
        return (
          <g key={i}>
            {area && <polygon points={`${first},${base} ${pts} ${last},${base}`} fill={palette[i % palette.length]} opacity={0.15} />}
            <polyline points={pts} fill="none" stroke={palette[i % palette.length]} strokeWidth={2} strokeLinejoin="round" />
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
          return <rect key={`${si}-${i}`} x={x} y={Math.min(y, zero)} width={barW - 1} height={Math.max(Math.abs(zero - y), 1)} rx={2} fill={palette[si % palette.length]} />;
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
        <path key={i} d={a.path} fill={palette[i % palette.length]} stroke="hsl(var(--background, 0 0% 100%))" strokeWidth={1.5} />
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
      {pts.map((p, i) => (
        <circle key={i} cx={scale(p.x, dx, PAD, W - PAD)} cy={scale(p.y, dy, H - PAD, PAD)} r={4} fill={palette[0]} opacity={0.75} />
      ))}
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
          <rect x={PAD + r.x} y={12 + r.y} width={r.width} height={r.height} rx={4} fill={palette[i % palette.length]} opacity={0.85} />
          <text className="obe-chart-funnel-label" x={W / 2} y={12 + r.y + r.height / 2 + 4}>
            {stages[i].label} · {stages[i].value}
          </text>
        </g>
      ))}
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
  render: ({value, labels, palette}) => <Bars value={value} labels={labels} palette={palette} />,
});
registerChartKind({
  kind: 'pie',
  label: 'pie',
  render: ({value, labels, palette}) => <PieDonut value={value} labels={labels} donut={false} palette={palette} />,
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
// labels}`; the kind's `render` never learns where the data came from.

/** Aggregation types offered by a database-bound chart (mirrors the DB views). */
const DB_AGG_TYPES: readonly ChartAggregate['type'][] = ['count', 'sum', 'avg', 'min', 'max'];
/** Property types a numeric measure (`sum`/`avg`/`min`/`max`) can fold. */
const NUMERIC_PROP_TYPES = new Set(['number', 'formula', 'expr']);

/** A chart's database data source. `groupBy` is a property id or the parent
 *  sentinel; `aggProp` is the numeric property folded by non-`count` measures. */
export interface ChartDbBinding {
  dbId: string;
  groupBy: string;
  aggType: ChartAggregate['type'];
  aggProp?: string;
}

/** One series of a chart: values with an aligned label per point/slice. */
interface ChartSeriesData {
  value: number[];
  labels: string[];
}

/** Read the block's database binding, or null when it isn't in database mode. */
export const readDbBinding = (block: BlockMap): ChartDbBinding | null => {
  if (blockProp<string>(block, 'sourceMode') !== 'database') return null;
  return {
    dbId: blockProp<string>(block, 'dbId') ?? '',
    groupBy: blockProp<string>(block, 'dbGroupBy') ?? '',
    aggType: blockProp<ChartAggregate['type']>(block, 'dbAggType') ?? 'count',
    aggProp: blockProp<string>(block, 'dbAggProp') || undefined,
  };
};

/**
 * Fold a database's rows into a single labelled series via the SDK
 * {@link aggregateRows} pipeline — one datum per group of `groupBy`, its height
 * the `aggType` measure (count, or sum/avg/min/max of `aggProp`). A minimal
 * view carrying only the fields `aggregateRows` reads drives it, so the kit
 * chart and the database bar/pie views share one aggregation.
 */
export function aggregateDbSeries(rows: DatabaseRow[], properties: DatabaseProperty[], binding: ChartDbBinding): ChartSeriesData {
  const view = {
    groupByPropertyId: binding.groupBy || undefined,
    aggregate: {type: binding.aggType, propertyId: binding.aggProp},
  } as DatabaseView;
  const data = aggregateRows(rows, view, properties);
  return {value: data.map((d) => d.value), labels: data.map((d) => d.label)};
}

/**
 * Resolve a database binding's rows to a `{value, labels}` series, live. Seeds
 * from {@link DataClient.listRows} and re-aggregates on {@link
 * DataClient.subscribeRows} row edits (the same reactivity the DB chart-views
 * ride). Returns `client: null` outside a `<DataProvider>` (the viewer/export
 * bundle) so the caller falls back to the exported snapshot instead of a blank.
 */
function useDbChartSeries(binding: ChartDbBinding | null): {series: ChartSeriesData | null; client: ReturnType<typeof useOptionalData>} {
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
  return {series, client};
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

  return (
    <>
      <ConfigField label="Database" hint="Aggregate a database's rows.">
        <Select unstyled className={selectClass} value={dbId} disabled={readOnly} aria-label="Database" onChange={(e) => setProp('dbId', e.target.value)}>
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
          <Select unstyled className={selectClass} value={groupBy} disabled={readOnly} aria-label="Group by" onChange={(e) => setProp('dbGroupBy', e.target.value)}>
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
        <ConfigField label="Measure" hint="How each group is folded.">
          <div className="flex gap-1">
            <Select unstyled className={selectClass} value={aggType} disabled={readOnly} aria-label="Measure" onChange={(e) => setProp('dbAggType', e.target.value)}>
              {DB_AGG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            {aggType !== 'count' && (
              <Select unstyled className={selectClass} value={aggProp} disabled={readOnly} aria-label="Measure property" onChange={(e) => setProp('dbAggProp', e.target.value || undefined)}>
                <option value="">—</option>
                {numericProps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </ConfigField>
      )}
    </>
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
  const chromeEditable = !editor.readOnly && !pageLocked;
  const dbBinding = readDbBinding(block);
  const {series: dbSeries, client: dataClient} = useDbChartSeries(dbBinding);

  // Resolve the plotted data from whichever source is active. Expression mode is
  // the original path (evaluated over the page's inputs). Database mode reads the
  // live aggregated series in the app, or the exported snapshot in the viewer
  // (no data client there) so a bound chart still renders its last-known data.
  let value: unknown;
  let error: string | undefined;
  let effectiveLabels = labels;
  if (dbBinding) {
    if (dataClient) {
      value = dbSeries?.value;
      effectiveLabels = dbSeries?.labels ?? [];
    } else {
      const snap = blockProp<ChartSeriesData>(block, 'dbSnapshot');
      value = snap?.value;
      effectiveLabels = snap?.labels ?? [];
    }
  } else {
    const evaluated = evalExpr(source, computeScope(editor.doc).scope);
    value = evaluated.value;
    error = evaluated.error;
  }

  // Persist the resolved DB series so static exports (which can't reach a data
  // client) render the last-known data rather than a blank chart. Guarded by an
  // equality check so an unchanged series never re-writes the doc.
  useEffect(() => {
    if (!dataClient || editor.readOnly || !dbSeries) return;
    const prev = blockProp<ChartSeriesData>(block, 'dbSnapshot');
    if (prev && JSON.stringify(prev.value) === JSON.stringify(dbSeries.value) && JSON.stringify(prev.labels) === JSON.stringify(dbSeries.labels)) return;
    setProp(editor, block, 'dbSnapshot', {value: dbSeries.value, labels: dbSeries.labels});
  }, [dataClient, dbSeries, editor, block]);

  // Concrete-hex series fills for the active data-colour scheme (OB-379): the SVG
  // `fill=` attribute can't read a CSS var, so resolve the palette here — it
  // recolours live when the scheme switches.
  const palette = paletteFor(useDataScheme());

  // Unknown kinds fall back to `line`, matching the former switch `default`.
  const def = getChartKind(kind) ?? getChartKind('line')!;
  const body = (() => {
    if (error) return <text className="obe-chart-msg" x={W / 2} y={H / 2}>⚠ {error}</text>;
    const hasData = def.hasData ?? hasPlottable;
    if (value === undefined || !hasData(value, effectiveLabels)) {
      return (
        <text className="obe-chart-msg" x={W / 2} y={H / 2}>
          {dbBinding
            ? dbBinding.dbId && dbBinding.groupBy
              ? 'no rows to chart'
              : 'configure a database ⚙ — pick a database and a group-by'
            : source.trim()
              ? 'no plottable data'
              : 'configure data ⚙ — e.g. [3, 1, 4, 1, 5] or {a: [1,2], b: [3,4]}'}
        </text>
      );
    }
    return def.render({value, labels: effectiveLabels, palette});
  })();

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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title || `${kind} chart`} className="obe-chart-svg">
        {body}
      </svg>
      <KitSettings blockId={blockId(block)} title={title || `${kind} chart`}>
        <div className="flex flex-col gap-3">
          <NameDescriptionFields block={block} editor={editor} nameKey="title" namePlaceholder="Chart title" />
          <ConfigField label="Kind">
            <Select unstyled
              className="w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
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
