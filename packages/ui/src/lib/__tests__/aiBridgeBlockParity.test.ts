import {describe, expect, it} from 'vitest';
import {insertBlocks, moveBlock, setBlockText, type PageSnapshot} from '@book.dev/sdk';
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
const openPage = (data: PageSnapshot) => decodeSnapshot(data.blockdoc as BlockDocSnapshot);
interface BlockShape {type: string; text?: Array<{t: string}>; props?: Record<string, unknown>; children?: BlockShape[]}

const shape = (blocks: Array<{type: string; text?: Array<{t: string}>; props?: Record<string, unknown>; children?: unknown[]}>): BlockShape[] =>
  blocks.map(({type, text, props, children}) => ({
    type,
    ...(text ? {text} : {}),
    ...(props ? {props} : {}),
    ...(children ? {children: shape(children as Parameters<typeof shape>[0])} : {}),
  }));

describe('aiBridge generic block operation parity', () => {
  const paragraph = (id: string) => ({id, type: 'paragraph', text: [{t: id.toUpperCase()}]});
  const moveCases: Array<{name: string; blocks: PageSnapshot['blockdoc']; payload: {blockId: string; parentId?: string; index?: number; afterId?: string}}> = [
    {
      name: 'moves forward in the same parent',
      blocks: {blocks: [paragraph('a'), paragraph('b'), paragraph('c')]},
      payload: {blockId: 'a', index: 2},
    },
    {
      name: 'moves backward in the same parent',
      blocks: {blocks: [paragraph('a'), paragraph('b'), paragraph('c')]},
      payload: {blockId: 'c', index: 0},
    },
    {
      name: 'moves afterId in the same parent',
      blocks: {blocks: [paragraph('a'), paragraph('b'), paragraph('c')]},
      payload: {blockId: 'a', afterId: 'b'},
    },
    {
      name: 'moves into a group',
      blocks: {blocks: [paragraph('a'), {id: 'group', type: 'group', children: [paragraph('b')]}, paragraph('c')]},
      payload: {blockId: 'c', parentId: 'group', index: 0},
    },
    {
      name: 'moves out of a group',
      blocks: {blocks: [paragraph('a'), {id: 'group', type: 'group', children: [paragraph('b'), paragraph('c')]}, paragraph('d')]},
      payload: {blockId: 'b', index: 1},
    },
    {
      name: 'anchors after a preceding lone column is pruned',
      blocks: {blocks: [{id: 'columns', type: 'columns', children: [{id: 'column', type: 'column', children: [paragraph('x')]}]}, paragraph('a'), paragraph('b')]},
      payload: {blockId: 'x', index: 2},
    },
    {
      name: 'anchors before a following lone column is pruned',
      blocks: {blocks: [paragraph('a'), {id: 'columns', type: 'columns', children: [{id: 'column', type: 'column', children: [paragraph('x')]}]}, paragraph('b')]},
      payload: {blockId: 'x', index: 0},
    },
  ];

  it.each(moveCases)('$name with the same full nested tree as the snapshot twin', ({blocks, payload}) => {
    const data: PageSnapshot = {...page(), blockdoc: blocks};
    const expected = moveBlock(data, payload);
    const doc = openPage(data);
    applyProposalToDoc(doc, {id: 'move', kind: 'move_block', summary: '', payload});
    expect(docToJSON(doc)).toEqual((expected.blockdoc as BlockDocSnapshot).blocks);
  });

  it('replays nested insert_blocks with the same tree as the snapshot twin', () => {
    const blocks = [{type: 'group', children: [{type: 'heading', text: 'Nested', props: {level: 2}}]}];
    const expected = insertBlocks(page(), {parentId: 'group', index: 1, blocks});
    const doc = open();
    applyProposalToDoc(doc, {id: 'insert', kind: 'insert_blocks', summary: '', payload: {parentId: 'group', index: 1, blocks}});
    expect(shape(docToJSON(doc))).toEqual(shape((expected.blockdoc as {blocks: Parameters<typeof shape>[0]}).blocks));
    expect(encodeSnapshot(doc).blocks).toHaveLength(3);
  });

  it('replays mini-markdown update_block with the same runs as the snapshot twin', () => {
    const expected = setBlockText(page(), 'a', '**a** [b](https://x.test)')!;
    const doc = open();
    applyProposalToDoc(doc, {id: 'rich', kind: 'update_block', summary: '', payload: {blockId: 'a', text: '**a** [b](https://x.test)'}});
    expect(docToJSON(doc)[0].text).toEqual((expected.blockdoc as BlockDocSnapshot).blocks[0].text);
  });

  it('replays explicit runs exactly and honors plain string opt-out', () => {
    const runs = [{t: 'bold', a: {b: true as const}}, {t: ' link', a: {a: 'https://x.test'}}];
    const doc = open();
    applyProposalToDoc(doc, {id: 'runs', kind: 'update_block', summary: '', payload: {blockId: 'a', text: {runs}}});
    expect(docToJSON(doc)[0].text).toEqual(runs);
    applyProposalToDoc(doc, {id: 'plain', kind: 'update_block', summary: '', payload: {blockId: 'a', text: '**a**', plain: true}});
    expect(docToJSON(doc)[0].text).toEqual([{t: '**a**'}]);
  });
});
