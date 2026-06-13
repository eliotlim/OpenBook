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

describe('blocksToEditorJs (export pipeline adapter)', () => {
  it('projects core blocks, merging lists and flattening columns', async () => {
    const {blocksToEditorJs} = await import('../../blockeditor/exportBlocks');
    const out = blocksToEditorJs(
      docToJSON(
        createDoc([
          {type: 'heading', text: 'T', props: {level: 1}},
          {type: 'list', text: 'a', props: {kind: 'bullet'}},
          {type: 'list', text: 'b', props: {kind: 'bullet'}},
          {type: 'todo', text: 'do', props: {checked: true}},
          {
            type: 'columns',
            children: [
              {type: 'column', children: [{type: 'paragraph', text: 'left'}]},
              {type: 'column', children: [{type: 'paragraph', text: 'right'}]},
            ],
          },
        ]),
      ),
    );
    expect(out.blocks.map((b) => b.type)).toEqual(['header', 'list', 'checklist', 'paragraph', 'paragraph']);
    expect(out.blocks[1].data.items).toEqual(['a', 'b']);
    expect(out.blocks[2].data.items).toEqual([{text: 'do', checked: true}]);
  });

  it('re-tokenizes formula sources and exports slider state', async () => {
    const {blocksToEditorJs} = await import('../../blockeditor/exportBlocks');
    const doc = createDoc([
      {type: 'slider', props: {name: 'speed', value: 8, min: 0, max: 10}, id: 'sl1'},
      {type: 'formula', props: {source: 'speed * speed'}, id: 'f1'},
    ]);
    const out = blocksToEditorJs(docToJSON(doc));
    expect(out.blocks[0]).toMatchObject({type: 'slider', data: {name: 'speed', initial: 8}});
    expect(out.values).toEqual([[out.blocks[0].id, 8]]);
    expect(out.names).toEqual([['speed', out.blocks[0].id]]);
    expect(out.blocks[1].data.source).toBe(`__C__{${out.blocks[0].id}}__ * __C__{${out.blocks[0].id}}__`);
  });

  it('exports an inline database (dbview) as a link to its page', () => {
    const json = docToJSON(createDoc([{type: 'dbview', props: {pageId: 'db-7', name: 'Tasks'}}]));
    const html = blocksToHtml(json);
    expect(html).toContain('data-page-id="db-7"');
    expect(html).toContain('Tasks');
    expect(blocksToMarkdown(json)).toContain('Tasks');
  });

  it('blockSnapshotToEditorJs projects stamped snapshots and passes others through', async () => {
    const {blockSnapshotToEditorJs} = await import('../../blockeditor/exportBlocks');
    const {encodeSnapshot} = await import('../../blockeditor/model');
    const doc = createDoc([{type: 'paragraph', text: 'hello'}]);
    const stamped = {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)};
    const projected = blockSnapshotToEditorJs(stamped) as {editorjs: {blocks: {type: string}[]}};
    expect(projected.editorjs.blocks[0].type).toBe('paragraph');

    const legacy = {editorjs: {blocks: [{type: 'header', data: {text: 'x'}}]}, values: [], names: [], editor: undefined};
    expect(blockSnapshotToEditorJs(legacy)).toBe(legacy);
  });
});
