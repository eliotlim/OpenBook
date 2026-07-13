import {describe, it, expect} from 'vitest';
import {PARENT_GROUP_ID, type DataClient, type DatabaseProperty, type DatabaseRow, type StoredDatabase} from '@book.dev/sdk';
import {blockProp, createDoc, docToJSON, encodeSnapshot, rootBlocks} from '../../model';
import {projectSnapshotForExport} from '../../exportBlocks';
import {computeExportCells} from '../scope';
import {aggregateDbSeries, readDbBinding} from '../charts';
import {isInactiveFilterValue, namedInputValue, resolveDbChartSeries, scopeRowsByFilter, type DbChartSeriesMap} from '../chartData';

const row = (id: string, over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  id,
  name: id,
  properties: {},
  exports: {},
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const status: DatabaseProperty = {
  id: 'p_status',
  name: 'Status',
  type: 'select',
  options: [
    {id: 'opt_todo', label: 'Todo', color: 'gray'},
    {id: 'opt_done', label: 'Done', color: 'green'},
  ],
};
const cost: DatabaseProperty = {id: 'p_cost', name: 'Cost', type: 'number'};

/** Label→value map, so assertions don't depend on group order. */
const asMap = (value: number[], labels: string[]): Record<string, number> =>
  Object.fromEntries(labels.map((l, i) => [l, value[i]]));

describe('aggregateDbSeries (database data source → {value, labels})', () => {
  const rows = [
    row('r1', {properties: {p_status: 'opt_todo', p_cost: 10}}),
    row('r2', {properties: {p_status: 'opt_done', p_cost: 5}}),
    row('r3', {properties: {p_status: 'opt_todo', p_cost: 3}}),
  ];

  it('counts rows per group with aligned labels', () => {
    const {value, labels} = aggregateDbSeries(rows, [status, cost], {dbId: 'db', groupBy: 'p_status', aggType: 'count'});
    expect(asMap(value, labels)).toEqual({Todo: 2, Done: 1});
  });

  it('sums a numeric measure per group', () => {
    const {value, labels} = aggregateDbSeries(rows, [status, cost], {dbId: 'db', groupBy: 'p_status', aggType: 'sum', aggProp: 'p_cost'});
    expect(asMap(value, labels)).toEqual({Todo: 13, Done: 5});
  });

  it('averages a numeric measure per group', () => {
    const {value, labels} = aggregateDbSeries(rows, [status, cost], {dbId: 'db', groupBy: 'p_status', aggType: 'avg', aggProp: 'p_cost'});
    expect(asMap(value, labels)).toEqual({Todo: 6.5, Done: 5});
  });

  it('supports the parent-item grouping sentinel', () => {
    const tree = [row('epic'), row('t1', {parentId: 'epic'}), row('t2', {parentId: 'epic'})];
    const {value, labels} = aggregateDbSeries(tree, [], {dbId: 'db', groupBy: PARENT_GROUP_ID, aggType: 'count'});
    expect(labels).toEqual(['epic']);
    expect(value).toEqual([2]);
  });
});

describe('cross-filter (DASH-7): scope rows by a bound input before aggregating', () => {
  const region: DatabaseProperty = {
    id: 'p_region',
    name: 'Region',
    type: 'select',
    options: [
      {id: 'opt_n', label: 'North', color: 'blue'},
      {id: 'opt_s', label: 'South', color: 'green'},
    ],
  };
  const props = [status, cost, region];
  const rows = [
    row('r1', {properties: {p_status: 'opt_todo', p_cost: 10, p_region: 'opt_n'}}),
    row('r2', {properties: {p_status: 'opt_done', p_cost: 5, p_region: 'opt_s'}}),
    row('r3', {properties: {p_status: 'opt_todo', p_cost: 3, p_region: 'opt_n'}}),
  ];
  const bound = {dbId: 'db', groupBy: 'p_status', aggType: 'count' as const, filterInput: 'region', filterProp: 'p_region'};

  it('keeps only rows matching the value (grouping the scoped subset)', () => {
    const {value, labels} = aggregateDbSeries(rows, props, bound, 'opt_n');
    // North has two Todo rows and no Done; the Done group survives (a select
    // enumerates all its options) but at zero — the chart shows every column.
    expect(asMap(value, labels)).toEqual({Todo: 2, Done: 0});
  });

  it('resolves a select value by option id, label, OR slug (input publishes any)', () => {
    for (const v of ['opt_n', 'North', 'north']) {
      const scoped = scopeRowsByFilter(rows, props, bound, v);
      expect(scoped.map((r) => r.id)).toEqual(['r1', 'r3']);
    }
  });

  it('treats an inactive value (undefined / empty / "all") as no filter', () => {
    for (const v of [undefined, '', '  ', 'all', 'ALL', [] as string[]]) {
      expect(isInactiveFilterValue(v)).toBe(true);
      const {value, labels} = aggregateDbSeries(rows, props, bound, v);
      expect(asMap(value, labels)).toEqual({Todo: 2, Done: 1}); // whole database
    }
  });

  it('matches ANY value from a multi-select input (array = OR)', () => {
    const scoped = scopeRowsByFilter(rows, props, bound, ['North', 'South']);
    expect(scoped.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('is a no-op when the binding carries no filterProp (unfiltered charts unchanged)', () => {
    const {value, labels} = aggregateDbSeries(rows, props, {dbId: 'db', groupBy: 'p_status', aggType: 'count'}, 'opt_n');
    expect(asMap(value, labels)).toEqual({Todo: 2, Done: 1});
  });
});

describe('namedInputValue — read a serialized input value for the export path', () => {
  it('reads a scalar input value by its published name (explicit or label-derived)', () => {
    const blocks = [
      {id: 'a', type: 'dropdown', props: {name: 'quarter', value: 'q2'}},
      {id: 'b', type: 'radio', props: {label: 'Sales Region', value: 'north'}},
    ];
    expect(namedInputValue(blocks, 'quarter')).toBe('q2');
    expect(namedInputValue(blocks, 'salesRegion')).toBe('north'); // varNameFromLabel
  });

  it('reads a multi-select array and finds inputs nested in containers', () => {
    const blocks = [{id: 'col', type: 'column', children: [{id: 't', type: 'tagfield', props: {name: 'tags', selected: ['a', 'b']}}]}];
    expect(namedInputValue(blocks, 'tags')).toEqual(['a', 'b']);
    expect(namedInputValue(blocks, 'missing')).toBeUndefined();
  });
});

describe('readDbBinding — expression back-compat', () => {
  it('returns null for an expression chart (no sourceMode) — the original path is untouched', () => {
    const doc = createDoc([{id: 'c', type: 'kitchart', props: {kind: 'bar', source: '[1, 2, 3]'}}]);
    expect(readDbBinding(rootBlocks(doc).get(0))).toBeNull();
  });

  it('reads the full binding when sourceMode is database', () => {
    const doc = createDoc([
      {id: 'c', type: 'kitchart', props: {kind: 'bar', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'sum', dbAggProp: 'p_cost'}},
    ]);
    expect(readDbBinding(rootBlocks(doc).get(0))).toEqual({dbId: 'db1', groupBy: 'p_status', aggType: 'sum', aggProp: 'p_cost'});
  });

  it('defaults the measure to count and leaves aggProp undefined when unset', () => {
    const doc = createDoc([{id: 'c', type: 'kitchart', props: {sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status'}}]);
    expect(readDbBinding(rootBlocks(doc).get(0))).toEqual({dbId: 'db1', groupBy: 'p_status', aggType: 'count', aggProp: undefined});
  });
});

describe('export of a database-bound chart (export-time resolution, no persisted snapshot)', () => {
  const dbChartDoc = () =>
    createDoc([
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', title: 'By status', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'count'}},
    ]);
  // The series the in-app client resolves at export time — threaded in, never
  // read from the doc (the block stores no dbSnapshot).
  const dbSeries = (): DbChartSeriesMap => new Map([['k1', {value: [2, 1], labels: ['Todo', 'Done']}]]);

  it('seeds the computed cell from the threaded series (not from the doc)', () => {
    const cells = computeExportCells(dbChartDoc(), dbSeries());
    expect(cells.get('k1')?.value).toEqual([2, 1]);
  });

  it('bakes the resolved series in as a constant literal and takes labels from the groups', () => {
    const snapshot = {editorjs: {blocks: []}, values: [] as unknown[], names: [] as unknown[], editor: 'blocks' as const, blockdoc: encodeSnapshot(dbChartDoc())};
    const projected = projectSnapshotForExport(snapshot, dbSeries());
    const blocks = (projected.editorjs as {blocks: Array<{type: string; data: Record<string, unknown>}>}).blocks;
    // A DB chart has no reactive expression — its series is baked as a constant so
    // the export's live runtime recomputes to the same data.
    expect((blocks.find((b) => b.type === 'expr')?.data as {source: string}).source).toBe('[2,1]');
    expect(blocks.find((b) => b.type === 'chart')).toMatchObject({id: 'k1-plot', data: {refCellIds: ['k1'], kind: 'bar', labels: 'Todo, Done'}});
    expect(projected.values).toEqual(expect.arrayContaining([['k1', [2, 1]]]));
  });

  it('persists NO derived snapshot on the block (viewing/exporting writes nothing to the doc)', () => {
    const doc = dbChartDoc();
    projectSnapshotForExport({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks' as const, blockdoc: encodeSnapshot(doc)}, dbSeries());
    // The only DB props are the binding; there is no dbSnapshot field anywhere.
    expect(blockProp(rootBlocks(doc).get(0), 'dbSnapshot')).toBeUndefined();
  });

  it('a DB chart with no resolved series exports an empty (not broken) chart', () => {
    const snapshot = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks' as const, blockdoc: encodeSnapshot(dbChartDoc())};
    const projected = projectSnapshotForExport(snapshot); // no dbSeries threaded
    const blocks = (projected.editorjs as {blocks: Array<{type: string; data: Record<string, unknown>}>}).blocks;
    expect((blocks.find((b) => b.type === 'expr')?.data as {source: string}).source).toBe('[]');
  });

  it('leaves an expression chart export unchanged (tokenized over inputs)', () => {
    const d = createDoc([
      {id: 'n1', type: 'number', props: {name: 'n', value: 3}},
      {id: 'k2', type: 'kitchart', props: {kind: 'line', title: 'p', source: '[n, n*2]'}},
    ]);
    const snapshot = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks' as const, blockdoc: encodeSnapshot(d)};
    const projected = projectSnapshotForExport(snapshot);
    const blocks = (projected.editorjs as {blocks: Array<{type: string; data: Record<string, unknown>}>}).blocks;
    const expr = blocks.find((b) => b.type === 'expr' && (b.data as {name: string}).name === 'p');
    expect((expr?.data as {source: string}).source).toBe('[__C__{n1}__, __C__{n1}__*2]');
  });
});

describe('resolveDbChartSeries (export-time live resolution)', () => {
  const status: DatabaseProperty = {
    id: 'p_status',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'opt_todo', label: 'Todo', color: 'gray'},
      {id: 'opt_done', label: 'Done', color: 'green'},
    ],
  };
  const cost: DatabaseProperty = {id: 'p_cost', name: 'Cost', type: 'number'};
  const rows: DatabaseRow[] = [
    row('r1', {properties: {p_status: 'opt_todo', p_cost: 10}}),
    row('r2', {properties: {p_status: 'opt_done', p_cost: 5}}),
    row('r3', {properties: {p_status: 'opt_todo', p_cost: 3}}),
  ];
  const fakeClient = (): DataClient =>
    ({
      getDatabase: async (id: string): Promise<StoredDatabase> => ({
        id,
        pageId: 'host',
        name: 'Tasks',
        schema: {properties: [status, cost], views: []},
        createdAt: '',
        updatedAt: '',
      }),
      listRows: async (): Promise<DatabaseRow[]> => rows,
    }) as unknown as DataClient;

  it('resolves each DB-bound chart via listRows + aggregate, keyed by block id', async () => {
    const doc = createDoc([
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'sum', dbAggProp: 'p_cost'}},
      {id: 'k2', type: 'kitchart', props: {kind: 'line', source: '[1,2,3]'}}, // expression chart — ignored
    ]);
    const map = await resolveDbChartSeries(fakeClient(), docToJSON(doc));
    expect(map.has('k2')).toBe(false);
    const k1 = map.get('k1')!;
    expect(asMap(k1.value, k1.labels)).toEqual({Todo: 13, Done: 5});
  });

  it('skips charts that are not fully configured', async () => {
    const doc = createDoc([{id: 'k1', type: 'kitchart', props: {sourceMode: 'database', dbId: 'db1'}}]); // no groupBy
    const map = await resolveDbChartSeries(fakeClient(), docToJSON(doc));
    expect(map.size).toBe(0);
  });

  it('scopes a bound chart to its cross-filter input value (export reflects the control)', async () => {
    // A Status control publishes `opt_done`; the chart is bound to it on the
    // Status property, so the export resolves the FILTERED series, not the whole
    // database — the same value the live editor would show.
    const doc = createDoc([
      {id: 'i', type: 'dropdown', props: {name: 'stage', value: 'opt_done'}},
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'count', dbFilterInput: 'stage', dbFilterProp: 'p_status'}},
    ]);
    const map = await resolveDbChartSeries(fakeClient(), docToJSON(doc));
    const k1 = map.get('k1')!;
    expect(asMap(k1.value, k1.labels)).toEqual({Todo: 0, Done: 1}); // only the Done row survives
  });

  it('an inactive control (no selection) exports the whole database', async () => {
    const doc = createDoc([
      {id: 'i', type: 'dropdown', props: {name: 'stage', value: 'all'}},
      {id: 'k1', type: 'kitchart', props: {kind: 'bar', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'count', dbFilterInput: 'stage', dbFilterProp: 'p_status'}},
    ]);
    const map = await resolveDbChartSeries(fakeClient(), docToJSON(doc));
    const k1 = map.get('k1')!;
    expect(asMap(k1.value, k1.labels)).toEqual({Todo: 2, Done: 1});
  });
});
