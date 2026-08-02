import {describe, it, expect} from 'vitest';
import {
  projectExports,
  rowValue,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseRow,
} from './database';
import type {PageSnapshot} from './types';
import {evaluateFormula, type FormulaResolver} from './formula';

/**
 * LGR-1 platform-capability audit — empirical proof of the load-bearing
 * NEGATIVE behind the ledger epic (see docs/ledger/platform-audit.md, Q1):
 *
 *   No derived-column mechanism (`expr`, `formula`, `rollup`) can aggregate
 *   across the rows of a database, let alone across ANOTHER database. Ledger
 *   invariants (e.g. "postings in a transaction sum to zero", account balances
 *   as SUM over postings) therefore CANNOT be expressed as computed columns —
 *   they must be enforced server-side and rendered by a plugin.
 *
 * These tests pin today's row-local semantics as regression documentation:
 * if any of them ever fails, the platform has grown a cross-row aggregation
 * primitive and the audit's Q1 verdict must be revisited.
 */

const row = (id: string, over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  id,
  name: `Row ${id}`,
  properties: {},
  exports: {},
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('LGR-1 Q1(a): expr resolution is row-local (own page snapshot only)', () => {
  it('projectExports reads only one page snapshot — there is no cross-page input', () => {
    // The entire input surface of expr projection is a single page's snapshot:
    // a names index + a cellId→value map. Another row's values simply have no
    // channel into this function.
    const snapshot: Pick<PageSnapshot, 'values' | 'names'> = {
      values: [['cell1', 100]],
      names: [['amount', 'cell1']],
    };
    expect(projectExports(snapshot)).toEqual({amount: 100});
  });

  it('rowValue for an expr property reads row.exports and cannot see a sibling row', () => {
    const amount: DatabaseProperty = {id: 'p1', name: 'amount', type: 'expr', cellName: 'amount'};
    const a = row('a', {exports: {amount: 100}});
    const b = row('b', {exports: {amount: 250}});
    // Each row resolves strictly from its own exports bag…
    expect(rowValue(a, amount, [amount], [a, b])).toBe(100);
    expect(rowValue(b, amount, [amount], [a, b])).toBe(250);
    // …and a name that only ANOTHER row exports is invisible — undefined, not
    // a lookup across the rows array (which rowValue receives but never scans
    // for expr).
    const other: DatabaseProperty = {id: 'p2', name: 'onlyOnB', type: 'expr', cellName: 'onlyOnB'};
    const bWith = row('b', {exports: {onlyOnB: 42}});
    expect(rowValue(a, other, [amount, other], [a, bWith])).toBeUndefined();
  });
});

describe('LGR-1 Q1(b): formula sum() is variadic-over-args, not a row aggregate', () => {
  it('sum(...) folds its ARGUMENTS, with no access to other rows', () => {
    // sum(1,2,3) = 6: it reduces the literal argument list.
    expect(evaluateFormula('sum(1, 2, 3)', () => null)).toBe(6);
  });

  it('a formula referencing a property sees ONE row via its resolver — sum over a column is inexpressible', () => {
    const props: DatabaseProperty[] = [
      {id: 'amt', name: 'Amount', type: 'number'},
      {id: 'f', name: 'Total', type: 'formula', formula: 'sum(prop("Amount"))'},
    ];
    const rows = [
      row('a', {properties: {amt: 100}}),
      row('b', {properties: {amt: 250}}),
    ];
    // Evaluated per-row, "sum" of the single resolved value is just that value:
    // there is no syntax or resolver channel that yields the column's 350.
    expect(rowValue(rows[0], props[1], props, rows)).toBe(100);
    expect(rowValue(rows[1], props[1], props, rows)).toBe(250);
  });

  it('the resolver contract is name→value for the current row only', () => {
    // FormulaResolver = (name: string) => unknown — a single-row lookup. A
    // resolver can only ever hand back one value per name; "all rows' Amount"
    // has no representation (an array would be normalized to a joined string).
    const resolve: FormulaResolver = (name) => (name === 'Amount' ? [100, 250] : null);
    expect(evaluateFormula('prop("Amount")', resolve)).toBe('100, 250'); // stringified, not aggregable rows
  });
});

describe('LGR-1 Q1(c): rollup folds ONLY rows linked via a relation cell', () => {
  const props: DatabaseProperty[] = [
    {id: 'rel', name: 'Links', type: 'relation'},
    {id: 'amt', name: 'Amount', type: 'number'},
    {
      id: 'roll',
      name: 'Linked total',
      type: 'rollup',
      rollup: {relationPropertyId: 'rel', targetPropertyId: 'amt', function: 'sum'},
    },
  ];

  it('sums the rows the relation cell names — and ONLY those', () => {
    const linked1 = row('l1', {properties: {amt: 10}});
    const linked2 = row('l2', {properties: {amt: 20}});
    const unlinked = row('u1', {properties: {amt: 999}});
    const source = row('s', {properties: {rel: ['l1', 'l2'], amt: 0}});
    // 10 + 20 = 30; the unlinked row's 999 is present in `rows` but unreachable.
    expect(rowValue(source, props[2], props, [source, linked1, linked2, unlinked])).toBe(30);
  });

  it('an empty relation cell rolls up to 0 regardless of what the database holds', () => {
    const rich1 = row('r1', {properties: {amt: 500}});
    const rich2 = row('r2', {properties: {amt: 500}});
    const source = row('s', {properties: {rel: [], amt: 0}});
    // A whole-database SUM would be 1000; the rollup sees nothing without links.
    expect(rowValue(source, props[2], props, [source, rich1, rich2])).toBe(0);
  });

  it('rollup ids resolve within the PASSED rows array — no cross-database reach', () => {
    // The relation names a row id that is not in `rows` (e.g. lives in another
    // database). computeRollup drops it: missing rows are filtered, not fetched.
    const source = row('s', {properties: {rel: ['elsewhere-1', 'elsewhere-2']}});
    expect(rowValue(source, props[2], props, [source])).toBe(0);
    // Even `count` — the loosest fold — counts only resolvable (same-set) rows.
    const countProp: DatabaseProperty = {
      id: 'cnt',
      name: 'Linked count',
      type: 'rollup',
      rollup: {relationPropertyId: 'rel', targetPropertyId: TITLE_PROPERTY_ID, function: 'count'},
    };
    expect(rowValue(source, countProp, [...props, countProp], [source])).toBe(0);
  });
});
