import {describe, expect, it} from 'vitest';
import {insertBlocks, moveBlock, type PageSnapshot} from '@book.dev/sdk';
import {decodeSnapshot, docToJSON, encodeSnapshot, type BlockDocSnapshot} from '@/blockeditor/model';
import {applyProposalToDoc} from '../aiBridge';

const page = (): PageSnapshot => ({
  editor: 'blocks',
  blockdoc: {blocks: [
    {id: 'a', type: 'paragraph', text: [{t: 'A'}]},
    {id: 'group', type: 'group', children: [{id: 'b', type: 'paragraph', text: [{t: 'B'}]}]},
    {id: 'c', type: 'paragraph', text: [{t: 'C'}]},
  ]},
  editorjs: {blocks: []}, values: [], names: [],
});

const open = () => decodeSnapshot(page().blockdoc as BlockDocSnapshot);
interface BlockShape {type: string; text?: Array<{t: string}>; props?: Record<string, unknown>; children?: BlockShape[]}

const shape = (blocks: Array<{type: string; text?: Array<{t: string}>; props?: Record<string, unknown>; children?: unknown[]}>): BlockShape[] =>
  blocks.map(({type, text, props, children}) => ({
    type,
    ...(text ? {text} : {}),
    ...(props ? {props} : {}),
    ...(children ? {children: shape(children as Parameters<typeof shape>[0])} : {}),
  }));

describe('aiBridge generic block operation parity', () => {
  it('replays move_block with the same tree as the snapshot twin', () => {
    const expected = moveBlock(page(), {blockId: 'c', parentId: 'group', afterId: 'b'});
    const doc = open();
    applyProposalToDoc(doc, {id: 'move', kind: 'move_block', summary: '', payload: {blockId: 'c', parentId: 'group', afterId: 'b'}});
    expect(shape(docToJSON(doc))).toEqual(shape((expected.blockdoc as {blocks: Parameters<typeof shape>[0]}).blocks));
  });

  it('replays nested insert_blocks with the same tree as the snapshot twin', () => {
    const blocks = [{type: 'group', children: [{type: 'heading', text: 'Nested', props: {level: 2}}]}];
    const expected = insertBlocks(page(), {parentId: 'group', index: 1, blocks});
    const doc = open();
    applyProposalToDoc(doc, {id: 'insert', kind: 'insert_blocks', summary: '', payload: {parentId: 'group', index: 1, blocks}});
    expect(shape(docToJSON(doc))).toEqual(shape((expected.blockdoc as {blocks: Parameters<typeof shape>[0]}).blocks));
    expect(encodeSnapshot(doc).blocks).toHaveLength(3);
  });
});
