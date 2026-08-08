import {describe, expect, it} from 'vitest';
import {paragraphBlocks, snapshotSegments, snapshotText, textSnapshot, appendTextToSnapshot, appendBlocksToSnapshot, type ProjectedBlock} from './content';
import type {PageSnapshot} from './types';

describe('snapshotSegments', () => {
  it('tags each block-native block with its id (for a ?block= anchor); snapshotText is the flattening', () => {
    const data: PageSnapshot = {
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: {
        blocks: [
          {id: 'b1', type: 'paragraph', text: [{t: 'Hello '}, {t: 'world'}]},
          {id: 'b2', type: 'code', props: {source: 'x = 1'}},
          {id: 'b3', type: 'group', children: [{id: 'b4', type: 'paragraph', text: [{t: 'nested'}]}]},
        ],
      },
    } as unknown as PageSnapshot;
    expect(snapshotSegments(data)).toEqual([
      {blockId: 'b1', text: 'Hello world'},
      {blockId: 'b2', text: 'x = 1'},
      {blockId: 'b4', text: 'nested'},
    ]);
    // snapshotText stays the newline-joined flattening of the same segments.
    expect(snapshotText(data)).toBe('Hello world\nx = 1\nnested');
  });

  it('legacy stored pages yield text-only segments (no block id survives migration)', () => {
    const legacy: PageSnapshot = {
      editorjs: {blocks: [{id: 'l0', type: 'paragraph', data: {text: '<b>Hi</b> there'}}]},
      values: [],
      names: [],
    };
    expect(snapshotSegments(legacy)).toEqual([{text: 'Hi there'}]);
    expect(snapshotText(legacy)).toBe('Hi there');
  });
});

describe('paragraphBlocks', () => {
  it('emits block-native paragraphs (text runs), one per non-empty line', () => {
    expect(paragraphBlocks('a\n\n  b  ', 'p')).toEqual([
      {id: 'p-0', type: 'paragraph', text: [{t: 'a'}]},
      {id: 'p-1', type: 'paragraph', text: [{t: 'b'}]},
    ]);
  });
});

describe('textSnapshot', () => {
  it('creates a block-native blockdoc page from birth (editor:blocks + blockdoc, no legacy editorjs)', () => {
    const snap = textSnapshot('First line.\nSecond line.', 'agent');
    expect(snap.editor).toBe('blocks');
    const blockdoc = snap.blockdoc as {blocks: Array<{type: string; text: Array<{t: string}>}>; update?: unknown};
    expect(blockdoc.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(blockdoc.blocks.map((b) => b.text[0].t)).toEqual(['First line.', 'Second line.']);
    // No CRDT update yet: the JSON projection is decoded on first load (never the
    // migrate-on-open path, which fires only for snapshots that LACK a blockdoc)
    // and a real update is stamped on the first save.
    expect(blockdoc.update).toBeUndefined();
    // editorjs survives only as an empty back-compat placeholder.
    expect(snap.editorjs).toEqual({blocks: []});
  });

  it('an empty page is still a blockdoc page', () => {
    const snap = textSnapshot();
    expect(snap.editor).toBe('blocks');
    expect((snap.blockdoc as {blocks: unknown[]}).blocks).toEqual([]);
  });
});

describe('appendTextToSnapshot', () => {
  it('appends to a block-editor page as blockdoc paragraphs, dropping the stale CRDT update', () => {
    const base = textSnapshot('One.', 'x');
    const withUpdate = {...base, blockdoc: {...(base.blockdoc as object), update: 'STALE'}} as PageSnapshot;
    const out = appendTextToSnapshot(withUpdate, 'Two.', 'y');
    expect(out.editor).toBe('blocks');
    const bd = out.blockdoc as {blocks: Array<{text: Array<{t: string}>}>; update?: unknown};
    expect(bd.blocks.map((b) => b.text[0].t)).toEqual(['One.', 'Two.']);
    expect(bd.update).toBeUndefined();
    expect(out.editorjs).toEqual({blocks: []});
  });

  it('appends to a pre-existing LEGACY page in its stored editorjs shape (no dialect mixing, no data loss)', () => {
    const legacy: PageSnapshot = {editorjs: {blocks: [{id: 'l-0', type: 'paragraph', data: {text: 'Existing.'}}]}, values: [], names: []};
    const out = appendTextToSnapshot(legacy, 'Added.', 'z');
    expect(out.editor).toBeUndefined(); // stays legacy
    expect(out.blockdoc).toBeUndefined();
    const blocks = (out.editorjs as {blocks: Array<{type: string; data: {text: string}}>}).blocks;
    expect(blocks.map((b) => b.data.text)).toEqual(['Existing.', 'Added.']);
  });

  it('returns the input unchanged when there is nothing to add', () => {
    const block = textSnapshot('One.', 'x');
    expect(appendTextToSnapshot(block, '   \n  ', 'y')).toBe(block);
    const legacy: PageSnapshot = {editorjs: {blocks: []}, values: [], names: []};
    expect(appendTextToSnapshot(legacy, '', 'y')).toBe(legacy);
  });
});

// The API-1 chokepoint: the projection used to be FLAT (id/type/text/props), so
// every nested block in an `append_blocks` payload was silently discarded — a
// table/columns payload landed as one empty container. These pin the recursion.
describe('appendBlocksToSnapshot: nested children (API-1)', () => {
  const empty = (): PageSnapshot =>
    ({editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: [], update: 'STALE'}} as unknown as PageSnapshot);
  const projected = (data: PageSnapshot | null): ProjectedBlock[] => (data!.blockdoc as {blocks: ProjectedBlock[]}).blocks;

  it('preserves nested children to any depth, projecting text→runs at EVERY level', () => {
    const out = appendBlocksToSnapshot(
      empty(),
      [
        {
          type: 'columns',
          children: [
            {type: 'column', props: {span: 6}, children: [{type: 'heading', text: 'Left', props: {level: 2}}]},
            {type: 'column', props: {span: 6}, children: [{type: 'group', children: [{type: 'paragraph', text: 'Deep'}]}]},
          ],
        },
      ],
      'p',
    );
    expect(projected(out)).toEqual([
      {
        id: 'p-0',
        type: 'columns',
        children: [
          {id: 'p-0-0', type: 'column', props: {span: 6}, children: [{id: 'p-0-0-0', type: 'heading', text: [{t: 'Left'}], props: {level: 2}}]},
          {
            id: 'p-0-1',
            type: 'column',
            props: {span: 6},
            children: [{id: 'p-0-1-0', type: 'group', children: [{id: 'p-0-1-0-0', type: 'paragraph', text: [{t: 'Deep'}]}]}],
          },
        ],
      },
    ]);
  });

  it('projects a table → row → cell payload with every cell text intact', () => {
    const out = appendBlocksToSnapshot(
      empty(),
      [
        {
          type: 'table',
          children: [
            {type: 'row', props: {header: true}, children: [{type: 'cell', text: 'Item'}, {type: 'cell', text: 'Qty'}]},
            {type: 'row', children: [{type: 'cell', text: 'Apples'}, {type: 'cell', text: '3'}]},
          ],
        },
      ],
      't',
    );
    const table = projected(out)[0];
    expect(table.children?.map((r) => r.children?.map((c) => c.text?.[0].t))).toEqual([
      ['Item', 'Qty'],
      ['Apples', '3'],
    ]);
    expect(table.children?.[0].props).toEqual({header: true});
  });

  it('ids are position-derived, so the same payload projects to the same ids (retry-safe, addressable)', () => {
    const payload = [{type: 'group', children: [{type: 'paragraph', text: 'a'}]}];
    expect(appendBlocksToSnapshot(empty(), payload, 'k')!.blockdoc).toEqual(appendBlocksToSnapshot(empty(), payload, 'k')!.blockdoc);
  });

  it('drops the stale CRDT update and keeps existing blocks ahead of the appended ones', () => {
    const seeded = {
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: {blocks: [{id: 'b0', type: 'paragraph', text: [{t: 'first'}]}], update: 'STALE'},
    } as unknown as PageSnapshot;
    const out = appendBlocksToSnapshot(seeded, [{type: 'paragraph', text: 'second'}], 'm');
    expect((out!.blockdoc as {update?: unknown}).update).toBeUndefined();
    expect(projected(out).map((b) => b.id)).toEqual(['b0', 'm-0']);
  });

  it('omits an empty children array (a leaf stays a leaf) and still returns null for legacy pages', () => {
    expect(projected(appendBlocksToSnapshot(empty(), [{type: 'paragraph', text: 'x', children: []}], 'e'))[0].children).toBeUndefined();
    const legacy: PageSnapshot = {editorjs: {blocks: []}, values: [], names: []};
    expect(appendBlocksToSnapshot(legacy, [{type: 'paragraph'}])).toBeNull();
  });
});
