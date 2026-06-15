import {describe, it, expect} from 'vitest';
import {relationSides, syncInverseUpdates, type DatabaseRow} from '@open-book/sdk';

describe('relationSides (cardinality)', () => {
  it('maps each cardinality to per-side single/many', () => {
    expect(relationSides('1:1')).toEqual({forwardSingle: true, reverseSingle: true});
    expect(relationSides('1:n')).toEqual({forwardSingle: false, reverseSingle: true});
    expect(relationSides('n:n')).toEqual({forwardSingle: false, reverseSingle: false});
  });
});

/** A bare row stub for the mirror helper. */
const row = (id: string, props: Record<string, unknown> = {}): DatabaseRow =>
  ({id, name: id, properties: props, exports: {}, parentId: null, createdAt: '', updatedAt: ''}) as DatabaseRow;

describe('syncInverseUpdates (reverse-link mirror, reused cross-database)', () => {
  it('adds this row to newly-linked target rows and removes it from unlinked ones', () => {
    const targets = [row('a', {rev: []}), row('b', {rev: ['src1']}), row('c', {rev: ['src1']})];
    // src1 was linked to b,c; now linked to a,b → add to a, remove from c, leave b.
    const updates = syncInverseUpdates('src1', ['b', 'c'], ['a', 'b'], targets, 'rev');
    const byId = new Map(updates.map((u) => [u.rowId, u.value]));
    expect(byId.get('a')).toEqual(['src1']);
    expect(byId.get('c')).toEqual([]);
    expect(byId.has('b')).toBe(false); // unchanged
  });

  it('is a no-op when the link set is unchanged', () => {
    const targets = [row('a', {rev: ['src1']})];
    expect(syncInverseUpdates('src1', ['a'], ['a'], targets, 'rev')).toEqual([]);
  });
});
