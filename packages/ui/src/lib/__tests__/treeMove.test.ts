import {describe, it, expect} from 'vitest';
import type {PageMeta} from '@open-book/sdk';
import {planTreeMove} from '../treeMove';

const page = (id: string, parentId: string | null = null): PageMeta => ({
  id,
  name: id,
  parentId,
  hostedDatabaseId: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('planTreeMove', () => {
  const roots = [page('a'), page('b'), page('c')]; // list order = sidebar order

  it('reorders a sibling before another (top level)', () => {
    expect(planTreeMove(roots, 'c', 'a', 'before')).toEqual({parentId: null, orderedIds: ['c', 'a', 'b']});
  });

  it('reorders a sibling after another (top level)', () => {
    expect(planTreeMove(roots, 'a', 'c', 'after')).toEqual({parentId: null, orderedIds: ['b', 'c', 'a']});
  });

  it('nests a page inside another (re-parent + append)', () => {
    expect(planTreeMove(roots, 'b', 'a', 'inside')).toEqual({parentId: 'a', orderedIds: ['b']});
  });

  it('un-nests a child to the top level', () => {
    const pages = [page('a'), page('x', 'a'), page('b')];
    expect(planTreeMove(pages, 'x', 'b', 'before')).toEqual({parentId: null, orderedIds: ['a', 'x', 'b']});
  });

  it('reorders within a nested group, keeping the parent', () => {
    const pages = [page('a'), page('x', 'a'), page('y', 'a')];
    expect(planTreeMove(pages, 'y', 'x', 'before')).toEqual({parentId: 'a', orderedIds: ['y', 'x']});
  });

  it('rejects dropping a page onto itself', () => {
    expect(planTreeMove(roots, 'a', 'a', 'before')).toBeNull();
  });

  it('rejects nesting a page inside its own descendant (cycle)', () => {
    const pages = [page('a'), page('x', 'a')];
    expect(planTreeMove(pages, 'a', 'x', 'inside')).toBeNull();
  });

  it('rejects a move when ids are unknown', () => {
    expect(planTreeMove(roots, 'missing', 'a', 'before')).toBeNull();
  });
});
