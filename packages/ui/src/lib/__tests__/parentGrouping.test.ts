import {describe, it, expect} from 'vitest';
import {
  aggregateMatrix,
  groupRowsBy,
  groupRowsByParent,
  NO_PARENT_GROUP,
  PARENT_GROUP_ID,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView,
} from '@open-book/sdk';

const row = (id: string, over: Partial<DatabaseRow> = {}): DatabaseRow => ({
  id,
  name: id,
  properties: {},
  exports: {},
  parentId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
  ...over,
});

describe('groupRowsByParent', () => {
  it('makes one group per parent (in row order) plus a trailing no-parent group', () => {
    const rows = [
      row('epic-a'),
      row('task-1', {parentId: 'epic-a'}),
      row('epic-b'),
      row('task-2', {parentId: 'epic-b'}),
      row('task-3', {parentId: 'epic-a'}),
      row('loose'),
    ];
    const groups = groupRowsByParent(rows);
    expect(groups.map((g) => g.key)).toEqual(['epic-a', 'epic-b', '__none__']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['task-1', 'task-3']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['task-2']);
    expect(groups[2].label).toBe(NO_PARENT_GROUP);
    expect(groups[2].rows.map((r) => r.id)).toEqual(['loose']);
  });

  it('parents do not appear as cards; loose rows are only those with no parent and no children', () => {
    const rows = [row('p'), row('c', {parentId: 'p'})];
    const groups = groupRowsByParent(rows);
    expect(groups).toHaveLength(1); // no trailing group: 'p' is a parent, 'c' is filed under it
    expect(groups[0].rows.map((r) => r.id)).toEqual(['c']);
  });

  it('a mid-level row appears in its parent group and heads its own', () => {
    const rows = [row('top'), row('mid', {parentId: 'top'}), row('leaf', {parentId: 'mid'})];
    const groups = groupRowsByParent(rows);
    expect(groups.map((g) => g.key)).toEqual(['top', 'mid']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['mid']);
    expect(groups[1].rows.map((r) => r.id)).toEqual(['leaf']);
  });

  it('ignores parents outside the set (filtered away, or the host page)', () => {
    const rows = [row('a', {parentId: 'not-a-row'}), row('b', {parentId: 'host-page'})];
    const groups = groupRowsByParent(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__none__');
    expect(groups[0].rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('labels untitled parents and omits the no-parent group when empty', () => {
    const rows = [row('p', {name: null as unknown as string}), row('c', {parentId: 'p'})];
    const groups = groupRowsByParent(rows);
    expect(groups.map((g) => g.label)).toEqual(['Untitled']);
  });
});

describe('groupRowsBy', () => {
  const status: DatabaseProperty = {
    id: 'p_status',
    name: 'Status',
    type: 'select',
    options: [{id: 'opt_a', label: 'A', color: 'blue'}],
  };

  it('dispatches the parent sentinel to groupRowsByParent', () => {
    const rows = [row('p'), row('c', {parentId: 'p'})];
    expect(groupRowsBy(rows, PARENT_GROUP_ID, [status]).map((g) => g.key)).toEqual(['p']);
  });

  it('falls through to property grouping (and "All" when unset)', () => {
    const rows = [row('r', {properties: {p_status: 'opt_a'}})];
    expect(groupRowsBy(rows, 'p_status', [status]).map((g) => g.key)).toEqual(['opt_a']);
    expect(groupRowsBy(rows, undefined, [status]).map((g) => g.key)).toEqual(['__all__']);
  });
});

describe('aggregateMatrix with parent grouping', () => {
  const status: DatabaseProperty = {
    id: 'p_status',
    name: 'Status',
    type: 'select',
    options: [
      {id: 'opt_todo', label: 'Todo', color: 'gray'},
      {id: 'opt_done', label: 'Done', color: 'green'},
    ],
  };
  const rows = [
    row('epic-a'),
    row('t1', {parentId: 'epic-a', properties: {p_status: 'opt_todo'}}),
    row('t2', {parentId: 'epic-a', properties: {p_status: 'opt_done'}}),
    row('epic-b'),
    row('t3', {parentId: 'epic-b', properties: {p_status: 'opt_todo'}}),
  ];

  it('charts one group per parent with counted children', () => {
    const view: DatabaseView = {id: 'v', name: 'Pie', type: 'pie', filters: [], sorts: [], groupByPropertyId: PARENT_GROUP_ID};
    const {groups} = aggregateMatrix(rows, view, [status]);
    expect(groups.map((g) => [g.label, g.total])).toEqual([
      ['epic-a', 2],
      ['epic-b', 1],
    ]);
  });

  it('breaks a property-grouped chart down by parent (and vice versa)', () => {
    const byStatus: DatabaseView = {
      id: 'v',
      name: 'Bar',
      type: 'bar',
      filters: [],
      sorts: [],
      groupByPropertyId: 'p_status',
      breakdownPropertyId: PARENT_GROUP_ID,
    };
    const m = aggregateMatrix(rows, byStatus, [status]);
    expect(m.series.map((s) => s.label)).toEqual(['epic-a', 'epic-b']);
    const todo = m.groups.find((g) => g.key === 'opt_todo')!;
    expect(todo.segments.map((s) => s.value)).toEqual([1, 1]);

    const byParent: DatabaseView = {...byStatus, groupByPropertyId: PARENT_GROUP_ID, breakdownPropertyId: 'p_status'};
    const m2 = aggregateMatrix(rows, byParent, [status]);
    expect(m2.groups.map((g) => g.label)).toEqual(['epic-a', 'epic-b']);
    // The series span every row, so the status-less epics add the no-value series.
    expect(m2.series.map((s) => s.key)).toEqual(['opt_todo', 'opt_done', '__none__']);
  });
});
