import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@open-book/sdk';
import {buildDocumentModel, parseInline, runsToText} from '../documentModel';
import {toMarkdown} from '../toMarkdown';

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
