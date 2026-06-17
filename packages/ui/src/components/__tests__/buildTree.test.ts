import {describe, it, expect} from 'vitest';
import type {PageMeta} from '@open-book/sdk';
import {buildTree} from '../WorkspaceNavigationTree';
import {writePageIcon} from '@/lib/pageIcon';

const page = (id: string, name: string | null, parentId: string | null = null): PageMeta => ({
  id,
  name,
  icon: null,
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

  it('mirrors the page icon: chosen emoji, else the default page icon', () => {
    writePageIcon('icon-a', '🔥'); // the icon store (page.properties-backed) holds it
    const tree = buildTree([page('icon-a', 'A'), page('icon-b', 'B')]);
    expect(tree[0].icon).toBe('🔥'); // chosen emoji
    expect(tree[1].icon).toBe('📄'); // DEFAULT_PAGE_ICON, same as the page header
    writePageIcon('icon-a', '');
  });
});
