import {describe, it, expect} from 'vitest';
import {parseCsv, rowsToCsv} from '@/components/database/databaseCells';
import {
  aggregateMatrix,
  aggregateRows,
  applyView,
  buildRowTree,
  dateEnd,
  dateStart,
  dependencyGraph,
  firstImageUrl,
  coverImageUrl,
  flattenRowTree,
  isImageUrl,
  evaluateFormula,
  formatNumber,
  formatUniqueId,
  FormulaError,
  groupRows,
  matchesFilter,
  rowMatchesCondition,
  numberProgress,
  parseDay,
  removeProperty,
  rowDateSpan,
  rowValue,
  summarizeColumn,
  syncInverseUpdates,
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
  parentId: null,
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

describe('aggregateMatrix', () => {
  const status: DatabaseProperty = {
    id: 's',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'todo', label: 'Todo'},
      {id: 'done', label: 'Done'},
    ],
  };
  const team: DatabaseProperty = {
    id: 't',
    name: 'Team',
    type: 'select',
    options: [
      {id: 'eng', label: 'Eng'},
      {id: 'design', label: 'Design'},
    ],
  };
  const cost: DatabaseProperty = {id: 'c', name: 'Cost', type: 'number'};
  const props = [status, team, cost];
  const rows = [
    row({id: 'a', properties: {s: 'todo', t: 'eng', c: 10}}),
    row({id: 'b', properties: {s: 'todo', t: 'design', c: 5}}),
    row({id: 'c', properties: {s: 'done', t: 'eng', c: 20}}),
  ];

  it('returns a single synthetic series with no breakdown', () => {
    const view: DatabaseView = {id: 'v', name: 'V', type: 'bar', filters: [], sorts: [], groupByPropertyId: 's'};
    const {groups, series} = aggregateMatrix(rows, view, props);
    expect(series.map((s) => s.key)).toEqual(['__total__']);
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['Todo', 2],
      ['Done', 1],
    ]);
    // The single segment carries every row behind the bar (for drill-down).
    expect(groups[0].segments[0].rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('splits each group into shared, zero-filled breakdown segments', () => {
    const view: DatabaseView = {
      id: 'v',
      name: 'V',
      type: 'bar',
      filters: [],
      sorts: [],
      groupByPropertyId: 's',
      breakdownPropertyId: 't',
    };
    const {groups, series} = aggregateMatrix(rows, view, props);
    expect(series.map((s) => s.label)).toEqual(['Eng', 'Design']);
    // Every group exposes the same ordered series, zero-filled where empty.
    expect(groups.map((g) => g.segments.map((seg) => seg.value))).toEqual([
      [1, 1], // Todo: 1 Eng, 1 Design
      [1, 0], // Done: 1 Eng, 0 Design
    ]);
    // Segment rows back the drill-down for one (group, series) cell.
    const todoEng = groups[0].segments[0];
    expect(todoEng.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('folds a numeric measure within each breakdown segment', () => {
    const view: DatabaseView = {
      id: 'v',
      name: 'V',
      type: 'bar',
      filters: [],
      sorts: [],
      groupByPropertyId: 's',
      breakdownPropertyId: 't',
      aggregate: {type: 'sum', propertyId: 'c'},
    };
    const {groups} = aggregateMatrix(rows, view, props);
    expect(groups.map((g) => [g.label, g.total, g.segments.map((s) => s.value)])).toEqual([
      ['Todo', 15, [10, 5]],
      ['Done', 20, [20, 0]],
    ]);
  });

  it('ignores a breakdown equal to the group property', () => {
    const view: DatabaseView = {
      id: 'v',
      name: 'V',
      type: 'bar',
      filters: [],
      sorts: [],
      groupByPropertyId: 's',
      breakdownPropertyId: 's',
    };
    expect(aggregateMatrix(rows, view, props).series.map((s) => s.key)).toEqual(['__total__']);
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

  it('parseDay extracts the local day from a date or datetime string', () => {
    const plain = parseDay('2026-06-09');
    expect([plain?.getFullYear(), plain?.getMonth(), plain?.getDate()]).toEqual([2026, 5, 9]);
    // A datetime value (include-time) still resolves to the same calendar day.
    const withTime = parseDay('2026-06-09T14:30');
    expect([withTime?.getFullYear(), withTime?.getMonth(), withTime?.getDate()]).toEqual([2026, 5, 9]);
    expect(parseDay('')).toBeNull();
  });

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

describe('dependencyGraph', () => {
  const r = (id: string, deps: string[] = []) => row({id, name: id, properties: {d: deps}});

  it('layers a chain by longest path', () => {
    // a → b → c (c depends on b, b depends on a)
    const g = dependencyGraph([r('a'), r('b', ['a']), r('c', ['b'])], 'd');
    const layer = (id: string) => g.nodes.find((n) => n.id === id)!.layer;
    expect(layer('a')).toBe(0);
    expect(layer('b')).toBe(1);
    expect(layer('c')).toBe(2);
    expect(g.layerCount).toBe(3);
    expect(g.edges).toEqual([
      {from: 'a', to: 'b'},
      {from: 'b', to: 'c'},
    ]);
  });

  it('uses the longest path when a node has multiple predecessors', () => {
    // d depends on a (layer 0) and c (layer 2) → d is layer 3
    const g = dependencyGraph([r('a'), r('b', ['a']), r('c', ['b']), r('d', ['a', 'c'])], 'd');
    expect(g.nodes.find((n) => n.id === 'd')!.layer).toBe(3);
  });

  it('orders nodes within a layer and counts max width', () => {
    const g = dependencyGraph([r('a'), r('b'), r('c', ['a'])], 'd');
    expect(g.maxLayerSize).toBe(2); // a and b both at layer 0
  });

  it('is cycle-safe and ignores invalid / self references', () => {
    const g = dependencyGraph([r('a', ['b', 'a', 'ghost']), r('b', ['a'])], 'd');
    expect(g.nodes.length).toBe(2); // does not hang
    expect(g.edges.some((e) => e.from === 'ghost')).toBe(false);
    expect(g.edges.some((e) => e.from === 'a' && e.to === 'a')).toBe(false);
  });

  it('puts everything at layer 0 with no dependency property', () => {
    const g = dependencyGraph([r('a'), r('b')], undefined);
    expect(g.layerCount).toBe(1);
    expect(g.edges).toEqual([]);
  });
});

describe('filter operators (extended)', () => {
  it('starts_with / ends_with', () => {
    expect(matchesFilter('starts_with', 'Hello world', 'he')).toBe(true);
    expect(matchesFilter('ends_with', 'Hello world', 'RLD')).toBe(true);
    expect(matchesFilter('starts_with', 'Hello', 'lo')).toBe(false);
  });
  it('date before / after / on-or-before / on-or-after', () => {
    expect(matchesFilter('before', '2026-03-01', '2026-03-05')).toBe(true);
    expect(matchesFilter('after', '2026-03-01', '2026-03-05')).toBe(false);
    expect(matchesFilter('on_or_after', '2026-03-05', '2026-03-05')).toBe(true);
    expect(matchesFilter('on_or_before', '2026-03-06', '2026-03-05')).toBe(false);
  });
  it('relative date operators anchor on a supplied "now"', () => {
    const now = new Date(2026, 2, 11); // Wed 2026-03-11 (week: Sun 03-08 … Sat 03-14)
    expect(matchesFilter('is_today', '2026-03-11', undefined, now)).toBe(true);
    expect(matchesFilter('is_today', '2026-03-12', undefined, now)).toBe(false);
    expect(matchesFilter('is_this_week', '2026-03-08', undefined, now)).toBe(true);
    expect(matchesFilter('is_this_week', '2026-03-14', undefined, now)).toBe(true);
    expect(matchesFilter('is_this_week', '2026-03-15', undefined, now)).toBe(false);
    expect(matchesFilter('is_past_week', '2026-03-05', undefined, now)).toBe(true);
    expect(matchesFilter('is_past_week', '2026-03-12', undefined, now)).toBe(false);
    expect(matchesFilter('is_next_week', '2026-03-14', undefined, now)).toBe(true);
    expect(matchesFilter('is_next_week', '2026-03-11', undefined, now)).toBe(false);
    expect(matchesFilter('is_this_month', '2026-03-31', undefined, now)).toBe(true);
    expect(matchesFilter('is_this_month', '2026-04-01', undefined, now)).toBe(false);
    expect(matchesFilter('is_today', '', undefined, now)).toBe(false); // no date
  });
});

describe('applyView filter tree (and / or groups)', () => {
  const sel: DatabaseProperty = {
    id: 's',
    name: 'S',
    type: 'select',
    options: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}],
  };
  const rows = [
    row({id: '1', name: 'one', properties: {s: 'a'}}),
    row({id: '2', name: 'two', properties: {s: 'b'}}),
    row({id: '3', name: 'three', properties: {s: 'a'}}),
  ];
  const view = (root: DatabaseView['filterRoot']): DatabaseView => ({id: 'v', name: 'v', type: 'table', filters: [], sorts: [], filterRoot: root});

  it('OR combines conditions', () => {
    const out = applyView(rows, view({id: 'r', conjunction: 'or', filters: [
      {id: 'f1', propertyId: TITLE_PROPERTY_ID, operator: 'equals', value: 'one'},
      {id: 'f2', propertyId: 's', operator: 'equals', value: 'b'},
    ]}), [sel]);
    expect(out.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('AND combines conditions', () => {
    const out = applyView(rows, view({id: 'r', conjunction: 'and', filters: [
      {id: 'f1', propertyId: 's', operator: 'equals', value: 'a'},
      {id: 'f2', propertyId: TITLE_PROPERTY_ID, operator: 'contains', value: 'three'},
    ]}), [sel]);
    expect(out.map((r) => r.id)).toEqual(['3']);
  });

  it('nests a sub-group', () => {
    // s == 'a' AND (title == 'one' OR title == 'three')
    const out = applyView(rows, view({id: 'r', conjunction: 'and', filters: [
      {id: 'f1', propertyId: 's', operator: 'equals', value: 'a'},
      {id: 'g', conjunction: 'or', filters: [
        {id: 'f2', propertyId: TITLE_PROPERTY_ID, operator: 'equals', value: 'one'},
        {id: 'f3', propertyId: TITLE_PROPERTY_ID, operator: 'equals', value: 'three'},
      ]},
    ]}), [sel]);
    expect(out.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('falls back to legacy flat filters (ANDed)', () => {
    const out = applyView(rows, {id: 'v', name: 'v', type: 'table', sorts: [], filters: [
      {id: 'f1', propertyId: 's', operator: 'equals', value: 'a'},
    ]}, [sel]);
    expect(out.map((r) => r.id)).toEqual(['1', '3']);
  });
});

describe('rollup property', () => {
  const cost: DatabaseProperty = {id: 'n', name: 'Cost', type: 'number'};
  const rel: DatabaseProperty = {id: 'r', name: 'Items', type: 'relation'};
  const mkRoll = (fn: 'sum' | 'count' | 'avg' | 'show_original' | 'max'): DatabaseProperty => ({
    id: 'ro',
    name: 'Total',
    type: 'rollup',
    rollup: {relationPropertyId: 'r', targetPropertyId: 'n', function: fn},
  });
  const A = row({id: 'A', properties: {n: 10}});
  const B = row({id: 'B', properties: {n: 5}});
  const C = row({id: 'C', properties: {r: ['A', 'B']}});
  const props = [cost, rel];
  const rows = [A, B, C];

  it('folds the related rows target values', () => {
    expect(rowValue(C, mkRoll('sum'), [...props, mkRoll('sum')], rows)).toBe(15);
    expect(rowValue(C, mkRoll('count'), [...props, mkRoll('count')], rows)).toBe(2);
    expect(rowValue(C, mkRoll('avg'), [...props, mkRoll('avg')], rows)).toBe(7.5);
    expect(rowValue(C, mkRoll('max'), [...props, mkRoll('max')], rows)).toBe(10);
    expect(rowValue(C, mkRoll('show_original'), [...props, mkRoll('show_original')], rows)).toEqual([10, 5]);
  });
  it('returns undefined without the row set', () => {
    expect(rowValue(C, mkRoll('sum'), [...props, mkRoll('sum')])).toBeUndefined();
  });
});

describe('status property groups like select', () => {
  const st: DatabaseProperty = {
    id: 'st',
    name: 'Status',
    type: 'status',
    options: [
      {id: 'todo', label: 'Not started', color: 'gray', group: 'todo'},
      {id: 'done', label: 'Done', color: 'green', group: 'complete'},
    ],
  };
  it('groups by status option order', () => {
    const rows = [row({id: '1', properties: {st: 'done'}}), row({id: '2', properties: {st: 'todo'}})];
    const groups = groupRows(rows, st, [st]);
    expect(groups.map((g) => g.label)).toEqual(['Not started', 'Done']);
  });
});

describe('buildRowTree / flattenRowTree (sub-items)', () => {
  const rows = [
    row({id: 'a'}),
    row({id: 'b', parentId: 'a'}),
    row({id: 'c', parentId: 'a'}),
    row({id: 'd', parentId: 'b'}),
    row({id: 'e'}),
  ];
  it('builds a forest by parentId with depths', () => {
    const tree = buildRowTree(rows);
    expect(tree.map((n) => n.row.id)).toEqual(['a', 'e']);
    expect(tree[0].children.map((n) => n.row.id)).toEqual(['b', 'c']);
    expect(tree[0].children[0].children.map((n) => n.row.id)).toEqual(['d']);
    expect(tree[0].children[0].depth).toBe(1);
  });
  it('flattens depth-first, hiding collapsed children', () => {
    const tree = buildRowTree(rows);
    expect(flattenRowTree(tree, new Set()).map((n) => n.row.id)).toEqual(['a', 'b', 'd', 'c', 'e']);
    expect(flattenRowTree(tree, new Set(['a'])).map((n) => n.row.id)).toEqual(['a', 'e']);
    expect(flattenRowTree(tree, new Set(['b'])).map((n) => n.row.id)).toEqual(['a', 'b', 'c', 'e']);
  });
  it('treats orphans (missing parent) as roots', () => {
    expect(buildRowTree([row({id: 'x', parentId: 'ghost'})]).map((n) => n.row.id)).toEqual(['x']);
  });
});

describe('rowsToCsv', () => {
  const props: DatabaseProperty[] = [{id: 'n', name: 'Notes', type: 'text'}];
  it('writes a header + rows and RFC-4180-escapes', () => {
    const rows = [
      row({id: '1', name: 'Plain', properties: {n: 'hi'}}),
      row({id: '2', name: 'A, B', properties: {n: 'say "hi"'}}),
    ];
    const lines = rowsToCsv(rows, props, props).split('\n');
    expect(lines[0]).toBe('Name,Notes');
    expect(lines[1]).toBe('Plain,hi');
    expect(lines[2]).toBe('"A, B","say ""hi"""');
  });
});

describe('removeProperty (reference scrubbing)', () => {
  const schema = {
    properties: [
      {id: 'p1', name: 'Status', type: 'select' as const},
      {id: 'p2', name: 'Cost', type: 'number' as const},
      {id: 'p3', name: 'Total', type: 'rollup' as const, rollup: {relationPropertyId: 'rel', targetPropertyId: 'p2', function: 'sum' as const}},
    ],
    views: [
      {
        id: 'v',
        name: 'V',
        type: 'board' as const,
        filters: [{id: 'f', propertyId: 'p2', operator: 'gt' as const, value: 1}],
        filterRoot: {
          id: 'r',
          conjunction: 'and' as const,
          filters: [
            {id: 'f1', propertyId: 'p2', operator: 'gt' as const, value: 1},
            {id: 'g', conjunction: 'or' as const, filters: [{id: 'f2', propertyId: 'p1', operator: 'equals' as const, value: 'x'}]},
          ],
        },
        sorts: [{propertyId: 'p2', direction: 'asc' as const}],
        visiblePropertyIds: ['p1', 'p2'],
        groupByPropertyId: 'p2',
        summaries: {p1: 'count_all' as const, p2: 'sum' as const},
      },
    ],
  };

  it('scrubs every reference to the removed property', () => {
    const next = removeProperty(schema, 'p2');
    expect(next.properties.map((p) => p.id)).toEqual(['p1', 'p3']);
    const v = next.views[0];
    expect(v.filters).toEqual([]);
    expect(v.filterRoot!.filters.map((f) => (f as {id: string}).id)).toEqual(['g']); // p2 condition gone, group kept
    expect(v.sorts).toEqual([]);
    expect(v.visiblePropertyIds).toEqual(['p1']);
    expect(v.groupByPropertyId).toBeUndefined();
    expect(v.summaries).toEqual({p1: 'count_all'});
    // The rollup targeting p2 is cleared.
    expect(next.properties.find((p) => p.id === 'p3')!.rollup).toBeUndefined();
  });

  it('drops the removed property from row templates, keeping other seeds', () => {
    const withTemplates = {
      ...schema,
      templates: [{id: 't1', name: 'Bug', properties: {p1: 'open', p2: 5}}],
    };
    const next = removeProperty(withTemplates, 'p2');
    expect(next.templates).toEqual([{id: 't1', name: 'Bug', properties: {p1: 'open'}}]);
  });
});

describe('parseCsv', () => {
  it('parses a simple grid', () => {
    expect(parseCsv('Name,Notes\nA,hi\nB,bye')).toEqual([['Name', 'Notes'], ['A', 'hi'], ['B', 'bye']]);
  });
  it('handles quotes, escaped quotes, and embedded commas/newlines', () => {
    expect(parseCsv('Name\n"A, B"\n"say ""hi"""')).toEqual([['Name'], ['A, B'], ['say "hi"']]);
    expect(parseCsv('a,"multi\nline"')).toEqual([['a', 'multi\nline']]);
  });
  it('drops fully-empty lines and normalises CRLF', () => {
    expect(parseCsv('Name\r\nA\r\n\r\n')).toEqual([['Name'], ['A']]);
  });
  it('round-trips with rowsToCsv', () => {
    const props: DatabaseProperty[] = [{id: 'n', name: 'Notes', type: 'text'}];
    const csv = rowsToCsv([row({id: '1', name: 'A, B', properties: {n: 'x'}})], props, props);
    expect(parseCsv(csv)).toEqual([['Name', 'Notes'], ['A, B', 'x']]);
  });
});

describe('files & media helpers', () => {
  it('isImageUrl detects images by extension (with query strings)', () => {
    expect(isImageUrl('https://x.com/a.png')).toBe(true);
    expect(isImageUrl('https://x.com/a.JPG?v=2')).toBe(true);
    expect(isImageUrl('https://x.com/doc.pdf')).toBe(false);
    expect(isImageUrl('https://x.com/no-ext')).toBe(false);
  });
  it('coverImageUrl falls back to extension-less http URLs (CDN images)', () => {
    expect(coverImageUrl(['https://picsum.photos/seed/a/400'])).toBe('https://picsum.photos/seed/a/400');
    expect(coverImageUrl(['https://x.com/doc.pdf', 'https://x.com/pic.webp'])).toBe('https://x.com/pic.webp');
    expect(coverImageUrl('not a url')).toBe(null);
    expect(coverImageUrl(undefined)).toBe(null);
  });

  it('firstImageUrl returns the first image among a list', () => {
    expect(firstImageUrl(['https://x.com/doc.pdf', 'https://x.com/pic.webp'])).toBe('https://x.com/pic.webp');
    expect(firstImageUrl('https://x.com/pic.gif')).toBe('https://x.com/pic.gif');
    expect(firstImageUrl(['https://x.com/doc.pdf'])).toBe(null);
    expect(firstImageUrl(undefined)).toBe(null);
  });
});

describe('formatNumber', () => {
  it('formats per the chosen style', () => {
    expect(formatNumber(1234, 'integer')).toBe((1234).toLocaleString());
    expect(formatNumber(0.25, 'percent')).toBe('25%');
    expect(formatNumber(9.5, 'dollar')).toBe(`$${(9.5).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`);
    expect(formatNumber('', 'integer')).toBe('');
  });
  it('formats the extra currencies (pound, rupee 2dp; yen whole)', () => {
    const two = (n: number) => n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    expect(formatNumber(9.5, 'pound')).toBe(`£${two(9.5)}`);
    expect(formatNumber(9.5, 'rupee')).toBe(`₹${two(9.5)}`);
    expect(formatNumber(1234.6, 'yen')).toBe(`¥${(1235).toLocaleString()}`);
  });
});

describe('formatUniqueId', () => {
  it('formats integers, optionally prefixed (trimming the prefix)', () => {
    expect(formatUniqueId(3)).toBe('3');
    expect(formatUniqueId(3, 'TASK')).toBe('TASK-3');
    expect(formatUniqueId(12, '  BUG ')).toBe('BUG-12');
    expect(formatUniqueId(7, '')).toBe('7');
  });
  it('is empty for unassigned / non-numeric values', () => {
    expect(formatUniqueId(undefined)).toBe('');
    expect(formatUniqueId('5')).toBe('');
    expect(formatUniqueId(NaN)).toBe('');
  });
});

describe('numberProgress (bar / ring display)', () => {
  it('returns the fraction of the target, defaulting the target to 100', () => {
    expect(numberProgress(25)).toBe(0.25);
    expect(numberProgress(50, 200)).toBe(0.25);
    expect(numberProgress('30', 60)).toBe(0.5);
  });
  it('clamps to the 0..1 range', () => {
    expect(numberProgress(150, 100)).toBe(1);
    expect(numberProgress(-5, 100)).toBe(0);
  });
  it('reads non-numbers and a non-positive target safely', () => {
    expect(numberProgress('', 100)).toBe(0);
    expect(numberProgress(undefined)).toBe(0);
    expect(numberProgress(10, 0)).toBe(0.1); // target 0 falls back to 100
  });
});

describe('syncInverseUpdates (two-way dependencies)', () => {
  // 'inv' is the partner property on the related rows that mirrors the link.
  const related = [
    row({id: 'a', properties: {inv: []}}),
    row({id: 'b', properties: {inv: ['r1']}}),
    row({id: 'c', properties: {inv: ['r1', 'other']}}),
  ];

  it('adds the source row to newly-linked partners', () => {
    const updates = syncInverseUpdates('r1', [], ['a'], related, 'inv');
    expect(updates).toEqual([{rowId: 'a', value: ['r1']}]);
  });

  it('removes the source row from unlinked partners, preserving other links', () => {
    const updates = syncInverseUpdates('r1', ['c'], [], related, 'inv');
    expect(updates).toEqual([{rowId: 'c', value: ['other']}]);
  });

  it('is a no-op when the partner already reflects the link', () => {
    expect(syncInverseUpdates('r1', [], ['b'], related, 'inv')).toEqual([]);
  });

  it('handles simultaneous add and remove in one edit', () => {
    const updates = syncInverseUpdates('r1', ['b'], ['a'], related, 'inv');
    expect(updates).toEqual([
      {rowId: 'a', value: ['r1']},
      {rowId: 'b', value: []},
    ]);
  });

  it('ignores ids that do not resolve to a known row', () => {
    expect(syncInverseUpdates('r1', [], ['ghost'], related, 'inv')).toEqual([]);
  });
});

describe('rowMatchesCondition (conditional formatting)', () => {
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
  const props = [status, cost];

  it('matches a select option by equals', () => {
    expect(rowMatchesCondition(row({properties: {s: 'done'}}), {propertyId: 's', operator: 'equals', value: 'done'}, props)).toBe(true);
    expect(rowMatchesCondition(row({properties: {s: 'todo'}}), {propertyId: 's', operator: 'equals', value: 'done'}, props)).toBe(false);
  });

  it('matches a numeric comparison', () => {
    expect(rowMatchesCondition(row({properties: {c: 1500}}), {propertyId: 'c', operator: 'gt', value: 1000}, props)).toBe(true);
    expect(rowMatchesCondition(row({properties: {c: 500}}), {propertyId: 'c', operator: 'gt', value: 1000}, props)).toBe(false);
  });

  it('matches emptiness and returns false for an unknown property', () => {
    expect(rowMatchesCondition(row({properties: {}}), {propertyId: 'c', operator: 'is_empty'}, props)).toBe(true);
    expect(rowMatchesCondition(row({properties: {c: 5}}), {propertyId: 'gone', operator: 'is_empty'}, props)).toBe(false);
  });
});
