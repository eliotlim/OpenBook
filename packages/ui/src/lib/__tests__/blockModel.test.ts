import {describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {
  createDoc,
  decodeSnapshot,
  docToJSON,
  dropBeside,
  encodeSnapshot,
  insertBlock,
  makeTable,
  mergeWithPrevious,
  migrateEditorJs,
  moveBlock,
  removeBlock,
  rootBlocks,
  splitBlock,
  tableDeleteColumn,
  tableInsertColumn,
  tableInsertRow,
  turnInto,
} from '../../blockeditor/model';

const types = (doc: Y.Doc): string[] => docToJSON(doc).map((b) => b.type);
const texts = (doc: Y.Doc): string[] => docToJSON(doc).map((b) => (b.text ?? []).map((r) => r.t).join(''));

describe('block model basics', () => {
  it('creates a doc with one empty paragraph', () => {
    const doc = createDoc();
    expect(types(doc)).toEqual(['paragraph']);
  });

  it('splits a block carrying the tail text and formatting', () => {
    const doc = createDoc([{type: 'paragraph', text: [{t: 'hello '}, {t: 'bold', a: {b: true}}]}]);
    const id = docToJSON(doc)[0].id;
    splitBlock(doc, id, 6);
    const json = docToJSON(doc);
    expect(json).toHaveLength(2);
    expect(json[0].text![0].t).toBe('hello ');
    expect(json[1].text![0]).toEqual({t: 'bold', a: {b: true}});
  });

  it('splitting a list item continues the list', () => {
    const doc = createDoc([{type: 'list', text: 'ab', props: {kind: 'number'}}]);
    splitBlock(doc, docToJSON(doc)[0].id, 1);
    const json = docToJSON(doc);
    expect(json.map((b) => b.type)).toEqual(['list', 'list']);
    expect(json[1].props).toEqual({kind: 'number'});
  });

  it('merges into the previous block and reports the caret offset', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'one'},
      {type: 'paragraph', text: [{t: 'two', a: {i: true}}]},
    ]);
    const second = docToJSON(doc)[1].id;
    const result = mergeWithPrevious(doc, second)!;
    expect(result.offset).toBe(3);
    const json = docToJSON(doc);
    expect(json).toHaveLength(1);
    expect(json[0].text).toEqual([{t: 'one'}, {t: 'two', a: {i: true}}]);
  });

  it('removing the last block leaves an empty paragraph', () => {
    const doc = createDoc([{type: 'heading', text: 'x', props: {level: 1}}]);
    removeBlock(doc, docToJSON(doc)[0].id);
    expect(types(doc)).toEqual(['paragraph']);
  });

  it('turnInto converts type in place and keeps text', () => {
    const doc = createDoc([{type: 'paragraph', text: 'task'}]);
    turnInto(doc, docToJSON(doc)[0].id, 'todo');
    const json = docToJSON(doc);
    expect(json[0].type).toBe('todo');
    expect(json[0].text![0].t).toBe('task');
  });

  it('moveBlock reorders within the root list', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
      {type: 'paragraph', text: 'c'},
    ]);
    moveBlock(doc, docToJSON(doc)[2].id, null, 0);
    expect(texts(doc)).toEqual(['c', 'a', 'b']);
    moveBlock(doc, docToJSON(doc)[0].id, null, 3);
    expect(texts(doc)).toEqual(['a', 'b', 'c']);
  });
});

describe('column layouts', () => {
  const seed = () =>
    createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
      {type: 'paragraph', text: 'c'},
    ]);

  it('dropBeside wraps two blocks into a 2-column layout', () => {
    const doc = seed();
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right');
    const json = docToJSON(doc);
    expect(json.map((x) => x.type)).toEqual(['columns', 'paragraph']);
    const cols = json[0].children!;
    expect(cols).toHaveLength(2);
    expect(cols[0].children![0].text![0].t).toBe('a');
    expect(cols[1].children![0].text![0].t).toBe('b');
  });

  it('dropping beside a column child grows the layout to 3 then 4 columns, capped', () => {
    const doc = seed();
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right'); // 2 cols (a | b)
    let cols = docToJSON(doc)[0].children!;
    const c = docToJSON(doc)[1];
    dropBeside(doc, c.id, cols[1].children![0].id, 'right'); // 3 cols
    cols = docToJSON(doc)[0].children!;
    expect(cols).toHaveLength(3);

    insertBlock(doc, rootBlocks(doc), 1, {type: 'paragraph', text: 'd'});
    const d = docToJSON(doc)[1];
    dropBeside(doc, d.id, cols[0].children![0].id, 'left'); // 4 cols
    cols = docToJSON(doc)[0].children!;
    expect(cols).toHaveLength(4);
    expect(cols[0].children![0].text![0].t).toBe('d');

    insertBlock(doc, rootBlocks(doc), 1, {type: 'paragraph', text: 'e'});
    const e = docToJSON(doc)[1];
    dropBeside(doc, e.id, cols[0].children![0].id, 'left'); // capped at 4
    expect(docToJSON(doc)[0].children!).toHaveLength(4);
  });

  it('moving the last block out of a column unwraps the layout', () => {
    const doc = seed();
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right');
    const movedOut = docToJSON(doc)[0].children![1].children![0].id;
    moveBlock(doc, movedOut, null, 1);
    // One column left → layout unwraps back to plain blocks.
    expect(types(doc)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(texts(doc)).toEqual(['a', 'b', 'c']);
  });

  it('refuses to drop a layout into itself', () => {
    const doc = seed();
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right');
    const layout = docToJSON(doc)[0];
    const innerTarget = layout.children![0].id;
    moveBlock(doc, layout.id, innerTarget, 0); // would nest the layout in its own column
    expect(docToJSON(doc)[0].type).toBe('columns'); // unchanged, no crash
  });
});

describe('tables', () => {
  it('builds, grows, and shrinks a table', () => {
    const doc = createDoc([makeTable(2, 2)]);
    const id = docToJSON(doc)[0].id;
    tableInsertRow(doc, id, 2);
    tableInsertColumn(doc, id, 0);
    let json = docToJSON(doc)[0];
    expect(json.children).toHaveLength(3);
    expect(json.children![0].children).toHaveLength(3);

    tableDeleteColumn(doc, id, 0);
    json = docToJSON(doc)[0];
    expect(json.children![0].children).toHaveLength(2);
  });

  it('deleting the last column removes the table entirely', () => {
    const doc = createDoc([makeTable(1, 1)]);
    const id = docToJSON(doc)[0].id;
    tableDeleteColumn(doc, id, 0);
    expect(types(doc)).toEqual(['paragraph']);
  });
});

describe('snapshots and CRDT merge', () => {
  it('round-trips through encode/decode preserving formatting', () => {
    const doc = createDoc([
      {type: 'heading', text: 'Title', props: {level: 1}},
      {type: 'paragraph', text: [{t: 'plain '}, {t: 'bold', a: {b: true}}]},
    ]);
    const restored = decodeSnapshot(encodeSnapshot(doc));
    expect(docToJSON(restored)).toEqual(docToJSON(doc));
  });

  it('decodeSnapshot falls back to the JSON projection', () => {
    const doc = createDoc([{type: 'paragraph', text: 'kept'}]);
    const snap = encodeSnapshot(doc);
    const restored = decodeSnapshot({...snap, update: 'not-base64!!'});
    expect(texts(restored)).toEqual(['kept']);
  });

  it('merges concurrent edits from two replicas', () => {
    const a = createDoc([{type: 'paragraph', text: 'shared'}]);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Replica A appends a block; replica B edits the paragraph text.
    insertBlock(a, rootBlocks(a), 1, {type: 'paragraph', text: 'from A'});
    const bText = rootBlocks(b).get(0).get('text') as Y.Text;
    bText.insert(6, ' doc');

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(docToJSON(a)).toEqual(docToJSON(b));
    expect(texts(a)).toEqual(['shared doc', 'from A']);
  });
});

describe('editorjs migration', () => {
  it('converts the common block types', () => {
    const blocks = migrateEditorJs([
      {type: 'header', data: {text: 'Hi', level: 2}},
      {type: 'paragraph', data: {text: 'a <b>b</b> <a href="https://x.y">c</a>'}},
      {type: 'list', data: {style: 'ordered', items: ['one', 'two']}},
      {type: 'checklist', data: {items: [{text: 'do', checked: true}]}},
      {type: 'table', data: {withHeadings: true, content: [['A', 'B'], ['1', '2']]}},
      {type: 'delimiter', data: {}},
      {type: 'mystery', data: {text: 'kept'}},
    ]);
    const doc = createDoc(blocks);
    const json = docToJSON(doc);
    expect(json.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'todo',
      'table',
      'divider',
      'paragraph',
    ]);
    expect(json[1].text).toEqual([{t: 'a '}, {t: 'b', a: {b: true}}, {t: ' '}, {t: 'c', a: {a: 'https://x.y'}}]);
    expect(json[4].props).toEqual({checked: true});
    expect(json[5].children![1].children![1].text![0].t).toBe('2');
  });

  it('never returns an empty document', () => {
    expect(migrateEditorJs([])).toEqual([{type: 'paragraph'}]);
  });
});

describe('editorjs migration — full app coverage', () => {
  it('migrates reactive, navigation, and layout-adjacent blocks', () => {
    const blocks = migrateEditorJs(
      [
        {type: 'toc', data: {}},
        {type: 'accordion', data: {title: 'More', content: 'Hidden <b>body</b>'}},
        {type: 'button', data: {label: 'Visit', url: 'https://x.y'}},
        {type: 'subpage', data: {kind: 'page', pageId: 'pg-1'}},
        {type: 'database', data: {pageId: 'pg-db'}},
        {type: 'slider', data: {cellId: 'c1', name: 'speed', min: 0, max: 10, initial: 3}},
        {type: 'expr', data: {name: 'out', source: '__C__{c1}__ * 2 + @speed'}},
        {type: 'chart', data: {refCellIds: ['c9']}},
      ],
      {values: [['c1', 7]], names: [['speed', 'c1']]},
    );
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'slider', 'formula', 'callout']);
    // toc skipped; accordion → heading + paragraph with formatting kept
    expect(blocks[1].text).toEqual([{t: 'Hidden '}, {t: 'body', a: {b: true}}]);
    // button keeps its link; subpage/database survive as mention runs
    expect(blocks[2].text).toEqual([{t: 'Visit', a: {a: 'https://x.y'}}]);
    expect((blocks[3].text as {a?: {m?: string}}[])[0].a?.m).toBe('pg-1');
    expect((blocks[4].text as {a?: {m?: string}}[])[0].a?.m).toBe('pg-db');
    // slider carries the LIVE value (7), not the stale initial (3)
    expect(blocks[5].props).toMatchObject({name: 'speed', min: 0, max: 10, value: 7});
    // expr tokens and @refs resolve to plain names
    expect(blocks[6].props).toEqual({source: 'speed * 2 + speed'});
    // chart leaves an honest marker
    expect(blocks[7].props).toMatchObject({variant: 'warn'});
  });
});

describe('htmlToBlocks (clipboard import)', () => {
  it('imports headings, lists, todos, quotes, code, tables, and inline marks', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks(
      '<h2>Title</h2>' +
        '<p>plain <strong>bold</strong> <a href="https://x.y">link</a></p>' +
        '<ul><li>one</li><li><input type="checkbox" checked>done item</li></ul>' +
        '<ol><li>first</li></ol>' +
        '<blockquote>wise</blockquote>' +
        '<pre>const x = 1;</pre>' +
        '<hr>' +
        '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'todo',
      'list',
      'quote',
      'code',
      'divider',
      'table',
    ]);
    expect(blocks[1].text).toEqual([{t: 'plain '}, {t: 'bold', a: {b: true}}, {t: ' '}, {t: 'link', a: {a: 'https://x.y'}}]);
    expect(blocks[3].props).toEqual({checked: true});
    expect(blocks[4].props).toEqual({kind: 'number'});
    expect(blocks[8].props).toEqual({header: true});
    expect((blocks[8].children?.[1].children?.[1] as {text: {t: string}[]}).text[0].t).toBe('2');
  });

  it('degrades unknown markup to paragraphs and skips scripts', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks('<script>evil()</script><span>loose <em>text</em></span>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toEqual([{t: 'loose '}, {t: 'text', a: {i: true}}]);
  });
});
