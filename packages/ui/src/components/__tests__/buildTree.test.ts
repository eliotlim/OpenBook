import {describe, it, expect} from 'vitest';
import {Database, FileText} from 'lucide-react';
import type {PageMeta} from '@open-book/sdk';
import {buildTree} from '../WorkspaceNavigationTree';

const page = (id: string, name: string | null, parentId: string | null = null): PageMeta => ({
  id,
  name,
  parentId,
  hostedDatabaseId: null,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('buildTree', () => {
  it('keeps top-level pages at the root', () => {
    const tree = buildTree([page('a', 'A'), page('b', 'B')]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree.every((n) => !n.children)).toBe(true);
  });

  it('nests a child under its parent (subpage regression)', () => {
    const tree = buildTree([page('parent', 'Parent'), page('child', 'Child', 'parent')]);
    expect(tree.map((n) => n.id)).toEqual(['parent']); // child is NOT a top-level page
    expect(tree[0].children?.map((n) => n.id)).toEqual(['child']);
  });

  it('nests recursively', () => {
    const tree = buildTree([page('a', 'A'), page('b', 'B', 'a'), page('c', 'C', 'b')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children?.[0].id).toBe('b');
    expect(tree[0].children?.[0].children?.[0].id).toBe('c');
  });

  it('surfaces an orphan (parent not in the list) at the top level', () => {
    const tree = buildTree([page('child', 'Child', 'missing-parent')]);
    expect(tree.map((n) => n.id)).toEqual(['child']);
  });

  it('labels untitled pages', () => {
    const tree = buildTree([page('a', null)]);
    expect(tree[0].name).toBe('Untitled');
  });

  it('uses the stored emoji icon, else a fallback glyph', () => {
    localStorage.setItem('openbook.icon.a', '🔥');
    const dbPage: PageMeta = {...page('b', 'B'), hostedDatabaseId: 'db-1'};
    const tree = buildTree([page('a', 'A'), dbPage, page('c', 'C')]);
    expect(tree[0].icon).toBe('🔥'); // chosen emoji wins
    expect(tree[1].icon).toBe(Database); // database host fallback
    expect(tree[2].icon).toBe(FileText); // plain page fallback
    localStorage.removeItem('openbook.icon.a');
  });
});
