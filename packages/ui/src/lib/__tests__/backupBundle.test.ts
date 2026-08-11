import {describe, it, expect} from 'vitest';
import {remapBundle, type LibraryBackup, type StoredDatabase, type StoredPage} from '@book.dev/sdk';
import {backupAccessDelta, bundleRoots, closure, overwriteCount, parseBackup} from '../backupBundle';

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

const backup = (pages: StoredPage[], databases: StoredDatabase[] = []): LibraryBackup => ({
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

  it('carries the v2 ledger durability section through (LGR-15) — dropping it would export a book whose restore cannot verify', () => {
    const ledger = {settings: {ledgerDb: {}}, audit: [], assets: []};
    const parsed = parseBackup(JSON.stringify({version: 2, pages: [], databases: [], ledger}));
    expect(parsed.ledger).toEqual(ledger);
    // …and a v1 file simply has none.
    expect(parseBackup(JSON.stringify({version: 1, pages: [], databases: []})).ledger).toBeUndefined();
  });

  it('carries the v3 asset, page-access, and skipped manifests through unchanged (OB-699)', () => {
    const assets = [{id: 'a'.repeat(64), mime: 'image/png', size: 1, bytesBase64: 'AA==', refs: ['p']}];
    const pageAccess = [{pageId: 'p', visibility: 'restricted', agentEdits: 'suggest', acl: []}];
    const skipped = [{id: 'b'.repeat(64), refs: ['p'], reason: 'missing-bytes'}];
    const parsed = parseBackup(JSON.stringify({
      version: 3,
      instanceId: 'instance-a',
      ownerSubject: 'account#owner',
      pages: [page('p')],
      databases: [],
      assets,
      pageAccess,
      skipped,
    }));
    expect(parsed.assets).toEqual(assets);
    expect(parsed.pageAccess).toEqual(pageAccess);
    expect(parsed.skipped).toEqual(skipped);
    expect(parsed.instanceId).toBe('instance-a');
    expect(parsed.ownerSubject).toBe('account#owner');
  });

  it('rejects invalid and future format versions', () => {
    expect(() => parseBackup(JSON.stringify({version: 0, pages: [], databases: []}))).toThrow();
    expect(() => parseBackup(JSON.stringify({version: 4, pages: [], databases: []}))).toThrow();
  });
});

describe('backupAccessDelta', () => {
  it('counts only selected public pages, subject grants, and direct-agent relaxations', () => {
    const acl = (subject: string | null, email: string | null) => ({
      subject,
      email,
      issuer: email ? 'https://account.example' : null,
      level: 'write' as const,
      invitedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(backupAccessDelta([
      {pageId: 'a', visibility: 'public', agentEdits: 'direct', acl: [acl('acct#a', null), acl(null, 'a@example.com')]},
      {pageId: 'b', visibility: 'restricted', agentEdits: 'direct', acl: [acl('acct#b', null)]},
      {pageId: 'c', visibility: 'public', agentEdits: 'suggest', acl: [acl('acct#c', null)]},
    ], new Set(['a', 'b']))).toEqual({publicPages: 1, subjectGrants: 2, agentEditRelaxations: 2});
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
