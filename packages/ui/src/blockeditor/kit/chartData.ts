import {aggregateRows, type ChartAggregate, type DatabaseProperty, type DatabaseRow, type DatabaseView, type DataClient} from '@book.dev/sdk';
import {blockProp, type BlockJSON, type BlockMap} from '../model';

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
  };
}

/** Read a live block's database binding (or null when it isn't in database mode). */
export const readDbBinding = (block: BlockMap): ChartDbBinding | null => bindingFrom((key) => blockProp(block, key));

/** Read a serialized block's database binding from its props bag. */
export const bindingFromProps = (props: Record<string, unknown> | undefined): ChartDbBinding | null =>
  bindingFrom((key) => props?.[key]);

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
    if (data) out.set(id, aggregateDbSeries(data.rows, data.properties, binding));
  }
  return out;
}

/** The block-doc blocks of a page snapshot, when it's a block-editor page. */
export function snapshotBlocks(snapshot: {editor?: string; blockdoc?: unknown} | null | undefined): BlockJSON[] {
  if (!snapshot || snapshot.editor !== 'blocks' || !snapshot.blockdoc) return [];
  return ((snapshot.blockdoc as {blocks?: BlockJSON[]}).blocks ?? []) as BlockJSON[];
}
