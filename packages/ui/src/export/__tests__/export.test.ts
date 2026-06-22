import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {buildDocumentModel, parseInline, runsToText} from '../documentModel';
import {toMarkdown} from '../toMarkdown';
import {toHtml, toHtmlSite, toSlideDeck} from '../toHtml';
import {referencedPageIds, type SiteBundle} from '../exportSite';

const snapshot = (blocks: unknown[], values: Array<[string, unknown]> = [], names: Array<[string, string]> = []): PageSnapshot => ({
  editorjs: {blocks},
  values,
  names,
});

describe('parseInline', () => {
  it('parses bold/italic/code/marker and links', () => {
    const runs = parseInline('a <b>B</b> <i>I</i> <code>C</code> <mark>M</mark> <a href="http://x">L</a>');
    expect(runs.find((r) => r.bold)?.text).toBe('B');
    expect(runs.find((r) => r.italic)?.text).toBe('I');
    expect(runs.find((r) => r.code)?.text).toBe('C');
    expect(runs.find((r) => r.marker)?.text).toBe('M');
    expect(runs.find((r) => r.link)?.link).toBe('http://x');
  });

  it('parses an @-mention as an atomic run carrying the page id', () => {
    const runs = parseInline('see <a class="ob-mention" data-page-id="p1" contenteditable="false">📄 Roadmap</a> now');
    const mention = runs.find((r) => r.mention);
    expect(mention?.mention?.pageId).toBe('p1');
    expect(runsToText(runs)).toContain('Roadmap');
  });
});

describe('buildDocumentModel', () => {
  it('resolves reactive slider/expr values and chart series', () => {
    const model = buildDocumentModel({
      title: 'T',
      icon: '📄',
      snapshot: snapshot(
        [
          {id: 's1', type: 'slider', data: {name: 'months'}},
          {id: 'e1', type: 'expr', data: {name: 'growth', source: '1+1'}},
          {id: 'c1', type: 'chart', data: {refCellIds: ['k1']}},
        ],
        [
          ['s1', 120],
          ['e1', 2],
          ['k1', {series: [{name: 'a', data: [1, 2, 3]}]}],
        ],
        [['months', 's1']],
      ),
    });
    expect(model.blocks[0]).toMatchObject({type: 'slider', name: 'months', value: 120});
    expect(model.blocks[1]).toMatchObject({type: 'expr', name: 'growth', value: 2});
    expect(model.blocks[2]).toMatchObject({type: 'chart'});
    const chart = model.blocks[2] as {type: 'chart'; series: {name: string; data: number[]}[]};
    expect(chart.series[0]).toEqual({name: 'a', data: [1, 2, 3]});
  });

  it('parses headers, lists, quote, code, delimiter', () => {
    const model = buildDocumentModel({
      title: 'T',
      icon: '',
      snapshot: snapshot([
        {type: 'header', data: {text: 'Heading', level: 2}},
        {type: 'list', data: {style: 'ordered', items: ['one', 'two']}},
        {type: 'quote', data: {text: 'q', caption: 'me'}},
        {type: 'code', data: {code: 'x=1'}},
        {type: 'delimiter', data: {}},
      ]),
    });
    expect(model.blocks.map((b) => b.type)).toEqual(['header', 'list', 'quote', 'code', 'delimiter']);
    expect((model.blocks[0] as {level: number}).level).toBe(2);
  });
});

describe('toMarkdown', () => {
  it('renders a document with headings, lists, code, and reactive values', () => {
    const md = toMarkdown(
      buildDocumentModel({
        title: 'My Page',
        icon: '📄',
        snapshot: snapshot(
          [
            {type: 'header', data: {text: 'Intro', level: 2}},
            {type: 'paragraph', data: {text: 'hello <b>world</b>'}},
            {type: 'list', data: {style: 'unordered', items: ['a', 'b']}},
            {type: 'code', data: {code: 'const x = 1'}},
            {id: 's1', type: 'slider', data: {name: 'months'}},
          ],
          [['s1', 120]],
        ),
      }),
    );
    expect(md).toContain('# 📄 My Page');
    expect(md).toContain('## Intro');
    expect(md).toContain('hello **world**');
    expect(md).toContain('- a\n- b');
    expect(md).toContain('```\nconst x = 1\n```');
    expect(md).toContain('**months** = 120');
  });
});

describe('new block types', () => {
  const blocks = [
    {type: 'header', data: {text: 'Alpha', level: 2}},
    {type: 'toc', data: {}},
    {type: 'table', data: {withHeadings: true, content: [['Name', 'Age'], ['Ada', '36']]}},
    {type: 'callout', data: {variant: 'warning', text: 'Be <b>careful</b>'}},
    {type: 'accordion', data: {title: 'More', content: 'Hidden detail', open: false}},
    {type: 'checklist', data: {items: [{text: 'done', checked: true}, {text: 'todo', checked: false}]}},
    {type: 'button', data: {label: 'Open', url: 'https://example.com'}},
    {type: 'divider', data: {style: 'dashed'}},
    {type: 'header', data: {text: 'Beta', level: 3}},
  ];

  it('normalizes every new block (documentModel)', () => {
    const model = buildDocumentModel({title: 'T', icon: '', snapshot: snapshot(blocks)});
    const byType = Object.fromEntries(model.blocks.map((b) => [b.type, b]));

    expect((byType.table as {withHeadings: boolean; rows: unknown[][][]}).withHeadings).toBe(true);
    expect(runsToText((byType.table as {rows: import('../documentModel').InlineRun[][][]}).rows[1][0])).toBe('Ada');
    expect(byType.callout).toMatchObject({type: 'callout', variant: 'warning'});
    expect((byType.accordion as {open: boolean}).open).toBe(false);
    const checklist = byType.checklist as {items: {checked: boolean}[]};
    expect(checklist.items.map((i) => i.checked)).toEqual([true, false]);
    expect(byType.button).toMatchObject({label: 'Open', url: 'https://example.com'});
    expect(byType.divider).toMatchObject({style: 'dashed'});
    // ToC entries are filled from the document's headers (before and after it).
    expect((byType.toc as {entries: {text: string}[]}).entries.map((e) => e.text)).toEqual(['Alpha', 'Beta']);
  });

  it('renders every new block to Markdown', () => {
    const md = toMarkdown(buildDocumentModel({title: 'T', icon: '', snapshot: snapshot(blocks)}));
    expect(md).toContain('| Name | Age |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Ada | 36 |');
    expect(md).toContain('> [!warning]');
    expect(md).toContain('<details');
    expect(md).toContain('- [x] done');
    expect(md).toContain('- [ ] todo');
    expect(md).toContain('[Open](https://example.com)');
    expect(md).toMatch(/- Alpha[\s\S]*- Beta/); // ToC outline
  });

  it('renders every new block to interactive HTML', () => {
    const html = toHtml(snapshot(blocks), 'T', '');
    expect(html).toContain('<table class="block-table">');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>Ada</td>');
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('<details class="accordion"');
    expect(html).toContain('<ul class="checklist">');
    expect(html).toContain('type="checkbox" checked');
    expect(html).toContain('<a class="button" href="https://example.com"');
    expect(html).toContain('data-style="dashed"');
    expect(html).toContain('<nav class="toc">');
    expect(html).toContain('href="#h-0"'); // ToC links to the first heading anchor
    expect(html).toContain('id="h-0"');
  });
});

describe('referencedPageIds', () => {
  it('collects subpage/database block targets and inline mentions', () => {
    const ids = referencedPageIds(
      snapshot([
        {type: 'subpage', data: {kind: 'page', pageId: 'a'}},
        {type: 'database', data: {pageId: 'b'}},
        {type: 'paragraph', data: {text: 'x <a class="ob-mention" data-page-id="c">C</a> y'}},
      ]),
    );
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('toHtmlSite', () => {
  const bundle: SiteBundle = {
    rootId: 'root',
    pages: [
      {
        id: 'root',
        title: 'Home',
        icon: '🏠',
        snapshot: snapshot([
          {type: 'paragraph', data: {text: 'See <a class="ob-mention" data-page-id="child">📄 Child</a>'}},
          {type: 'subpage', data: {kind: 'page', pageId: 'child'}},
          {type: 'database', data: {pageId: 'dbhost'}},
        ]),
      },
      {id: 'child', title: 'Child', icon: '📄', snapshot: snapshot([{type: 'paragraph', data: {text: 'child body'}}])},
      {
        id: 'dbhost',
        title: 'Tasks',
        icon: '🗃️',
        snapshot: snapshot([]),
        database: {
          schema: {
            properties: [{id: 'p_status', name: 'Status', type: 'select', options: [{id: 's_done', label: 'Done', color: 'green'}]}],
            views: [{id: 'v', name: 'V', type: 'table', filters: [], sorts: []}],
          },
          rows: [{id: 'r1', name: 'Task one', properties: {p_status: 's_done'}, exports: {}, parentId: null, createdAt: '', updatedAt: ''}],
        },
      },
      {id: 'r1', title: 'Task one', icon: '📄', snapshot: snapshot([{type: 'paragraph', data: {text: 'row body'}}])},
    ],
  };
  const html = toHtmlSite(bundle);

  it('renders every page as a section, root visible and the rest hidden', () => {
    expect(html).toContain('data-root="root"');
    expect(html).toContain('<section class="page" data-page="root">');
    expect(html).toContain('<section class="page" data-page="child" hidden>');
    expect(html).toContain('<section class="page" data-page="r1" hidden>');
    expect(html).toContain('child body');
  });

  it('makes mentions and subpages navigate to their page', () => {
    expect(html).toContain('<a class="mention" href="#child" data-page-id="child">Child</a>');
    expect(html).toContain('class="subpage" href="#child" data-page-id="child"');
  });

  it('renders an inline/hosted database as a table of navigable rows', () => {
    expect(html).toContain('<table class="db-table">');
    expect(html).toContain('class="db-row" href="#r1" data-page-id="r1"');
    expect(html).toContain('Task one');
    expect(html).toContain('Done'); // the select option label as a tag
  });

  it('embeds the navigation runtime', () => {
    expect(html).toContain('hashchange');
    expect(html).toContain('id="ob-back"');
  });
});

describe('toSlideDeck', () => {
  it('splits blocks into one slide section per divider-delimited slide', () => {
    const html = toSlideDeck(
      snapshot([
        {id: 'h1', type: 'header', data: {text: 'Intro', level: 1}},
        {id: 'p1', type: 'paragraph', data: {text: 'Hello'}},
        {id: 'd1', type: 'divider', data: {}},
        {id: 'h2', type: 'header', data: {text: 'Second', level: 2}},
        {id: 'd2', type: 'divider', data: {}},
        {id: 'p2', type: 'paragraph', data: {text: 'Last'}},
      ]),
      'Deck',
      '📊',
    );
    expect(html.match(/class="slide"/g) ?? []).toHaveLength(3);
    expect(html).toContain('Intro');
    expect(html).toContain('Second');
    expect(html).toContain('Last');
    expect(html).toContain('Deck'); // title heads the first slide
    expect(html).toContain('deck-counter'); // slide-nav runtime present
  });

  it('keeps interactive widgets live (a slider seeds the reactive runtime)', () => {
    const html = toSlideDeck(
      snapshot(
        [
          {id: 's1', type: 'slider', data: {name: 'n', min: 0, max: 10, initial: 3}},
          {id: 'd', type: 'divider', data: {}},
          {id: 'p', type: 'paragraph', data: {text: 'x'}},
        ],
        [['s1', 3]],
        [['n', 's1']],
      ),
      'Deck',
      '',
    );
    expect(html.match(/class="slide"/g) ?? []).toHaveLength(2);
    expect(html).toContain('id="ob-data"'); // reactive runtime data seeded
  });
});
