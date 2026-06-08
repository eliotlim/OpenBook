import {describe, it, expect} from 'vitest';
import {
  aggregateRows,
  applyView,
  evaluateFormula,
  formatNumber,
  FormulaError,
  groupRows,
  rowValue,
  NO_VALUE_GROUP,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView,
} from '@open-book/sdk';

const row = (over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  id: 'r1',
  name: 'Row',
  properties: {},
  exports: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
  ...over,
});

describe('evaluateFormula', () => {
  const resolve = (scope: Record<string, unknown>) => (name: string) => scope[name];
  it('does arithmetic and precedence', () => {
    expect(evaluateFormula('1 + 2 * 3', resolve({}))).toBe(7);
    expect(evaluateFormula('Price * Qty', resolve({Price: 4, Qty: 3}))).toBe(12);
  });
  it('returns a FormulaError (never throws) for bad input', () => {
    expect(evaluateFormula('1 / 0', resolve({}))).toBeInstanceOf(FormulaError);
    expect(evaluateFormula('nope(', resolve({}))).toBeInstanceOf(FormulaError);
  });
});

describe('rowValue for formula properties', () => {
  const price: DatabaseProperty = {id: 'p1', name: 'Price', type: 'number'};
  const qty: DatabaseProperty = {id: 'p2', name: 'Qty', type: 'number'};
  const total: DatabaseProperty = {id: 'p3', name: 'Total', type: 'formula', formula: 'Price * Qty'};
  const props = [price, qty, total];

  it('computes from sibling properties by name', () => {
    const r = row({properties: {p1: 5, p2: 4}});
    expect(rowValue(r, total, props)).toBe(20);
  });
  it('reads select option labels by name', () => {
    const status: DatabaseProperty = {
      id: 's',
      name: 'Status',
      type: 'select',
      options: [{id: 'o1', label: 'Done', color: 'green'}],
    };
    const label: DatabaseProperty = {id: 'f', name: 'Label', type: 'formula', formula: 'concat("[", Status, "]")'};
    const r = row({properties: {s: 'o1'}});
    expect(rowValue(r, label, [status, label])).toBe('[Done]');
  });
  it('guards against circular formulas', () => {
    const a: DatabaseProperty = {id: 'a', name: 'A', type: 'formula', formula: 'B + 1'};
    const b: DatabaseProperty = {id: 'b', name: 'B', type: 'formula', formula: 'A + 1'};
    expect(rowValue(row(), a, [a, b])).toBeInstanceOf(FormulaError);
  });
  it('returns undefined without the schema', () => {
    expect(rowValue(row({properties: {p1: 5, p2: 4}}), total)).toBeUndefined();
  });
});

describe('applyView filters/sorts on formula columns', () => {
  const price: DatabaseProperty = {id: 'p1', name: 'Price', type: 'number'};
  const qty: DatabaseProperty = {id: 'p2', name: 'Qty', type: 'number'};
  const total: DatabaseProperty = {id: 'p3', name: 'Total', type: 'formula', formula: 'Price * Qty'};
  const props = [price, qty, total];

  it('sorts by the computed value', () => {
    const rows = [
      row({id: 'a', properties: {p1: 2, p2: 2}}), // 4
      row({id: 'b', properties: {p1: 5, p2: 2}}), // 10
      row({id: 'c', properties: {p1: 1, p2: 1}}), // 1
    ];
    const view: DatabaseView = {id: 'v', name: 'V', type: 'table', filters: [], sorts: [{propertyId: 'p3', direction: 'asc'}]};
    expect(applyView(rows, view, props).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });
  it('filters by the computed value', () => {
    const rows = [row({id: 'a', properties: {p1: 2, p2: 2}}), row({id: 'b', properties: {p1: 5, p2: 2}})];
    const view: DatabaseView = {
      id: 'v',
      name: 'V',
      type: 'table',
      filters: [{id: 'f', propertyId: 'p3', operator: 'gt', value: 5}],
      sorts: [],
    };
    expect(applyView(rows, view, props).map((r) => r.id)).toEqual(['b']);
  });
});

describe('groupRows', () => {
  const status: DatabaseProperty = {
    id: 's',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'todo', label: 'Todo', color: 'gray'},
      {id: 'done', label: 'Done', color: 'green'},
    ],
  };
  it('groups by select option order, with a trailing empty column', () => {
    const rows = [
      row({id: 'a', properties: {s: 'done'}}),
      row({id: 'b', properties: {s: 'todo'}}),
      row({id: 'c', properties: {}}),
    ];
    const groups = groupRows(rows, status, [status]);
    expect(groups.map((g) => g.label)).toEqual(['Todo', 'Done', NO_VALUE_GROUP]);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['a']);
    expect(groups[2].rows.map((r) => r.id)).toEqual(['c']);
  });
});

describe('aggregateRows', () => {
  const status: DatabaseProperty = {
    id: 's',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'todo', label: 'Todo'},
      {id: 'done', label: 'Done'},
    ],
  };
  const cost: DatabaseProperty = {id: 'c', name: 'Cost', type: 'number'};
  it('counts rows per group by default', () => {
    const rows = [
      row({properties: {s: 'todo', c: 10}}),
      row({properties: {s: 'todo', c: 5}}),
      row({properties: {s: 'done', c: 20}}),
    ];
    const view: DatabaseView = {id: 'v', name: 'V', type: 'bar', filters: [], sorts: [], groupByPropertyId: 's'};
    expect(aggregateRows(rows, view, [status, cost]).map((d) => [d.label, d.value])).toEqual([
      ['Todo', 2],
      ['Done', 1],
    ]);
  });
  it('sums a numeric property when configured', () => {
    const rows = [
      row({properties: {s: 'todo', c: 10}}),
      row({properties: {s: 'todo', c: 5}}),
      row({properties: {s: 'done', c: 20}}),
    ];
    const view: DatabaseView = {
      id: 'v',
      name: 'V',
      type: 'bar',
      filters: [],
      sorts: [],
      groupByPropertyId: 's',
      aggregate: {type: 'sum', propertyId: 'c'},
    };
    expect(aggregateRows(rows, view, [status, cost]).map((d) => [d.label, d.value])).toEqual([
      ['Todo', 15],
      ['Done', 20],
    ]);
  });
});

describe('formatNumber', () => {
  it('formats per the chosen style', () => {
    expect(formatNumber(1234, 'integer')).toBe((1234).toLocaleString());
    expect(formatNumber(0.25, 'percent')).toBe('25%');
    expect(formatNumber(9.5, 'dollar')).toBe(`$${(9.5).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    expect(formatNumber('', 'integer')).toBe('');
  });
});
