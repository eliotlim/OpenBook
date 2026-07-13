import {aggregateRows, rowMatchesCondition, type ChartAggregate, type DatabaseProperty, type DatabaseRow, type DatabaseView, type DataClient} from '@book.dev/sdk';
import {blockProp, type BlockJSON, type BlockMap} from '../model';
import {slugify, varNameFromLabel} from './options';

/**
 * The kit chart block's DATABASE data source (DASH-3), kept pure so both the live
 * React component (`charts.tsx`) and the static export path can share one
 * definition — the render/export never learns where the data came from, and no
 * derived data is ever written back to the CRDT doc.
 */

/** Aggregation types offered by a database-bound chart (mirrors the DB views). */
export const DB_AGG_TYPES: readonly ChartAggregate['type'][] = ['count', 'sum', 'avg', 'min', 'max'];
/** Property types a numeric measure (`sum`/`avg`/`min`/`max`) can fold. */
export const NUMERIC_PROP_TYPES = new Set(['number', 'formula', 'expr']);

/** A chart's database data source. `groupBy` is a property id or the parent
 *  sentinel; `aggProp` is the numeric property folded by non-`count` measures. */
export interface ChartDbBinding {
  dbId: string;
  groupBy: string;
  aggType: ChartAggregate['type'];
  aggProp?: string;
  /**
   * Cross-filter (DASH-7): the name of a kit input whose live value SCOPES this
   * chart. When set together with {@link filterProp}, the chart's rows are
   * filtered to those whose `filterProp` cell equals the input's value BEFORE
   * aggregating — so one control at the top of a dashboard re-scopes every chart
   * bound to it at once. Both absent → the chart aggregates the whole database
   * (the original, unfiltered path).
   */
  filterInput?: string;
  /** Cross-filter: the database property the bound input's value matches (equals). */
  filterProp?: string;
}

/** One series of a chart: values with an aligned label per point/slice. */
export interface ChartSeriesData {
  value: number[];
  labels: string[];
}

/** Export-time override: a chart block id → its resolved DB series. Threaded
 *  through the (sync) export projection so a DB chart exports live-resolved data
 *  without any persisted snapshot. */
export type DbChartSeriesMap = Map<string, ChartSeriesData>;

const asAggType = (v: unknown): ChartAggregate['type'] =>
  v === 'sum' || v === 'avg' || v === 'min' || v === 'max' ? v : 'count';

/** Build a binding from a property reader — null unless the chart is in database
 *  mode. Shared by the live component (`blockProp`) and export (`props[...]`). */
function bindingFrom(get: (key: string) => unknown): ChartDbBinding | null {
  if (get('sourceMode') !== 'database') return null;
  return {
    dbId: String(get('dbId') ?? ''),
    groupBy: String(get('dbGroupBy') ?? ''),
    aggType: asAggType(get('dbAggType')),
    aggProp: get('dbAggProp') ? String(get('dbAggProp')) : undefined,
    filterInput: get('dbFilterInput') ? String(get('dbFilterInput')) : undefined,
    filterProp: get('dbFilterProp') ? String(get('dbFilterProp')) : undefined,
  };
}

/** Read a live block's database binding (or null when it isn't in database mode). */
export const readDbBinding = (block: BlockMap): ChartDbBinding | null => bindingFrom((key) => blockProp(block, key));

/** Read a serialized block's database binding from its props bag. */
export const bindingFromProps = (props: Record<string, unknown> | undefined): ChartDbBinding | null =>
  bindingFrom((key) => props?.[key]);

/**
 * A cross-filter value that means "don't filter": no selection (null/undefined),
 * an empty box, an empty multi-select, or the explicit `all` sentinel (the
 * dashboard template's "All quarters" default). An inactive value passes every
 * row through, so a chart bound to an unset control aggregates the whole database.
 */
export function isInactiveFilterValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    return t === '' || t === 'all';
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Resolve an input value to the target a `DatabaseFilter` on `prop` compares
 * against with `equals`. A `select`/`status` cell stores the OPTION ID, but a
 * kit input publishes the option's label or its slug — so map label/slug/id →
 * the stored id (whichever the input happens to carry). Any other property type
 * compares the value verbatim (text/number cells already hold the literal).
 */
function filterTargetFor(prop: DatabaseProperty | undefined, value: unknown): unknown {
  if (prop && (prop.type === 'select' || prop.type === 'status') && prop.options) {
    const v = String(value).trim().toLowerCase();
    const opt = prop.options.find((o) => o.id.toLowerCase() === v || o.label.toLowerCase() === v || slugify(o.label) === v);
    if (opt) return opt.id;
  }
  return value;
}

/**
 * Scope a chart's rows to its cross-filter BEFORE aggregating: keep a row when
 * its `filterProp` cell equals the bound input's value (matching ANY of them for
 * a multi-select input). Reuses the SDK's per-row filter test
 * ({@link rowMatchesCondition}) — the very matcher the table/board views filter
 * with — so a cross-filter and a hand-added view filter agree. Returns the rows
 * unchanged when the chart has no `filterProp` or the value is inactive
 * ({@link isInactiveFilterValue}), keeping the unfiltered path a no-op.
 */
export function scopeRowsByFilter(rows: DatabaseRow[], properties: DatabaseProperty[], binding: ChartDbBinding, filterValue: unknown): DatabaseRow[] {
  if (!binding.filterProp || isInactiveFilterValue(filterValue)) return rows;
  const prop = properties.find((p) => p.id === binding.filterProp);
  const active = (Array.isArray(filterValue) ? filterValue : [filterValue]).filter((v) => !isInactiveFilterValue(v));
  if (active.length === 0) return rows;
  const targets = active.map((v) => filterTargetFor(prop, v));
  const propertyId = binding.filterProp;
  return rows.filter((row) => targets.some((t) => rowMatchesCondition(row, {propertyId, operator: 'equals', value: t}, properties)));
}

/**
 * Fold a database's rows into a single labelled series via the SDK
 * {@link aggregateRows} pipeline — one datum per group of `groupBy`, its height
 * the `aggType` measure (count, or sum/avg/min/max of `aggProp`). A minimal
 * view carrying only the fields `aggregateRows` reads drives it, so the kit
 * chart and the database bar/pie views share one aggregation. When the binding
 * carries a cross-filter and `filterValue` is active, the rows are scoped to it
 * first ({@link scopeRowsByFilter}) — so a dashboard control re-aggregates the
 * chart live. `filterValue` omitted (or inactive) keeps the whole-database path.
 */
export function aggregateDbSeries(rows: DatabaseRow[], properties: DatabaseProperty[], binding: ChartDbBinding, filterValue?: unknown): ChartSeriesData {
  const scoped = scopeRowsByFilter(rows, properties, binding, filterValue);
  const view = {
    groupByPropertyId: binding.groupBy || undefined,
    aggregate: {type: binding.aggType, propertyId: binding.aggProp},
  } as DatabaseView;
  const data = aggregateRows(scoped, view, properties);
  return {value: data.map((d) => d.value), labels: data.map((d) => d.label)};
}

/** A legal reactive identifier — mirrors scope.ts's `NAME_RE`. */
const INPUT_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The reactive name a SERIALIZED input block publishes under — its explicit
 *  `name`, else one derived from its display `label`. Mirrors scope.publishedName
 *  over a plain props bag (the export path has BlockJSON, not a live doc). */
function publishedNameOf(props: Record<string, unknown> | undefined): string {
  const explicit = String(props?.name ?? '').trim();
  if (explicit) return INPUT_NAME_RE.test(explicit) ? explicit : '';
  const derived = varNameFromLabel(String(props?.label ?? ''));
  return derived && INPUT_NAME_RE.test(derived) ? derived : '';
}

/**
 * The current value of the input named `name` in a serialized block tree: the
 * scalar `value` (dropdown/radio/text/number/toggle) or the `selected` array
 * (checklist/tag field). Lets the STATIC export resolve a chart's cross-filter to
 * the same value the live editor reads from {@link inputScope}, without rebuilding
 * a CRDT doc. Returns `undefined` when no such named input carries a value.
 */
export function namedInputValue(blocks: BlockJSON[], name: string): unknown {
  for (const b of blocks) {
    if (b.props && publishedNameOf(b.props) === name) {
      if ('value' in b.props && b.props.value != null) return b.props.value;
      if (Array.isArray(b.props.selected)) return b.props.selected;
    }
    if (b.children) {
      const found = namedInputValue(b.children, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Walk a block tree collecting every database-bound kit chart (id + binding). */
function collectDbCharts(blocks: BlockJSON[], out: Array<{id: string; binding: ChartDbBinding}> = []): Array<{id: string; binding: ChartDbBinding}> {
  for (const b of blocks) {
    if (b.type === 'kitchart') {
      const binding = bindingFromProps(b.props);
      if (binding && binding.dbId && binding.groupBy) out.push({id: b.id, binding});
    }
    if (b.children) collectDbCharts(b.children, out);
  }
  return out;
}

/**
 * Resolve every database-bound kit chart in a block tree to its `{value, labels}`
 * series AT EXPORT TIME, using a live {@link DataClient}. Fetches each referenced
 * database's rows + schema once and aggregates via {@link aggregateDbSeries}. This
 * replaces the old persist-to-doc snapshot: opening/presenting a chart writes
 * nothing; the export resolves fresh from the client that initiated it.
 */
export async function resolveDbChartSeries(client: DataClient, blocks: BlockJSON[]): Promise<DbChartSeriesMap> {
  const targets = collectDbCharts(blocks);
  const out: DbChartSeriesMap = new Map();
  if (targets.length === 0) return out;
  const dbIds = [...new Set(targets.map((t) => t.binding.dbId))];
  const byDb = new Map<string, {rows: DatabaseRow[]; properties: DatabaseProperty[]}>();
  await Promise.all(
    dbIds.map(async (dbId) => {
      const [db, rows] = await Promise.all([
        client.getDatabase(dbId).catch(() => null),
        client.listRows(dbId).catch(() => [] as DatabaseRow[]),
      ]);
      byDb.set(dbId, {rows, properties: db?.schema.properties ?? []});
    }),
  );
  for (const {id, binding} of targets) {
    const data = byDb.get(binding.dbId);
    if (!data) continue;
    // Resolve the chart's cross-filter to the current value of its bound input
    // (read from the same block tree), so the export reflects whatever the
    // control was set to — exactly as the live editor does. Unbound charts pass
    // `undefined` and aggregate the whole database.
    const filterValue = binding.filterInput && binding.filterProp ? namedInputValue(blocks, binding.filterInput) : undefined;
    out.set(id, aggregateDbSeries(data.rows, data.properties, binding, filterValue));
  }
  return out;
}

/** The block-doc blocks of a page snapshot, when it's a block-editor page. */
export function snapshotBlocks(snapshot: {editor?: string; blockdoc?: unknown} | null | undefined): BlockJSON[] {
  if (!snapshot || snapshot.editor !== 'blocks' || !snapshot.blockdoc) return [];
  return ((snapshot.blockdoc as {blocks?: BlockJSON[]}).blocks ?? []) as BlockJSON[];
}
