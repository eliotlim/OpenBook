import {describe, expect, it} from 'vitest';
import {
  bookHtmlToPage,
  computeBlockMtimes,
  pageToBookHtml,
  readBookHtmlMeta,
  slugify,
  snapshotBlocks,
  stampSnapshotMtimes,
  type PageSnapshot,
} from '@book.dev/sdk';

const NOW = '2026-06-19T12:00:00.000Z';
const LATER = '2026-06-19T13:00:00.000Z';

const snap = (blocks: Array<{id: string; text: string}>): PageSnapshot => ({
  editorjs: {blocks: blocks.map((b) => ({id: b.id, type: 'paragraph', data: {text: b.text}}))},
  values: [],
  names: [],
});

describe('snapshotBlocks', () => {
  it('reads EditorJS blocks with stable ids and content hashes', () => {
    const blocks = snapshotBlocks(snap([{id: 'a', text: 'hello'}, {id: 'b', text: 'world'}]));
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(blocks[0].hash).not.toBe(blocks[1].hash);
  });

  it('reads the block-editor JSON projection', () => {
    const data: PageSnapshot = {
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: {blocks: [{id: 'x', type: 'paragraph', text: [{t: 'hi'}]}]},
    };
    const blocks = snapshotBlocks(data);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe('x');
  });

  it('hashes are order-insensitive for object props but content-sensitive', () => {
    const a = snapshotBlocks(snap([{id: 'a', text: 'same'}]))[0].hash;
    const b = snapshotBlocks(snap([{id: 'a', text: 'same'}]))[0].hash;
    const c = snapshotBlocks(snap([{id: 'a', text: 'different'}]))[0].hash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('stampSnapshotMtimes', () => {
  it('stamps every block on a fresh page', () => {
    const next = stampSnapshotMtimes(null, snap([{id: 'a', text: 'one'}, {id: 'b', text: 'two'}]), NOW);
    expect(next.mtimes).toEqual([['a', NOW], ['b', NOW]]);
  });

  it('carries forward unchanged blocks and restamps only the changed one', () => {
    const prev = stampSnapshotMtimes(null, snap([{id: 'a', text: 'one'}, {id: 'b', text: 'two'}]), NOW);
    const next = stampSnapshotMtimes(prev, snap([{id: 'a', text: 'one'}, {id: 'b', text: 'EDITED'}]), LATER);
    expect(next.mtimes).toEqual([['a', NOW], ['b', LATER]]);
  });

  it('stamps a newly-inserted block while keeping the others', () => {
    const prev = stampSnapshotMtimes(null, snap([{id: 'a', text: 'one'}]), NOW);
    const next = stampSnapshotMtimes(prev, snap([{id: 'a', text: 'one'}, {id: 'c', text: 'new'}]), LATER);
    expect(next.mtimes).toEqual([['a', NOW], ['c', LATER]]);
  });

  it('is idempotent: re-stamping an identical snapshot keeps timestamps', () => {
    const prev = stampSnapshotMtimes(null, snap([{id: 'a', text: 'one'}]), NOW);
    const again = stampSnapshotMtimes(prev, snap([{id: 'a', text: 'one'}]), LATER);
    expect(again.mtimes).toEqual([['a', NOW]]);
  });

  it('computeBlockMtimes treats an unstamped prev as fully changed', () => {
    const prevNoMtimes = snap([{id: 'a', text: 'one'}]); // no mtimes array
    const mtimes = computeBlockMtimes(prevNoMtimes, snap([{id: 'a', text: 'one'}]), LATER);
    expect(mtimes).toEqual([['a', LATER]]);
  });
});

describe('book-file HTML round-trip', () => {
  const record = {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'My Page',
    icon: '📄',
    updatedAt: NOW,
    data: stampSnapshotMtimes(null, snap([{id: 'a', text: 'Hello <b>world</b>'}, {id: 'b', text: 'second'}]), NOW),
  };

  it('renders readable HTML with per-block ids + mtimes and a page base', () => {
    const html = pageToBookHtml(record);
    expect(html).toContain('data-page-id="11111111-1111-1111-1111-111111111111"');
    expect(html).toContain(`data-page-updated="${NOW}"`);
    expect(html).toContain('data-block-id="a"');
    expect(html).toContain(`data-block-mtime="${NOW}"`);
    expect(html).toContain('Hello <b>world</b>'); // readable body keeps inline markup
  });

  it('round-trips losslessly through the JSON island', () => {
    const parsed = bookHtmlToPage(pageToBookHtml(record));
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(record.id);
    expect(parsed!.name).toBe('My Page');
    expect(parsed!.icon).toBe('📄');
    expect(parsed!.updatedAt).toBe(NOW);
    expect(JSON.stringify(parsed!.data)).toBe(JSON.stringify(record.data));
  });

  it('survives a literal </script> in the content', () => {
    const tricky = {
      ...record,
      data: stampSnapshotMtimes(null, snap([{id: 'a', text: 'oops </script> <script>alert(1)</script>'}]), NOW),
    };
    const parsed = bookHtmlToPage(pageToBookHtml(tricky));
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed!.data)).toBe(JSON.stringify(tricky.data));
  });

  it('readBookHtmlMeta extracts id + base cheaply without the island', () => {
    const meta = readBookHtmlMeta(pageToBookHtml(record));
    expect(meta).toEqual({id: record.id, name: 'My Page', updatedAt: NOW});
  });

  it('returns null for non-book HTML', () => {
    expect(bookHtmlToPage('<html><body>just a page</body></html>')).toBeNull();
    expect(readBookHtmlMeta('<html><body>nope</body></html>')).toBeNull();
  });
});

describe('slugify', () => {
  it('produces filesystem-safe slugs', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  Trip 2026 — Plans  ')).toBe('trip-2026-plans');
    expect(slugify('')).toBe('untitled');
    expect(slugify('///')).toBe('untitled');
  });
});
