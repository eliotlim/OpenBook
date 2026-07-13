import {describe, it, expect} from 'vitest';
import {PARENT_GROUP_ID, type DatabaseProperty, type DatabaseRow} from '@book.dev/sdk';
import {createDoc, docToJSON, rootBlocks} from '../../model';
import {projectBlocksForExport} from '../../exportBlocks';
import {computeExportCells} from '../scope';
import {aggregateDbSeries, readDbBinding} from '../charts';

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

describe('export of a database-bound chart', () => {
  const dbChartDoc = () =>
    createDoc([
      {
        id: 'k1',
        type: 'kitchart',
        props: {kind: 'bar', title: 'By status', sourceMode: 'database', dbId: 'db1', dbGroupBy: 'p_status', dbAggType: 'count', dbSnapshot: {value: [2, 1], labels: ['Todo', 'Done']}},
      },
    ]);

  it('seeds the computed cell from the snapshot (a static export has no data client)', () => {
    const cells = computeExportCells(dbChartDoc());
    expect(cells.get('k1')?.value).toEqual([2, 1]);
  });

  it('bakes the snapshot in as a constant literal and takes labels from the groups', () => {
    const computed = computeExportCells(dbChartDoc());
    const out = projectBlocksForExport(docToJSON(dbChartDoc()), computed);
    const expr = out.blocks.find((b) => b.type === 'expr');
    // A DB chart has no reactive expression — its series is a constant so the
    // export's live runtime recomputes to the same last-known data.
    expect((expr?.data as {source: string}).source).toBe('[2,1]');
    const plot = out.blocks.find((b) => b.type === 'chart');
    expect(plot).toMatchObject({id: 'k1-plot', data: {refCellIds: ['k1'], kind: 'bar', labels: 'Todo, Done'}});
    expect(out.values).toEqual(expect.arrayContaining([['k1', [2, 1]]]));
  });

  it('leaves an expression chart export unchanged (tokenized over inputs)', () => {
    const d = createDoc([
      {id: 'n1', type: 'number', props: {name: 'n', value: 3}},
      {id: 'k2', type: 'kitchart', props: {kind: 'line', title: 'p', source: '[n, n*2]'}},
    ]);
    const out = projectBlocksForExport(docToJSON(d), computeExportCells(d));
    const expr = out.blocks.find((b) => b.type === 'expr' && (b.data as {name: string}).name === 'p');
    expect((expr?.data as {source: string}).source).toBe('[__C__{n1}__, __C__{n1}__*2]');
  });
});
