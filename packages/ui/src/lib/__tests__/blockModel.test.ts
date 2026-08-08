import {describe, expect, it} from 'vitest';
import * as Y from 'yjs';
import {
  blockType,
  createDoc,
  decodeSnapshot,
  docToJSON,
  dropBeside,
  enclosingBlock,
  encodeSnapshot,
  insertBlock,
  makeTable,
  mergeWithPrevious,
  migrateLegacyBlocks,
  moveBlock,
  moveBlocks,
  orderedTopMost,
  type NewBlock,
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

describe('moveBlocks (multi-block move)', () => {
  const five = () =>
    createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
      {type: 'paragraph', text: 'c'},
      {type: 'paragraph', text: 'd'},
      {type: 'paragraph', text: 'e'},
    ]);
  const ids = (doc: Y.Doc): Record<string, string> =>
    Object.fromEntries(docToJSON(doc).map((b) => [(b.text ?? []).map((r) => r.t).join(''), b.id]));

  it('moves an adjacent selection forward, preserving order (toIndex is a current-doc index)', () => {
    const doc = five();
    const {a, b} = ids(doc);
    // Select a,b; drop below d (d.index 3 → below ⇒ toIndex 4).
    moveBlocks(doc, [a, b], null, 4);
    expect(texts(doc)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('moves a selection backward, preserving order', () => {
    const doc = five();
    const {d, e} = ids(doc);
    // Select d,e; drop above b (b.index 1 → above ⇒ toIndex 1).
    moveBlocks(doc, [d, e], null, 1);
    expect(texts(doc)).toEqual(['a', 'd', 'e', 'b', 'c']);
  });

  it('gathers a NON-contiguous selection contiguously at the drop point', () => {
    const doc = five();
    const {a, c} = ids(doc);
    // Select a,c; drop below e (e.index 4 → below ⇒ toIndex 5).
    moveBlocks(doc, [a, c], null, 5);
    expect(texts(doc)).toEqual(['b', 'd', 'e', 'a', 'c']);
  });

  it('passes ids in any order but always lands in document order', () => {
    const doc = five();
    const {a, b, c} = ids(doc);
    moveBlocks(doc, [c, a, b], null, 5); // reversed / shuffled input
    expect(texts(doc)).toEqual(['d', 'e', 'a', 'b', 'c']);
  });

  it('one undo restores everything (single transaction)', () => {
    const doc = five();
    const undo = new Y.UndoManager(rootBlocks(doc), {trackedOrigins: new Set(['local'])});
    const {a, b} = ids(doc);
    moveBlocks(doc, [a, b], null, 4);
    expect(texts(doc)).toEqual(['c', 'd', 'a', 'b', 'e']);
    undo.undo();
    expect(texts(doc)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('orderedTopMost dedupes descendants to the top-most, in document order', () => {
    const doc = five();
    const {a, b} = ids(doc);
    dropBeside(doc, b, a, 'right'); // wraps a|b into a columns layout at index 0
    const columns = docToJSON(doc)[0];
    const innerA = columns.children![0].children![0].id;
    // The columns block plus one of its descendants collapses to just columns.
    expect(orderedTopMost(doc, [innerA, columns.id])).toEqual([columns.id]);
  });

  it('moving a selection that includes a descendant does not duplicate the child', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
      {type: 'paragraph', text: 'c'},
    ]);
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right'); // root: [columns(a|b), c]
    const columns = docToJSON(doc)[0];
    const innerA = columns.children![0].children![0].id;
    // Select columns AND its descendant a; drop below c (c.index 1 → toIndex 2).
    moveBlocks(doc, [columns.id, innerA], null, 2);
    const json = docToJSON(doc);
    expect(json.map((x) => x.type)).toEqual(['paragraph', 'columns']);
    expect(json[0].text![0].t).toBe('c');
    // a survives exactly once, still inside the columns layout.
    const cols = json[1].children!;
    expect(cols[0].children![0].text![0].t).toBe('a');
    expect(cols[1].children![0].text![0].t).toBe('b');
  });

  it('moves selected blocks into a column', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
      {type: 'paragraph', text: 'c'},
    ]);
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right'); // root: [columns(a|b), c]
    const col0 = docToJSON(doc)[0].children![0].id;
    const c = docToJSON(doc)[1].id;
    moveBlocks(doc, [c], col0, 1); // into column 0, after a
    const cols = docToJSON(doc)[0].children!;
    expect(cols[0].children!.map((x) => x.text![0].t)).toEqual(['a', 'c']);
    expect(cols[1].children!.map((x) => x.text![0].t)).toEqual(['b']);
    expect(docToJSON(doc)).toHaveLength(1); // c left the root
  });

  it('refuses to drop a container into its own subtree (whole move is a no-op)', () => {
    const doc = createDoc([
      {type: 'paragraph', text: 'a'},
      {type: 'paragraph', text: 'b'},
    ]);
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right');
    const columns = docToJSON(doc)[0];
    const col0 = columns.children![0].id;
    moveBlocks(doc, [columns.id], col0, 0); // would nest columns in its own column
    expect(docToJSON(doc)[0].type).toBe('columns'); // unchanged, no crash
    expect(docToJSON(doc)[0].children).toHaveLength(2);
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

  it('grows a columns layout column-by-column on side-drops, capped at 6', () => {
    const doc = seed();
    const [a, b] = docToJSON(doc);
    dropBeside(doc, b.id, a.id, 'right'); // 2 cols (a | b)
    let cols = docToJSON(doc)[0].children!;
    const c = docToJSON(doc)[1];
    dropBeside(doc, c.id, cols[1].children![0].id, 'right'); // 3 cols
    expect(docToJSON(doc)[0].children!).toHaveLength(3);

    // Keep dropping fresh blocks beside a column child → 4, 5, 6 columns.
    for (let n = 4; n <= 6; n += 1) {
      insertBlock(doc, rootBlocks(doc), 1, {type: 'paragraph', text: `x${n}`});
      const fresh = docToJSON(doc)[1];
      cols = docToJSON(doc)[0].children!;
      dropBeside(doc, fresh.id, cols[0].children![0].id, 'left');
      expect(docToJSON(doc)[0].children!).toHaveLength(n);
    }

    // Capped: a 7th side-drop is a no-op (the block stays at the root).
    insertBlock(doc, rootBlocks(doc), 1, {type: 'paragraph', text: 'cap'});
    const extra = docToJSON(doc)[1];
    cols = docToJSON(doc)[0].children!;
    dropBeside(doc, extra.id, cols[0].children![0].id, 'left');
    expect(docToJSON(doc)[0].children!).toHaveLength(6);

    // Spans are redistributed evenly and always sum to the 12-unit grid.
    const spans = docToJSON(doc)[0].children!.map((col) => (col.props?.span as number) ?? 0);
    expect(spans.reduce((sum, v) => sum + v, 0)).toBe(12);
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

describe('legacy migration', () => {
  it('converts the common block types', () => {
    const blocks = migrateLegacyBlocks([
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
    expect(migrateLegacyBlocks([])).toEqual([{type: 'paragraph'}]);
  });
});

describe('block-native creators (sdk textSnapshot) open without the migrator', () => {
  it('decodes the created blockdoc straight through decodeSnapshot — never migrateLegacyBlocks', async () => {
    const {textSnapshot} = await import('@book.dev/sdk');
    const snap = textSnapshot('Alpha\nBeta', 'agent');
    // BlockPageDocument's load path takes `decodeSnapshot(snap.blockdoc)` whenever a
    // blockdoc is present; the migrator only runs for legacy snapshots lacking one.
    expect(snap.blockdoc).toBeTruthy();
    const json = docToJSON(decodeSnapshot(snap.blockdoc as never));
    expect(json.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(json.map((b) => b.text?.[0]?.t)).toEqual(['Alpha', 'Beta']);
  });
});

describe('legacy migration — full app coverage', () => {
  it('migrates reactive, navigation, and layout-adjacent blocks', () => {
    const blocks = migrateLegacyBlocks(
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
    expect(types).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'dbview', 'slider', 'formula', 'callout']);
    // toc skipped; accordion → heading + paragraph with formatting kept
    expect(blocks[1].text).toEqual([{t: 'Hidden '}, {t: 'body', a: {b: true}}]);
    // button keeps its link; a subpage survives as a mention run; an inline
    // database becomes a live embedded view (dbview block).
    expect(blocks[2].text).toEqual([{t: 'Visit', a: {a: 'https://x.y'}}]);
    expect((blocks[3].text as {a?: {m?: string}}[])[0].a?.m).toBe('pg-1');
    expect((blocks[4] as {props?: {pageId?: string}}).props?.pageId).toBe('pg-db');
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
    expect(blocks[8].props).toMatchObject({header: true}); // + col:* order-key registry (TBL-1)
    expect((blocks[8].children?.[1].children?.[1] as {text: {t: string}[]}).text[0].t).toBe('2');
  });

  it('degrades unknown markup to paragraphs and skips scripts', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks('<script>evil()</script><span>loose <em>text</em></span>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toEqual([{t: 'loose '}, {t: 'text', a: {i: true}}]);
  });

  it('folds a rich <figure>/<figcaption> to ONE rich paragraph on the paste path (no onImage)', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    // Without an `onImage` hook (clipboard paste), a figure must NOT explode into
    // separate paragraphs — its caption stays one rich paragraph, markup intact.
    const blocks = htmlToBlocks('<figure><img src="/p.png"><figcaption>A <strong>bold</strong> cap</figcaption></figure>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toEqual([{t: 'A '}, {t: 'bold', a: {b: true}}, {t: ' cap'}]);
  });
});

// The shape of a Notion clipboard table: nested tables inside cells, colspan/
// rowspan, spacer/ragged/empty rows. Each must normalize to a rectangular
// table → row → cell tree so render never throws (the v3.3.2 white-screen bug).
describe('htmlToBlocks — Notion-shaped table normalization', () => {
  // Read a parsed table block back as a plain grid of joined cell text.
  const cellText = (text: NewBlock['text']): string =>
    Array.isArray(text) ? text.map((r) => r.t).join('') : (text ?? '');
  const grid = (block: NewBlock): string[][] =>
    (block.children ?? []).map((row) => (row.children ?? []).map((cell) => cellText(cell.text)));

  it('scopes to direct rows/cells — a table nested in a cell is flattened, not spliced into the outer grid', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks(
      '<table><tbody>' +
        '<tr><td>A</td><td>B</td></tr>' +
        '<tr><td>C</td><td><table><tbody><tr><td>x</td><td>y</td></tr></tbody></table></td></tr>' +
        '</tbody></table>',
    );
    const tables = blocks.filter((b) => b.type === 'table');
    expect(tables).toHaveLength(1);
    // Outer grid stays 2×2 — the nested table's cells are NOT pulled up as rows,
    // and its text folds into the host cell.
    expect(grid(tables[0])).toEqual([
      ['A', 'B'],
      ['C', 'x y'],
    ]);
  });

  it('preserves colspan/rowspan as anchor props with null covered slots', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks(
      '<table><tbody>' +
        '<tr><td colspan="2">Wide</td></tr>' +
        '<tr><td rowspan="2">Tall</td><td>b1</td></tr>' +
        '<tr><td>c1</td></tr>' +
        '</tbody></table>',
    );
    expect(grid(blocks[0])).toEqual([['Wide'], ['Tall', 'b1'], ['c1']]);
    expect(blocks[0].children![0].children![0].props).toMatchObject({col: 'c0', colspan: 2});
    expect(blocks[0].children![1].children![0].props).toMatchObject({col: 'c0', rowspan: 2});
    expect(blocks[0].children![2].children![0].props).toMatchObject({col: 'c1'});
  });

  it('drops cell-less spacer rows, pads ragged rows, keeps blank-but-real cells, stays rectangular', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks(
      '<table><tbody>' +
        '<tr><td>h1</td><td>h2</td><td>h3</td></tr>' +
        '<tr></tr>' + // structural spacer row — no direct cells → dropped
        '<tr><td>only</td></tr>' + // ragged → padded to width
        '<tr><td></td><td></td><td></td></tr>' + // real but blank cells → kept
        '</tbody></table>',
    );
    expect(grid(blocks[0])).toEqual([
      ['h1', 'h2', 'h3'],
      ['only', '', ''],
      ['', '', ''],
    ]);
  });

  it('scopes header detection to the first direct row (thead > th), not a nested table', async () => {
    const {htmlToBlocks} = await import('../../blockeditor/model');
    const blocks = htmlToBlocks(
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    expect(blocks[0].props).toMatchObject({header: true}); // + col:* order-key registry (TBL-1)
    expect(grid(blocks[0])).toEqual([
      ['H1', 'H2'],
      ['a', 'b'],
    ]);
  });
});

describe('paste target — caret inside a table cell', () => {
  it('redirects a pasted block to after the enclosing table, never as a cell sibling', () => {
    const doc = createDoc([{type: 'paragraph', text: 'top'}, makeTable(2, 2)]);
    const original = docToJSON(doc).find((b) => b.type === 'table')!;
    const cellId = original.children![0].children![0].id!;

    // The exact decision TextBlockView makes on `insertFromPaste`.
    const enclosing = enclosingBlock(doc, cellId, new Set<'table'>(['table']));
    expect(enclosing).not.toBeNull();
    expect(blockType(enclosing!.block)).toBe('table');

    insertBlock(doc, enclosing!.parent, enclosing!.index + 1, {
      type: 'table',
      children: [{type: 'row', children: [{type: 'cell', text: 'pasted'}]}],
    });

    const after = docToJSON(doc);
    // Two sibling tables at the root — the pasted one landed AFTER, not inside.
    expect(after.filter((b) => b.type === 'table')).toHaveLength(2);
    // The original table's rows still contain only cells — nothing poisoned in.
    const orig = after.find((b) => b.id === original.id)!;
    for (const row of orig.children ?? []) {
      expect((row.children ?? []).every((c) => c.type === 'cell')).toBe(true);
    }
  });
});
