import {describe, expect, it} from 'vitest';
import {paragraphBlocks, textSnapshot, appendTextToSnapshot} from './content';
import type {PageSnapshot} from './types';

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
