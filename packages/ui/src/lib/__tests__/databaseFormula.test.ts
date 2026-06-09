import {describe, it, expect} from 'vitest';
import {
  aggregateRows,
  applyView,
  dateEnd,
  dateStart,
  evaluateFormula,
  formatNumber,
  FormulaError,
  groupRows,
  rowDateSpan,
  rowValue,
  summarizeColumn,
  NO_VALUE_GROUP,
  TITLE_PROPERTY_ID,
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

describe('summarizeColumn', () => {
  const cost: DatabaseProperty = {id: 'c', name: 'Cost', type: 'number'};
  const rows = [
    row({id: 'a', name: 'A', properties: {c: 10}}),
    row({id: 'b', name: 'B', properties: {c: 30}}),
    row({id: 'd', name: '', properties: {}}), // empty cost + empty title
  ];
  const props = [cost];

  it('counts all / filled / empty / unique', () => {
    expect(summarizeColumn(rows, cost, 'count_all', props)).toBe('3');
    expect(summarizeColumn(rows, cost, 'count_filled', props)).toBe('2');
    expect(summarizeColumn(rows, cost, 'count_empty', props)).toBe('1');
    expect(summarizeColumn(rows, cost, 'count_unique', props)).toBe('2');
  });
  it('percentages', () => {
    expect(summarizeColumn(rows, cost, 'percent_filled', props)).toBe('67%');
    expect(summarizeColumn(rows, cost, 'percent_empty', props)).toBe('33%');
  });
  it('numeric folds ignore empties', () => {
    expect(summarizeColumn(rows, cost, 'sum', props)).toBe('40');
    expect(summarizeColumn(rows, cost, 'avg', props)).toBe('20');
    expect(summarizeColumn(rows, cost, 'min', props)).toBe('10');
    expect(summarizeColumn(rows, cost, 'max', props)).toBe('30');
    expect(summarizeColumn(rows, cost, 'range', props)).toBe('20');
    expect(summarizeColumn(rows, cost, 'median', props)).toBe('20');
  });
  it('summarises the title column and returns empty for none', () => {
    expect(summarizeColumn(rows, TITLE_PROPERTY_ID, 'count_filled', props)).toBe('2');
    expect(summarizeColumn(rows, cost, 'none', props)).toBe('');
  });
});

describe('dates & timeline spans', () => {
  const start: DatabaseProperty = {id: 's', name: 'Start', type: 'date'};
  const end: DatabaseProperty = {id: 'e', name: 'End', type: 'date'};
  const span: DatabaseProperty = {id: 'sp', name: 'When', type: 'date', dateRange: true};

  it('dateStart/dateEnd read plain strings and ranges', () => {
    expect(dateStart('2026-03-01')).toBe('2026-03-01');
    expect(dateEnd('2026-03-01')).toBe(null);
    expect(dateStart({start: '2026-03-01', end: '2026-03-05'})).toBe('2026-03-01');
    expect(dateEnd({start: '2026-03-01', end: '2026-03-05'})).toBe('2026-03-05');
    expect(dateStart('')).toBe(null);
  });

  it('rowValue compares a date on its start', () => {
    const r = row({properties: {s: {start: '2026-03-01', end: '2026-03-09'}}});
    expect(rowValue(r, start, [start])).toBe('2026-03-01');
  });

  it('rowDateSpan from a start + end property', () => {
    const view: DatabaseView = {id: 'v', name: 'V', type: 'timeline', filters: [], sorts: [], datePropertyId: 's', endDatePropertyId: 'e'};
    const r = row({properties: {s: '2026-03-01', e: '2026-03-10'}});
    const sp = rowDateSpan(r, view, [start, end])!;
    expect(sp.start.getFullYear()).toBe(2026);
    expect(sp.end.getDate()).toBe(10);
  });

  it('rowDateSpan from a single range property', () => {
    const view: DatabaseView = {id: 'v', name: 'V', type: 'timeline', filters: [], sorts: [], datePropertyId: 'sp'};
    const r = row({properties: {sp: {start: '2026-03-02', end: '2026-03-04'}}});
    const sp = rowDateSpan(r, view, [span])!;
    expect(sp.start.getDate()).toBe(2);
    expect(sp.end.getDate()).toBe(4);
  });

  it('rowDateSpan is null without a start, single-day when end is missing/earlier', () => {
    const view: DatabaseView = {id: 'v', name: 'V', type: 'timeline', filters: [], sorts: [], datePropertyId: 's', endDatePropertyId: 'e'};
    expect(rowDateSpan(row({properties: {}}), view, [start, end])).toBe(null);
    const sameDay = rowDateSpan(row({properties: {s: '2026-03-05', e: '2026-03-01'}}), view, [start, end])!;
    expect(sameDay.start.getTime()).toBe(sameDay.end.getTime());
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
