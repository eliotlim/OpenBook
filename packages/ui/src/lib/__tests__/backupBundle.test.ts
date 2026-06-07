import {describe, it, expect} from 'vitest';
import {remapBundle, type SpaceBackup, type StoredDatabase, type StoredPage} from '@open-book/sdk';
import {bundleRoots, closure, overwriteCount, parseBackup} from '../backupBundle';

const page = (id: string, over: Partial<StoredPage> = {}): StoredPage => ({
  id,
  name: id,
  data: {editorjs: {blocks: []}, values: [], names: []},
  hostedDatabaseId: null,
  databaseId: null,
  parentId: null,
  properties: {},
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const db = (id: string, pageId: string): StoredDatabase => ({
  id,
  pageId,
  name: id,
  schema: {properties: [], views: []},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const backup = (pages: StoredPage[], databases: StoredDatabase[] = []): SpaceBackup => ({
  version: 1,
  exportedAt: '2026-01-01',
  pages,
  databases,
});

describe('parseBackup', () => {
  it('rejects non-backup JSON', () => {
    expect(() => parseBackup('{}')).toThrow();
    expect(() => parseBackup(JSON.stringify({version: 1, pages: [], databases: []}))).not.toThrow();
  });
});

describe('bundleRoots', () => {
  it('lists top-level pages, excluding nested pages and database rows', () => {
    const b = backup([page('a'), page('child', {parentId: 'a'}), page('row', {databaseId: 'd1'})], [db('d1', 'a')]);
    expect(bundleRoots(b).map((p) => p.id)).toEqual(['a']);
  });
});

describe('closure', () => {
  it('expands a selected root to its subtree, hosted database, and rows', () => {
    const b = backup(
      [page('a'), page('child', {parentId: 'a', hostedDatabaseId: 'd1'}), page('row', {databaseId: 'd1'}), page('other')],
      [db('d1', 'child')],
    );
    const sel = closure(b, ['a']);
    expect(sel.pages.map((p) => p.id).sort()).toEqual(['a', 'child', 'row']);
    expect(sel.databases.map((d) => d.id)).toEqual(['d1']);
    // 'other' (not selected) stays out.
    expect(sel.pages.some((p) => p.id === 'other')).toBe(false);
  });
});

describe('overwriteCount', () => {
  it('counts pages whose id already exists', () => {
    expect(overwriteCount([page('a'), page('b')], new Set(['a', 'z']))).toBe(1);
  });
});

describe('remapBundle (copy import)', () => {
  it('mints new ids and remaps parent/database refs and @-mention ids', () => {
    let n = 0;
    const newId = () => `new-${n++}`;
    const pages = [
      page('p1', {data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'see <a class="ob-mention" data-page-id="p2">x</a>'}}]}, values: [], names: []}}),
      page('p2', {parentId: 'p1', databaseId: 'd1'}),
    ];
    const {pages: rp, idMap} = remapBundle(pages, [db('d1', 'p1')], newId);
    // ids are all fresh
    expect(rp.every((p) => p.id.startsWith('new-'))).toBe(true);
    // p2's parent is p1's new id
    expect(rp[1].parentId).toBe(idMap['p1']);
    // the mention to p2 now points at p2's new id
    expect(JSON.stringify(rp[0].data)).toContain(`data-page-id=\\"${idMap['p2']}\\"`);
  });
});
