import {describe, it, expect} from 'vitest';
import {matchesFilter, propertiesReferencePage, rowValue, type DatabaseProperty, type DatabaseRow} from '@book.dev/sdk';

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

describe('propertiesReferencePage', () => {
  it('matches a direct id value', () => {
    expect(propertiesReferencePage({owner: 'P1'}, 'P1')).toBe(true);
  });
  it('matches an id inside an array-valued (relation) property', () => {
    expect(propertiesReferencePage({rel: ['A', 'P1', 'B']}, 'P1')).toBe(true);
  });
  it('is false when absent, null, or unrelated', () => {
    expect(propertiesReferencePage({rel: ['A', 'B']}, 'P1')).toBe(false);
    expect(propertiesReferencePage(null, 'P1')).toBe(false);
    expect(propertiesReferencePage({}, 'P1')).toBe(false);
  });
});

describe('rowValue for derived timestamp types', () => {
  const created: DatabaseProperty = {id: 'c', name: 'Created', type: 'created_time'};
  const edited: DatabaseProperty = {id: 'e', name: 'Edited', type: 'last_edited_time'};
  it('reads created/last-edited from the row, not properties', () => {
    const r = row({properties: {c: 'ignored', e: 'ignored'}});
    expect(rowValue(r, created)).toBe('2026-01-01T00:00:00.000Z');
    expect(rowValue(r, edited)).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('matchesFilter on array (multi-select / relation) cells', () => {
  it('contains tests membership; not_contains negates', () => {
    expect(matchesFilter('contains', ['apple', 'pear'], 'pe')).toBe(true);
    expect(matchesFilter('not_contains', ['apple', 'pear'], 'fig')).toBe(true);
    expect(matchesFilter('contains', ['apple'], 'fig')).toBe(false);
  });
  it('is_empty / is_not_empty test array length', () => {
    expect(matchesFilter('is_empty', [], undefined)).toBe(true);
    expect(matchesFilter('is_not_empty', ['x'], undefined)).toBe(true);
    expect(matchesFilter('is_empty', ['x'], undefined)).toBe(false);
  });
});
