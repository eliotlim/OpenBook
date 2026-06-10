import {describe, expect, it} from 'vitest';
import {createDoc, docToJSON, makeTable} from '../../blockeditor/model';
import {blocksToHtml, blocksToMarkdown} from '../../blockeditor/exportBlocks';

const sample = () =>
  docToJSON(
    createDoc([
      {type: 'heading', text: 'Title', props: {level: 1}},
      {type: 'paragraph', text: [{t: 'plain '}, {t: 'bold', a: {b: true}}, {t: ' and '}, {t: 'link', a: {a: 'https://x.y'}}]},
      {type: 'list', text: 'one', props: {kind: 'number'}},
      {type: 'list', text: 'two', props: {kind: 'number'}},
      {type: 'list', text: 'loose', props: {kind: 'bullet'}},
      {type: 'todo', text: 'done it', props: {checked: true}},
      {type: 'quote', text: 'wise words'},
      {type: 'code', text: 'const x = 1;', props: {language: 'js'}},
      {type: 'divider'},
      {
        type: 'columns',
        children: [
          {type: 'column', children: [{type: 'paragraph', text: 'left'}]},
          {type: 'column', children: [{type: 'paragraph', text: 'right'}]},
        ],
      },
      makeTable(2, 2),
    ]),
  );

describe('blocksToMarkdown', () => {
  it('renders every core block type', () => {
    const md = blocksToMarkdown(sample());
    expect(md).toContain('# Title');
    expect(md).toContain('**bold**');
    expect(md).toContain('[link](https://x.y)');
    expect(md).toContain('1. one');
    expect(md).toContain('2. two');
    expect(md).toContain('- loose');
    expect(md).toContain('- [x] done it');
    expect(md).toContain('> wise words');
    expect(md).toContain('```js\nconst x = 1;\n```');
    expect(md).toContain('---');
    expect(md).toContain('left');
    expect(md).toContain('right');
    expect(md).toMatch(/\| {2}\| {2}\|/); // 2×2 empty table row
  });

  it('restarts numbered lists after a break', () => {
    const md = blocksToMarkdown(
      docToJSON(
        createDoc([
          {type: 'list', text: 'a', props: {kind: 'number'}},
          {type: 'paragraph', text: 'break'},
          {type: 'list', text: 'b', props: {kind: 'number'}},
        ]),
      ),
    );
    expect(md).toContain('1. a');
    expect(md).toContain('1. b');
    expect(md).not.toContain('2. b');
  });
});

describe('blocksToHtml', () => {
  it('renders semantic HTML with joined lists and column flex', () => {
    const html = blocksToHtml(sample());
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://x.y">link</a>');
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(html).toContain('<ul><li>loose</li></ul>');
    expect(html).toContain('checked');
    expect(html).toContain('<blockquote>wise words</blockquote>');
    expect(html).toContain('<pre><code>const x = 1;</code></pre>');
    expect(html).toContain('<hr>');
    expect(html).toContain('display:flex');
    expect(html).toContain('<table');
  });

  it('escapes HTML in text content', () => {
    const html = blocksToHtml(docToJSON(createDoc([{type: 'paragraph', text: '<script>alert(1)</script>'}])));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
