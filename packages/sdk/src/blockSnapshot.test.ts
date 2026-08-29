import {describe, expect, it} from 'vitest';
import {BlockSnapshotError, findBlock, insertBlocks, moveBlock} from './blockSnapshot';
import type {PageSnapshot} from './types';

const snapshot = (): PageSnapshot => ({
  editor: 'blocks',
  blockdoc: {blocks: [
    {id: 'a', type: 'paragraph', text: [{t: 'A'}]},
    {id: 'b', type: 'paragraph', text: [{t: 'B'}]},
    {id: 'c', type: 'paragraph', text: [{t: 'C'}]},
    {id: 'group', type: 'group', children: [{id: 'nested', type: 'paragraph', text: [{t: 'N'}]}]},
    {id: 'columns', type: 'columns', children: [
      {id: 'col1', type: 'column', children: [{id: 'left', type: 'paragraph'}]},
      {id: 'col2', type: 'column', children: [{id: 'right', type: 'paragraph'}]},
    ]},
    {id: 'tabs', type: 'tabs', children: [{id: 'tab', type: 'tab', children: []}]},
    {id: 'accordion', type: 'accordion', children: [{id: 'section', type: 'accordionsection', children: []}]},
    {id: 'table', type: 'table', children: [{id: 'row', type: 'row', children: [{id: 'cell', type: 'cell'}]}]},
  ]},
  editorjs: {blocks: []}, values: [], names: [],
});

const childIds = (data: PageSnapshot, parentId?: string): string[] => {
  const blocks = parentId
    ? findBlock(data, parentId)?.block.children ?? []
    : ((data.blockdoc as {blocks: Array<{id: string}>}).blocks);
  return blocks.map((block) => block.id);
};

describe('generic block snapshot operations', () => {
  it('reorders by post-removal index and afterId', () => {
    const indexed = moveBlock(snapshot(), {blockId: 'a', index: 2});
    expect(childIds(indexed).slice(0, 3)).toEqual(['b', 'c', 'a']);
    const after = moveBlock(indexed, {blockId: 'a', afterId: 'b'});
    expect(childIds(after).slice(0, 3)).toEqual(['b', 'a', 'c']);
  });

  it.each([
    ['col1', 'column'], ['group', 'group'], ['tab', 'tab'], ['section', 'accordionsection'],
  ])('reparents into %s (%s)', (parentId) => {
    const moved = moveBlock(snapshot(), {blockId: 'a', parentId, index: 0});
    expect(childIds(moved, parentId)[0]).toBe('a');
  });

  it('inserts nested blocks by index and afterId', () => {
    const first = insertBlocks(snapshot(), {parentId: 'group', index: 1, idPrefix: 'new', blocks: [
      {type: 'group', children: [{type: 'paragraph', text: 'deep'}]},
    ]});
    expect(childIds(first, 'group')).toEqual(['nested', 'new-0']);
    expect(findBlock(first, 'new-0-0')?.block.text).toEqual([{t: 'deep'}]);
    const second = insertBlocks(first, {parentId: 'group', afterId: 'nested', idPrefix: 'next', blocks: [{type: 'paragraph'}]});
    expect(childIds(second, 'group')).toEqual(['nested', 'next-0', 'new-0']);
  });

  it('refuses cycles, missing ids, invalid positions, and table structure', () => {
    expect(() => moveBlock(snapshot(), {blockId: 'group', parentId: 'nested', index: 0})).toThrowError(BlockSnapshotError);
    expect(() => moveBlock(snapshot(), {blockId: 'missing', index: 0})).toThrow(/No block/);
    expect(() => moveBlock(snapshot(), {blockId: 'a', parentId: 'missing', index: 0})).toThrow(/No parent/);
    expect(() => moveBlock(snapshot(), {blockId: 'a', index: 0, afterId: 'b'})).toThrow(/exactly one/);
    expect(() => moveBlock(snapshot(), {blockId: 'cell', index: 0})).toThrow(/table_\*/);
    expect(() => moveBlock(snapshot(), {blockId: 'a', parentId: 'row', index: 0})).toThrow(/table_\*/);
    expect(() => insertBlocks(snapshot(), {parentId: 'cell', index: 0, blocks: [{type: 'paragraph'}]})).toThrow(/table_\*/);
  });

  it('refuses destinations that do not accept the inserted child type', () => {
    expect(() => insertBlocks(snapshot(), {parentId: 'a', index: 0, blocks: [{type: 'paragraph'}]})).toThrow(/does not accept children/);
    expect(() => insertBlocks(snapshot(), {parentId: 'tabs', index: 0, blocks: [{type: 'paragraph'}]})).toThrow(/cannot contain/);
  });
});
