import {describe, expect, it} from 'vitest';
import {markdownToBlocks, markdownToImportedDoc} from './markdownImport';
import {
  importDoc,
  IMAGE_PLACEHOLDER_PROP,
  type ImportedBlock,
  type ImportWriteClient,
} from './import';
import type {PageInput, StoredPage} from './types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const plain = (b: ImportedBlock | undefined): string => (b?.text ?? []).map((r) => r.t).join('');

/** Every bit of human text in a block tree — runs, nested cells, and the
 *  alt/ref a placeholder preserves — for the "never silently drop" assertion. */
function allText(blocks: ImportedBlock[]): string {
  let s = '';
  for (const b of blocks) {
    s += `${plain(b)} `;
    const asset = b.props?.[IMAGE_PLACEHOLDER_PROP] as {ref?: string; alt?: string} | undefined;
    if (asset) s += `${asset.alt ?? ''} ${asset.ref ?? ''} `;
    if (b.children) s += allText(b.children);
  }
  return s;
}

const only = (md: string): ImportedBlock[] => markdownToBlocks(md);

// ── Block mapping ────────────────────────────────────────────────────────────

describe('markdownToBlocks — block mapping', () => {
  it('maps headings to heading blocks, clamping the level to 3', () => {
    const blocks = only('# One\n\n## Two\n\n###### Six');
    expect(blocks.map((b) => [b.type, b.props?.level, plain(b)])).toEqual([
      ['heading', 1, 'One'],
      ['heading', 2, 'Two'],
      ['heading', 3, 'Six'],
    ]);
  });

  it('maps a paragraph with inline runs (bold/italic/strike/code/link)', () => {
    const [p] = only('Plain **bold** _italic_ ~~struck~~ `code` and [link](https://ex.com).');
    expect(p.type).toBe('paragraph');
    expect(p.text).toEqual([
      {t: 'Plain '},
      {t: 'bold', a: {b: true}},
      {t: ' '},
      {t: 'italic', a: {i: true}},
      {t: ' '},
      {t: 'struck', a: {s: true}},
      {t: ' '},
      {t: 'code', a: {c: true}},
      {t: ' and '},
      {t: 'link', a: {a: 'https://ex.com'}},
      {t: '.'},
    ]);
  });

  it('maps unordered and ordered lists with the right kind', () => {
    const blocks = only('- a\n- b\n\n1. one\n2. two');
    expect(blocks.map((b) => [b.type, b.props?.kind, plain(b)])).toEqual([
      ['list', 'bullet', 'a'],
      ['list', 'bullet', 'b'],
      ['list', 'number', 'one'],
      ['list', 'number', 'two'],
    ]);
  });

  it('flattens nested lists to indent props', () => {
    const blocks = only('- top\n  - mid\n    - deep\n- back');
    expect(blocks.map((b) => [plain(b), b.props?.indent])).toEqual([
      ['top', undefined],
      ['mid', 1],
      ['deep', 2],
      ['back', undefined],
    ]);
  });

  it('maps GFM task lists to todo blocks with checked', () => {
    const blocks = only('- [ ] open\n- [x] done');
    expect(blocks.map((b) => [b.type, b.props?.checked ?? false, plain(b)])).toEqual([
      ['todo', false, 'open'],
      ['todo', true, 'done'],
    ]);
  });

  it('folds a multi-paragraph blockquote into one quote block', () => {
    const [q] = only('> line one\n>\n> line two');
    expect(q.type).toBe('quote');
    expect(plain(q)).toBe('line one\nline two');
  });

  it('maps fenced code with its language', () => {
    const [c] = only('```ts\nconst a = 1;\nconst b = 2;\n```');
    expect(c.type).toBe('code');
    expect(c.props?.language).toBe('ts');
    expect(plain(c)).toBe('const a = 1;\nconst b = 2;');
  });

  it('maps a GFM table to table/row/cell blocks', () => {
    const [t] = only('| Name | Qty |\n| --- | --- |\n| Apples | **3** |');
    expect(t.type).toBe('table');
    expect(t.props?.header).toBe(true);
    expect(t.children?.map((r) => r.type)).toEqual(['row', 'row']);
    const cellText = (row: number, col: number) => plain(t.children?.[row].children?.[col]);
    expect([cellText(0, 0), cellText(0, 1)]).toEqual(['Name', 'Qty']);
    expect([cellText(1, 0), cellText(1, 1)]).toEqual(['Apples', '3']);
    expect(t.children?.[1].children?.[1].text?.[0].a).toEqual({b: true});
  });

  it('maps a thematic break to a divider', () => {
    expect(only('a\n\n---\n\nb').map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
  });
});

// ── Images (never dropped) ───────────────────────────────────────────────────

describe('markdownToBlocks — images', () => {
  it('turns a body image into a placeholder that preserves src + alt + title', () => {
    const blocks = only('![A diagram](https://ex.com/d.png "Figure 1")');
    expect(blocks).toHaveLength(1);
    const [img] = blocks;
    expect(img.type).toBe('callout');
    const asset = img.props?.[IMAGE_PLACEHOLDER_PROP] as Record<string, string>;
    expect(asset.ref).toBe('https://ex.com/d.png');
    expect(asset.alt).toBe('A diagram');
    expect(asset.title).toBe('Figure 1');
    // The placeholder is visible: alt label + a link run to the src.
    expect(plain(img)).toContain('A diagram');
    expect(img.text?.some((r) => r.a?.a === 'https://ex.com/d.png')).toBe(true);
  });

  it('keeps an inline image as a sibling placeholder after the paragraph', () => {
    const blocks = only('See ![chart](https://ex.com/c.png) here.');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'callout']);
    expect(plain(blocks[0])).toContain('See');
    expect(plain(blocks[0])).toContain('here.');
    expect((blocks[1].props?.[IMAGE_PLACEHOLDER_PROP] as Record<string, string>).ref).toBe('https://ex.com/c.png');
  });

  it('inlines an image inside a table cell as a link run (cells hold only text)', () => {
    const [t] = only('| Img |\n| --- |\n| ![pic](https://ex.com/p.png) |');
    const cell = t.children?.[1].children?.[0];
    expect(cell?.type).toBe('cell');
    expect(cell?.children).toBeUndefined();
    expect(cell?.text?.[0]).toEqual({t: 'pic', a: {a: 'https://ex.com/p.png'}});
  });
});

// ── Never silently drop ──────────────────────────────────────────────────────

describe('markdownToBlocks — never silently drop', () => {
  it('degrades a raw-HTML block to a paragraph rather than dropping it', () => {
    const blocks = only('Before\n\n<div class="note">keepme</div>\n\nAfter');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(plain(blocks[1])).toContain('keepme');
  });

  it('preserves every word across a mixed document', () => {
    const md = [
      '# Heading alpha',
      '',
      'Paragraph with **bravo** and [charlie](https://ex.com).',
      '',
      '- delta',
      '  - echo',
      '- [x] foxtrot',
      '',
      '> golf quote',
      '',
      '```py',
      'hotel = 1',
      '```',
      '',
      '| india | juliett |',
      '| --- | --- |',
      '| kilo | lima |',
      '',
      '![mike](https://ex.com/i.png)',
      '',
      '<custom-tag>november</custom-tag>',
    ].join('\n');
    const text = allText(markdownToBlocks(md));
    for (const word of [
      'alpha', 'bravo', 'charlie', 'https://ex.com', 'delta', 'echo', 'foxtrot',
      'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike',
      'https://ex.com/i.png', 'november',
    ]) {
      expect(text, `missing "${word}"`).toContain(word);
    }
  });
});

// ── Document + front-matter + title resolution ───────────────────────────────

describe('markdownToImportedDoc', () => {
  it('reads the title from front-matter and preserves the rest', () => {
    const doc = markdownToImportedDoc('---\ntitle: My Notes\nauthor: Ada\ntags: [a, b]\n---\n\n# Body head\n\ntext');
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].title).toBe('My Notes');
    const code = doc.pages[0].blocks[0];
    expect(code.type).toBe('code');
    expect(code.props?.language).toBe('yaml');
    expect(plain(code)).toContain('author: Ada');
    expect(plain(code)).toContain('tags: [a, b]');
    // The body heading survives (front-matter supplied the title, not the H1).
    expect(doc.pages[0].blocks.some((b) => b.type === 'heading' && plain(b) === 'Body head')).toBe(true);
  });

  it('promotes a leading heading to the title, consuming it from the body', () => {
    const doc = markdownToImportedDoc('# Real Title\n\nfirst para');
    expect(doc.pages[0].title).toBe('Real Title');
    expect(doc.pages[0].blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  it('lets opts.title override front-matter and the leading heading', () => {
    const doc = markdownToImportedDoc('---\ntitle: FM\n---\n# H1\n\nx', {title: 'Explicit'});
    expect(doc.pages[0].title).toBe('Explicit');
    // Heading kept, since the title came from opts, not the H1.
    expect(doc.pages[0].blocks.some((b) => b.type === 'heading')).toBe(true);
  });

  it('falls back to the default title when nothing else is available', () => {
    expect(markdownToImportedDoc('just a paragraph').pages[0].title).toBe('Imported document');
    expect(markdownToImportedDoc('x', {defaultTitle: 'Untitled'}).pages[0].title).toBe('Untitled');
  });
});

// ── Round-trip through importDoc ─────────────────────────────────────────────

/** Minimal recording client — just enough surface for importDoc's create path. */
function fakeClient(): {client: ImportWriteClient; pages: PageInput[]} {
  const pages: PageInput[] = [];
  let n = 0;
  const stored = (id: string, input?: Partial<StoredPage>): StoredPage => ({
    id,
    name: null,
    data: {editorjs: {blocks: []}, values: [], names: []},
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    deletedAt: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...input,
  });
  const client: ImportWriteClient = {
    savePage: (input) => {
      pages.push(input);
      return Promise.resolve(stored(`page_${++n}`, {name: input.name ?? null, data: input.data, parentId: input.parentId ?? null}));
    },
    setPageProperties: (id, properties) => Promise.resolve(stored(id, {properties})),
    createDatabase: () => Promise.reject(new Error('not used')),
    createRow: () => Promise.reject(new Error('not used')),
    importSpace: () => Promise.reject(new Error('not used')),
  };
  return {client, pages};
}

describe('markdownToImportedDoc → importDoc round-trip', () => {
  it('lands a single page via the create strategy with the parsed body', async () => {
    const md = '# Trip\n\nhello **world**\n\n- one\n- two';
    const doc = markdownToImportedDoc(md);
    const {client, pages} = fakeClient();

    const result = await importDoc(client, doc);

    expect(result.strategy).toBe('create');
    expect(result.pageIds).toEqual(['page_1']);
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('Trip');
    const landed = (pages[0].data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    expect(landed.map((b) => b.type)).toEqual(['paragraph', 'list', 'list']);
    expect(landed[0].text).toEqual([{t: 'hello '}, {t: 'world', a: {b: true}}]);
    // No content was lost on the way to the store.
    expect(allText(landed)).toContain('one');
    expect(allText(landed)).toContain('two');
  });
});
