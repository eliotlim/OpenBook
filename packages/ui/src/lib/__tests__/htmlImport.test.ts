import {describe, it, expect, vi} from 'vitest';
import {
  IMAGE_PLACEHOLDER_KIND,
  IMAGE_PLACEHOLDER_PROP,
  importDoc,
  type ImportedBlock,
  type ImportWriteClient,
} from '@book.dev/sdk';
import {htmlToImportedBlocks, htmlToImportedDoc} from '../htmlImport';
import {detectImportFormat, summarizeImportedDoc} from '../importContent';

/** The block types produced, top level, from an HTML string. */
const typesOf = (html: string): string[] => htmlToImportedBlocks(html).map((b) => b.type);

/** The concatenated plain text of a block's runs. */
const textOf = (b: ImportedBlock | undefined): string => (b?.text ?? []).map((r) => r.t).join('');

/** True when a block is an import image placeholder (carries the asset marker). */
const isImagePlaceholder = (b: ImportedBlock): boolean =>
  b.props?.[IMAGE_PLACEHOLDER_PROP] !== undefined &&
  (b.props[IMAGE_PLACEHOLDER_PROP] as {kind?: string}).kind === IMAGE_PLACEHOLDER_KIND;

describe('detectImportFormat (html)', () => {
  it('routes .html / .htm to the HTML parser', () => {
    for (const name of ['page.html', 'export.HTM', '/a/b/Notes.Html']) {
      expect(detectImportFormat(name)).toBe('html');
    }
  });
});

describe('htmlToImportedBlocks — the mapping corpus', () => {
  it('maps headings (clamped to 1–3), paragraphs, and inline emphasis + links to runs', () => {
    const blocks = htmlToImportedBlocks(
      '<h1>Big</h1><h4>Deep</h4><p>plain <strong>bold</strong> <em>it</em> <a href="https://x.y">link</a></p>',
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'heading', 'paragraph']);
    expect(blocks[0].props).toEqual({level: 1});
    // h4 clamps to the deepest heading level the editor renders (3).
    expect(blocks[1].props).toEqual({level: 3});
    expect(blocks[2].text).toEqual([
      {t: 'plain '},
      {t: 'bold', a: {b: true}},
      {t: ' '},
      {t: 'it', a: {i: true}},
      {t: ' '},
      {t: 'link', a: {a: 'https://x.y'}},
    ]);
  });

  it('flattens bullet, ordered, and task lists — including nested items', () => {
    const blocks = htmlToImportedBlocks(
      '<ul><li>one<ul><li>nested</li></ul></li><li><input type="checkbox" checked>done</li></ul>' +
        '<ol><li>first</li></ol>',
    );
    expect(blocks.map((b) => b.type)).toEqual(['list', 'list', 'todo', 'list']);
    expect(blocks[0].props).toEqual({kind: 'bullet'});
    expect(textOf(blocks[1])).toBe('nested');
    expect(blocks[2].props).toEqual({checked: true});
    expect(textOf(blocks[2])).toBe('done');
    expect(blocks[3].props).toEqual({kind: 'number'});
  });

  it('brings a table across whole as table → row → cell', () => {
    const blocks = htmlToImportedBlocks(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].props).toEqual({header: true});
    const rows = blocks[0].children ?? [];
    expect(rows.map((r) => r.type)).toEqual(['row', 'row']);
    expect(textOf(rows[1].children?.[1])).toBe('2');
  });

  it('maps <pre>/code to a code block and <hr> to a divider', () => {
    const blocks = htmlToImportedBlocks('<pre>const x = 1;\nconst y = 2;</pre><hr>');
    expect(blocks.map((b) => b.type)).toEqual(['code', 'divider']);
    // The editor's code block carries a plain string; the IR normalises it to runs.
    expect(blocks[0].text).toEqual([{t: 'const x = 1;\nconst y = 2;'}]);
  });

  it('maps a blockquote to a quote block', () => {
    const blocks = htmlToImportedBlocks('<blockquote>wise words</blockquote>');
    expect(blocks.map((b) => b.type)).toEqual(['quote']);
    expect(textOf(blocks[0])).toBe('wise words');
  });

  it('degrades an unknown element to a paragraph of its text — never dropped', () => {
    const blocks = htmlToImportedBlocks('<marquee>slidey <em>text</em></marquee>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toEqual([{t: 'slidey '}, {t: 'text', a: {i: true}}]);
  });

  it('skips <script>/<style> noise while keeping the real content', () => {
    const blocks = htmlToImportedBlocks('<style>.x{}</style><p>kept</p><script>evil()</script>');
    expect(typesOf('<style>.x{}</style><p>kept</p><script>evil()</script>')).toEqual(['paragraph']);
    expect(textOf(blocks[0])).toBe('kept');
  });
});

describe('htmlToImportedBlocks — images become placeholders, never dropped', () => {
  it('turns a standalone <img> into an image placeholder preserving src + alt', () => {
    const blocks = htmlToImportedBlocks('<img src="https://x/cat.png" alt="a cat">');
    expect(blocks).toHaveLength(1);
    expect(isImagePlaceholder(blocks[0])).toBe(true);
    const asset = blocks[0].props?.[IMAGE_PLACEHOLDER_PROP] as {ref: string; alt: string};
    expect(asset.ref).toBe('https://x/cat.png');
    expect(asset.alt).toBe('a cat');
  });

  it('keeps an image inside a paragraph as a following placeholder', () => {
    const blocks = htmlToImportedBlocks('<p>see <img src="/p.png" alt="pic"> here</p>');
    // The paragraph's text survives, and the image is not lost.
    expect(blocks[0].type).toBe('paragraph');
    expect(textOf(blocks[0])).toContain('see');
    expect(blocks.some(isImagePlaceholder)).toBe(true);
  });

  it('unwraps a <figure> into its image (+ caption)', () => {
    const blocks = htmlToImportedBlocks(
      '<figure><img src="/f.png" alt="fig"><figcaption>A caption</figcaption></figure>',
    );
    expect(blocks.some(isImagePlaceholder)).toBe(true);
    expect(blocks.some((b) => b.type === 'paragraph' && textOf(b) === 'A caption')).toBe(true);
  });

  it('keeps an image inside a list item', () => {
    const blocks = htmlToImportedBlocks('<ul><li>item <img src="/li.png" alt="in-list"></li></ul>');
    expect(blocks[0].type).toBe('list');
    expect(blocks.some(isImagePlaceholder)).toBe(true);
  });

  it('does not drop an image inside a table cell', () => {
    const blocks = htmlToImportedBlocks('<table><tr><td><img src="/c.png" alt="in-cell"></td></tr></table>');
    expect(blocks.some((b) => b.type === 'table')).toBe(true);
    expect(blocks.some(isImagePlaceholder)).toBe(true);
  });

  it('does not drop an image inside a <pre> block', () => {
    const blocks = htmlToImportedBlocks('<pre>code<img src="/pre.png" alt="in-pre"></pre>');
    expect(blocks.some((b) => b.type === 'code')).toBe(true);
    expect(blocks.some(isImagePlaceholder)).toBe(true);
  });

  it('counts every image placeholder in the honest summary', () => {
    const doc = htmlToImportedDoc('<h1>Gallery</h1><img src="/a.png"><p>x <img src="/b.png"></p>');
    expect(summarizeImportedDoc(doc).images).toBe(2);
  });
});

describe('htmlToImportedDoc — title derivation', () => {
  it('takes the page title from <title>', () => {
    const doc = htmlToImportedDoc('<html><head><title>From Title</title></head><body><h1>Heading</h1><p>x</p></body></html>');
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].title).toBe('From Title');
    // <title> was used, so the leading <h1> stays in the body.
    expect(doc.pages[0].blocks[0].type).toBe('heading');
  });

  it('promotes and consumes a leading <h1> when there is no <title>', () => {
    const doc = htmlToImportedDoc('<h1>The Heading</h1><p>body</p>');
    expect(doc.pages[0].title).toBe('The Heading');
    expect(doc.pages[0].blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  it('does NOT promote a leading <h2>/<h3> (only <h1>) — the heading stays in the body', () => {
    const doc = htmlToImportedDoc('<h2>Section</h2><p>body</p>', {defaultTitle: 'Fallback'});
    expect(doc.pages[0].title).toBe('Fallback');
    expect(doc.pages[0].blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
  });

  it('falls back to defaultTitle, then to a built-in, when nothing is derivable', () => {
    expect(htmlToImportedDoc('<p>only body</p>', {defaultTitle: 'My File'}).pages[0].title).toBe('My File');
    expect(htmlToImportedDoc('<p>only body</p>').pages[0].title).toBe('Imported document');
  });

  it('lets an explicit title override <title> and the heading', () => {
    const doc = htmlToImportedDoc('<title>ignored</title><h1>also ignored</h1>', {title: 'Explicit'});
    expect(doc.pages[0].title).toBe('Explicit');
  });
});

/** A fake {@link ImportWriteClient} recording the writer calls (mirrors importContent.test). */
function fakeClient() {
  const calls = {savePage: 0, createDatabase: 0, createRow: 0, importLibrary: 0, setPageProperties: 0};
  const client: ImportWriteClient = {
    savePage: vi.fn(async (input: {name?: string | null; data?: unknown}) => {
      calls.savePage += 1;
      return {id: `p${calls.savePage}`, name: input.name ?? null, data: input.data} as never;
    }),
    setPageProperties: vi.fn(async () => {
      calls.setPageProperties += 1;
    }) as never,
    createDatabase: vi.fn(async () => {
      calls.createDatabase += 1;
      return {id: `d${calls.createDatabase}`} as never;
    }),
    createRow: vi.fn(async () => {
      calls.createRow += 1;
      return {id: `r${calls.createRow}`} as never;
    }) as never,
    importLibrary: vi.fn(async () => {
      calls.importLibrary += 1;
      return {created: 1, overwritten: 0, renamed: 0, idMap: {imp_1: 'np1'}} as never;
    }),
  };
  return {client, calls};
}

describe('importDoc round-trip (HTML → IR → data path)', () => {
  it('lands a lone HTML page through the create writer (Strategy A)', async () => {
    const {client, calls} = fakeClient();
    const doc = htmlToImportedDoc('<h1>Solo</h1><p>hello <strong>world</strong></p><img src="/x.png" alt="x">');
    const result = await importDoc(client, doc);

    expect(result.strategy).toBe('create');
    expect(calls.savePage).toBe(1);
    expect(calls.importLibrary).toBe(0);
    expect(result.pageIds).toEqual(['p1']);

    // The saved snapshot carries the imported blocks (paragraph + image placeholder).
    const saved = (client.savePage as unknown as {mock: {calls: [{data: {blockdoc: {blocks: ImportedBlock[]}}}][]}}).mock
      .calls[0][0];
    const savedBlocks = saved.data.blockdoc.blocks;
    expect(savedBlocks.some((b) => b.type === 'paragraph')).toBe(true);
    expect(savedBlocks.some(isImagePlaceholder)).toBe(true);
  });
});
