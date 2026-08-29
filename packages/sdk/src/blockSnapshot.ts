import {blockTypeInfo, CHILD_ONLY_PARENT} from './blockCatalogue';
import {projectAppendBlocks, type AppendBlock, type ProjectedBlock} from './content';
import type {PageSnapshot} from './types';
import {richTextRuns, type RichTextInput} from './richTextInput';

export type SnapshotBlock = ProjectedBlock & {children?: SnapshotBlock[]};

export type BlockSnapshotErrorCode =
  | 'invalid-position'
  | 'unknown-block'
  | 'unknown-parent'
  | 'unknown-after'
  | 'cycle'
  | 'table-owned'
  | 'invalid-parent';

/** An actionable, machine-readable refusal from a generic block-tree operation. */
export class BlockSnapshotError extends Error {
  constructor(readonly code: BlockSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'BlockSnapshotError';
  }
}

export interface FoundSnapshotBlock {
  block: SnapshotBlock;
  siblings: SnapshotBlock[];
  parent: SnapshotBlock | null;
  ancestors: SnapshotBlock[];
  index: number;
}

const blocksOf = (data: PageSnapshot | null | undefined): SnapshotBlock[] | null => {
  if (!data || data.editor !== 'blocks') return null;
  return ((data.blockdoc as {blocks?: SnapshotBlock[]} | undefined)?.blocks ?? []);
};

const copiedBlocks = (data: PageSnapshot): SnapshotBlock[] | null => {
  const blocks = blocksOf(data);
  return blocks ? structuredClone(blocks) : null;
};

const withBlocks = (data: PageSnapshot, blocks: SnapshotBlock[]): PageSnapshot => {
  const blockdoc = (data.blockdoc as {blocks?: unknown[]; update?: string; v?: number} | undefined) ?? {};
  return {...data, blockdoc: {...blockdoc, update: undefined, blocks}};
};

/** Find a block at any depth, including its parent/list coordinates. */
export function findBlock(data: PageSnapshot | null | undefined, blockId: string): FoundSnapshotBlock | null {
  const roots = blocksOf(data);
  if (!roots) return null;
  let found: FoundSnapshotBlock | null = null;
  const walk = (siblings: SnapshotBlock[], parent: SnapshotBlock | null, ancestors: SnapshotBlock[]): void => {
    for (let index = 0; index < siblings.length && !found; index += 1) {
      const block = siblings[index];
      if (block.id === blockId) found = {block, siblings, parent, ancestors, index};
      else if (block.children) walk(block.children, block, [...ancestors, block]);
    }
  };
  walk(roots, null, []);
  return found;
}

/** Replace one block's rich text from mini-markdown or explicit runs. */
export function setBlockText(data: PageSnapshot, blockId: string, text: RichTextInput, plain = false): PageSnapshot | null {
  const blocks = copiedBlocks(data);
  if (!blocks) return null;
  const draft = withBlocks(data, blocks);
  const found = findBlock(draft, blockId);
  if (!found) return null;
  found.block.text = richTextRuns(text, plain);
  return draft;
}

const pruneEmptyContainers = (blocks: SnapshotBlock[]): void => {
  let changed = true;
  while (changed) {
    changed = false;
    const walk = (list: SnapshotBlock[]): boolean => {
      for (let i = 0; i < list.length; i += 1) {
        const block = list[i];
        if (block.type === 'column' && (block.children?.length ?? 0) === 0) {
          list.splice(i, 1);
          return true;
        }
        if (block.type === 'columns') {
          const columns = block.children ?? [];
          if (columns.length === 0) {
            list.splice(i, 1);
            return true;
          }
          if (columns.length === 1) {
            list.splice(i, 1, ...(columns[0].children ?? []));
            return true;
          }
        }
        if (block.children && walk(block.children)) return true;
      }
      return false;
    };
    changed = walk(blocks);
  }
};

/** Delete one block while preserving the editor's non-empty/container rules. */
export function deleteBlock(data: PageSnapshot, blockId: string, idPrefix: string): PageSnapshot | null {
  const blocks = copiedBlocks(data);
  if (!blocks) return null;
  const draft = withBlocks(data, blocks);
  const located = findBlock(draft, blockId);
  if (!located) return null;

  let removeId = blockId;
  if (located.block.type === 'row' && located.parent?.type === 'table' && located.siblings.length === 1) {
    removeId = located.parent.id;
  } else if (located.block.type === 'cell' && located.parent?.type === 'row' && located.siblings.length === 1) {
    const row = findBlock(draft, located.parent.id);
    if (row?.parent?.type === 'table' && row.siblings.length === 1) removeId = row.parent.id;
  }
  const target = removeId === blockId ? located : findBlock(draft, removeId);
  if (!target) return null;
  target.siblings.splice(target.index, 1);
  pruneEmptyContainers(blocks);
  if (blocks.length === 0) blocks.push({id: `${idPrefix}-p`, type: 'paragraph', text: [{t: ''}]});
  return draft;
}

/** Shallow-merge props; an explicit null removes a key. */
export function setBlockProps(
  data: PageSnapshot,
  blockId: string,
  props: Record<string, unknown>,
): {data: PageSnapshot; props: Record<string, unknown>} | null {
  const blocks = copiedBlocks(data);
  if (!blocks) return null;
  const draft = withBlocks(data, blocks);
  const found = findBlock(draft, blockId);
  if (!found) return null;
  const merged = {...(found.block.props ?? {})};
  for (const [key, value] of Object.entries(props)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  found.block.props = merged;
  return {data: draft, props: merged};
}

const tableRefusal = (): never => {
  throw new BlockSnapshotError(
    'table-owned',
    'Generic block operations cannot move into, out of, or within table/row/cell — use the table_* tools.',
  );
};

const touchesTable = (found: FoundSnapshotBlock): boolean =>
  found.ancestors.some((block) => block.type === 'table');

const assertParentAccepts = (parent: SnapshotBlock | null, childTypes: string[]): void => {
  if (!parent) {
    const child = childTypes.find((type) => CHILD_ONLY_PARENT[type]);
    if (child) throw new BlockSnapshotError('invalid-parent', `${child} blocks must be children of ${CHILD_ONLY_PARENT[child]}.`);
    return;
  }
  if (parent.type === 'table' || parent.type === 'row' || parent.type === 'cell') tableRefusal();
  if (blockTypeInfo(parent.type)?.nature !== 'container') {
    throw new BlockSnapshotError('invalid-parent', `Block "${parent.id}" (${parent.type}) does not accept children.`);
  }
  for (const childType of childTypes) {
    const required = CHILD_ONLY_PARENT[childType];
    if ((required && required !== parent.type) || (!required && Object.values(CHILD_ONLY_PARENT).includes(parent.type))) {
      throw new BlockSnapshotError('invalid-parent', `${parent.type} cannot contain ${childType} blocks.`);
    }
  }
};

type Position = {index?: number; afterId?: string};

const insertionIndex = (siblings: SnapshotBlock[], position: Position): number => {
  if ((position.index === undefined) === (position.afterId === undefined)) {
    throw new BlockSnapshotError('invalid-position', 'Provide exactly one of index or afterId.');
  }
  if (position.afterId !== undefined) {
    const index = siblings.findIndex((block) => block.id === position.afterId);
    if (index < 0) throw new BlockSnapshotError('unknown-after', `No sibling block "${position.afterId}" at the destination.`);
    return index + 1;
  }
  if (!Number.isInteger(position.index) || position.index! < 0 || position.index! > siblings.length) {
    throw new BlockSnapshotError('invalid-position', `index must be an integer from 0 to ${siblings.length}.`);
  }
  return position.index!;
};

export interface MoveBlockInput extends Position {blockId: string; parentId?: string}

/** Move a block; index is measured against the destination after removing it. */
export function moveBlock(data: PageSnapshot, input: MoveBlockInput): PageSnapshot {
  const blocks = copiedBlocks(data);
  if (!blocks) throw new BlockSnapshotError('unknown-block', 'That page is not a block-editor page.');
  const draft = withBlocks(data, blocks);
  const source = findBlock(draft, input.blockId);
  if (!source) throw new BlockSnapshotError('unknown-block', `No block "${input.blockId}" on that page.`);
  if (touchesTable(source)) tableRefusal();
  const parent = input.parentId === undefined ? null : findBlock(draft, input.parentId);
  if (input.parentId !== undefined && !parent) throw new BlockSnapshotError('unknown-parent', `No parent block "${input.parentId}" on that page.`);
  if (parent && (parent.block.id === source.block.id || parent.ancestors.some((block) => block.id === source.block.id))) {
    throw new BlockSnapshotError('cycle', 'Cannot move a block into its own subtree.');
  }
  assertParentAccepts(parent?.block ?? null, [source.block.type]);
  const target = parent ? (parent.block.children ??= []) : blocks;
  source.siblings.splice(source.index, 1);
  const at = insertionIndex(target, input);
  target.splice(at, 0, source.block);
  pruneEmptyContainers(blocks);
  return draft;
}

export interface InsertBlocksInput extends Position {parentId?: string; blocks: AppendBlock[]; idPrefix?: string}

/** Insert recursively projected blocks at a root or container position. */
export function insertBlocks(data: PageSnapshot, input: InsertBlocksInput): PageSnapshot {
  const blocks = copiedBlocks(data);
  if (!blocks) throw new BlockSnapshotError('unknown-parent', 'That page is not a block-editor page.');
  const draft = withBlocks(data, blocks);
  const parent = input.parentId === undefined ? null : findBlock(draft, input.parentId);
  if (input.parentId !== undefined && !parent) throw new BlockSnapshotError('unknown-parent', `No parent block "${input.parentId}" on that page.`);
  assertParentAccepts(parent?.block ?? null, input.blocks.map((block) => block.type));
  const target = parent ? (parent.block.children ??= []) : blocks;
  const at = insertionIndex(target, input);
  target.splice(at, 0, ...projectAppendBlocks(input.blocks, input.idPrefix ?? 'gen'));
  return draft;
}
