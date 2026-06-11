import * as Y from 'yjs';
import {shortId} from '@open-book/sdk';

/**
 * The block editor's document model: a CRDT block tree in a Y.Doc.
 *
 * Shape — one uniform recursive structure for everything:
 *
 *   doc.getArray('blocks')      Y.Array<Y.Map>      top-level blocks
 *   block (Y.Map):
 *     id        string          stable id (drag/drop, React keys, anchors)
 *     type      BlockType
 *     text      Y.Text          rich text (attribute runs), text blocks only
 *     props     Y.Map           type-specific config (heading level, spans…)
 *     children  Y.Array<Y.Map>  container blocks (columns → column → blocks,
 *                               table → row → cell)
 *
 * Uniformity is the point: a table cell and a layout column hold ordinary
 * blocks, so editing, drag-and-drop, selection, and serialization recurse
 * with no special cases. Inline formatting lives in Y.Text attribute runs
 * ({b,i,u,s,c,a,m} — bold, italic, underline, strike, code, anchor href,
 * mention page id) so concurrent edits merge at the character level.
 *
 * Two serializations:
 *  - the Y update (base64) — the CRDT history, what collaboration merges;
 *  - a plain JSON projection — what the server, exports, and tests read.
 * Both are stored in the page snapshot (see `encodeSnapshot`).
 */

export type BlockType =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider'
  | 'columns'
  | 'column'
  | 'table'
  | 'row'
  | 'cell';

/** Inline formatting attributes carried by Y.Text runs. */
export interface InlineAttrs {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  c?: boolean;
  /** Link href. */
  a?: string;
  /** Mention: a page id (rendered as a live page chip). */
  m?: string;
}

/** One run of a block's rich text in the JSON projection. */
export interface TextRun {
  t: string;
  a?: InlineAttrs;
}

/** The JSON projection of a block (exports, server, tests). */
export interface BlockJSON {
  id: string;
  type: AnyBlockType;
  text?: TextRun[];
  props?: Record<string, unknown>;
  children?: BlockJSON[];
}

/** Block types that carry editable rich text. */
export const TEXT_BLOCKS: ReadonlySet<BlockType> = new Set([
  'paragraph',
  'heading',
  'list',
  'todo',
  'quote',
  'callout',
  'code',
  'cell',
]);

/** Block types whose `children` hold ordinary blocks. */
export const CONTAINER_BLOCKS: ReadonlySet<BlockType> = new Set(['columns', 'column', 'table', 'row']);

export type BlockMap = Y.Map<unknown>;

// ── Construction ─────────────────────────────────────────────────────────────

/** Core types plus registered custom types (registry.tsx). */
export type AnyBlockType = BlockType | (string & {});

export interface NewBlock {
  type: AnyBlockType;
  text?: string | TextRun[];
  props?: Record<string, unknown>;
  children?: NewBlock[];
  id?: string;
}

/** Build a detached block Y.Map (insert it into an array before editing). */
export function makeBlock(input: NewBlock): BlockMap {
  const block = new Y.Map<unknown>();
  block.set('id', input.id ?? shortId('b'));
  block.set('type', input.type);
  if (TEXT_BLOCKS.has(input.type as BlockType)) {
    const text = new Y.Text();
    if (typeof input.text === 'string') {
      if (input.text) text.insert(0, input.text);
    } else if (input.text) {
      let at = 0;
      for (const run of input.text) {
        // Explicit attrs always — Y.Text inherits the previous run's format
        // when attributes are omitted, which would bleed styling across runs.
        text.insert(at, run.t, run.a ?? {});
        at += run.t.length;
      }
    }
    block.set('text', text);
  }
  if (input.props && Object.keys(input.props).length > 0) {
    const props = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(input.props)) props.set(k, v);
    block.set('props', props);
  }
  if (CONTAINER_BLOCKS.has(input.type as BlockType)) {
    const children = new Y.Array<BlockMap>();
    if (input.children) children.push(input.children.map(makeBlock));
    block.set('children', children);
  }
  return block;
}

/** A fresh empty document (one empty paragraph, like a new page). */
export function createDoc(blocks?: NewBlock[]): Y.Doc {
  const doc = new Y.Doc();
  const list = rootBlocks(doc);
  doc.transact(() => {
    list.push((blocks && blocks.length > 0 ? blocks : [{type: 'paragraph' as const}]).map(makeBlock));
  });
  return doc;
}

export function rootBlocks(doc: Y.Doc): Y.Array<BlockMap> {
  return doc.getArray<BlockMap>('blocks');
}

/**
 * A doc seeded *deterministically*: the seed content is written by a fixed
 * replica (clientID 1) with caller-supplied block ids, so every client that
 * seeds the same template produces byte-identical CRDT state. Two tabs that
 * race to initialize then merge into ONE copy of the content instead of two.
 * Blocks without explicit ids would defeat the purpose — they get stable ids
 * derived from their position instead of random ones.
 */
export function createSeededDoc(blocks: NewBlock[], seedTag = 'seed'): Y.Doc {
  const withIds = (list: NewBlock[], prefix: string): NewBlock[] =>
    list.map((b, i) => ({
      ...b,
      id: b.id ?? `${prefix}-${i}`,
      children: b.children ? withIds(b.children, `${prefix}-${i}`) : undefined,
    }));
  const seed = new Y.Doc();
  seed.clientID = 1;
  rootBlocks(seed).push(withIds(blocks.length > 0 ? blocks : [{type: 'paragraph'}], seedTag).map(makeBlock));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  seed.destroy();
  return doc;
}

// ── Accessors ────────────────────────────────────────────────────────────────

export const blockId = (b: BlockMap): string => b.get('id') as string;
export const blockType = (b: BlockMap): BlockType => b.get('type') as BlockType;
export const blockText = (b: BlockMap): Y.Text | undefined => b.get('text') as Y.Text | undefined;
export const blockChildren = (b: BlockMap): Y.Array<BlockMap> | undefined =>
  b.get('children') as Y.Array<BlockMap> | undefined;

export function blockProp<T>(b: BlockMap, key: string): T | undefined {
  const props = b.get('props') as Y.Map<unknown> | undefined;
  return props?.get(key) as T | undefined;
}

export function setBlockProp(b: BlockMap, key: string, value: unknown): void {
  let props = b.get('props') as Y.Map<unknown> | undefined;
  if (!props) {
    props = new Y.Map<unknown>();
    b.set('props', props);
  }
  if (value === undefined) props.delete(key);
  else props.set(key, value);
}

/** Depth-first walk over every block in the tree. */
export function* walkBlocks(list: Y.Array<BlockMap>): Generator<{block: BlockMap; parent: Y.Array<BlockMap>; index: number}> {
  for (let i = 0; i < list.length; i += 1) {
    const block = list.get(i);
    yield {block, parent: list, index: i};
    const children = blockChildren(block);
    if (children) yield* walkBlocks(children);
  }
}

/** Locate a block (and its parent array + index) by id anywhere in the doc. */
export function findBlock(doc: Y.Doc, id: string): {block: BlockMap; parent: Y.Array<BlockMap>; index: number} | null {
  for (const entry of walkBlocks(rootBlocks(doc))) {
    if (blockId(entry.block) === id) return entry;
  }
  return null;
}

// ── Mutations ────────────────────────────────────────────────────────────────
// All take the doc so they can run in one transaction (one undo step, one
// broadcast). Yjs types can't be re-parented once attached, so moves clone.

/** Deep-clone a block into a fresh detached Y.Map (same ids). */
export function cloneBlock(b: BlockMap, freshIds = false): BlockMap {
  return makeBlock(toJSONWithIds(b, freshIds));
}

function toJSONWithIds(b: BlockMap, freshIds: boolean): NewBlock {
  const json = blockToJSON(b);
  const strip = (node: BlockJSON): NewBlock => ({
    id: freshIds ? undefined : node.id,
    type: node.type,
    text: node.text,
    props: node.props,
    children: node.children?.map(strip),
  });
  return strip(json);
}

export function insertBlock(doc: Y.Doc, parent: Y.Array<BlockMap>, index: number, input: NewBlock): string {
  // Reading from a detached Y.Map is an "Invalid access" in Yjs — settle the
  // id BEFORE construction instead of reading it back off the new block.
  const id = input.id ?? shortId('b');
  const block = makeBlock({...input, id});
  doc.transact(() => parent.insert(Math.max(0, Math.min(index, parent.length)), [block]), 'local');
  return id;
}

export function removeBlock(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const found = findBlock(doc, id);
    if (found) found.parent.delete(found.index, 1);
    pruneEmptyContainers(doc);
    ensureNotEmpty(doc);
  }, 'local');
}

/**
 * Move a block to `toIndex` of the array identified by `targetParentId`
 * (`null` = the root list). Clones under the hood (Yjs re-parent rule);
 * `toIndex` is interpreted against the array *without* the moved block.
 */
export function moveBlock(doc: Y.Doc, id: string, targetParentId: string | null, toIndex: number): void {
  doc.transact(() => {
    const found = findBlock(doc, id);
    if (!found) return;
    const target = targetParentId === null ? rootBlocks(doc) : blockChildren(findBlock(doc, targetParentId)?.block as BlockMap);
    if (!target) return;
    // Forbid dropping a container into itself/descendants.
    if (targetParentId !== null) {
      for (const entry of walkBlocks(blockChildren(found.block) ?? new Y.Array<BlockMap>())) {
        if (blockId(entry.block) === targetParentId) return;
      }
      if (targetParentId === id) return;
    }
    const clone = cloneBlock(found.block);
    const sameParent = found.parent === target;
    found.parent.delete(found.index, 1);
    let at = toIndex;
    if (sameParent && found.index < toIndex) at -= 1;
    target.insert(Math.max(0, Math.min(at, target.length)), [clone]);
    pruneEmptyContainers(doc);
    ensureNotEmpty(doc);
  }, 'local');
}

/** Split a text block at `offset`: the tail (text + attrs) becomes a new block below. */
export function splitBlock(doc: Y.Doc, id: string, offset: number, newType?: BlockType): string | null {
  let newId: string | null = null;
  doc.transact(() => {
    const found = findBlock(doc, id);
    if (!found) return;
    const text = blockText(found.block);
    if (!text) return;
    const delta = text.toDelta() as {insert: string; attributes?: InlineAttrs}[];
    const tail: TextRun[] = [];
    let seen = 0;
    for (const op of delta) {
      const end = seen + op.insert.length;
      if (end > offset) {
        const from = Math.max(0, offset - seen);
        tail.push({t: op.insert.slice(from), a: op.attributes});
      }
      seen = end;
    }
    if (text.length > offset) text.delete(offset, text.length - offset);
    const type = blockType(found.block);
    // Splitting a list/todo continues the list; anything else yields a paragraph.
    const continuation: BlockType = newType ?? (type === 'list' || type === 'todo' ? type : 'paragraph');
    const props =
      continuation === blockType(found.block) && continuation === 'list'
        ? {kind: blockProp<string>(found.block, 'kind') ?? 'bullet'}
        : undefined;
    newId = shortId('b'); // settled up front — detached Y.Maps can't be read
    found.parent.insert(found.index + 1, [makeBlock({id: newId, type: continuation, text: tail, props})]);
  }, 'local');
  return newId;
}

/**
 * Merge a text block into the previous text block (Backspace at offset 0).
 * Returns the previous block's id and its pre-merge length (caret target).
 */
export function mergeWithPrevious(doc: Y.Doc, id: string): {id: string; offset: number} | null {
  let result: {id: string; offset: number} | null = null;
  doc.transact(() => {
    const found = findBlock(doc, id);
    if (!found || found.index === 0) return;
    const prev = found.parent.get(found.index - 1);
    const prevText = blockText(prev);
    const text = blockText(found.block);
    if (!prevText || !text) return;
    const offset = prevText.length;
    const delta = text.toDelta() as {insert: string; attributes?: InlineAttrs}[];
    let at = offset;
    for (const op of delta) {
      prevText.insert(at, op.insert, op.attributes ?? {});
      at += op.insert.length;
    }
    found.parent.delete(found.index, 1);
    result = {id: blockId(prev), offset};
  }, 'local');
  return result;
}

/** Change a block's type in place (keeps text); optional props patch. */
export function turnInto(doc: Y.Doc, id: string, type: BlockType, props?: Record<string, unknown>): void {
  doc.transact(() => {
    const found = findBlock(doc, id);
    if (!found) return;
    found.block.set('type', type);
    if (TEXT_BLOCKS.has(type) && !blockText(found.block)) found.block.set('text', new Y.Text());
    if (props) for (const [k, v] of Object.entries(props)) setBlockProp(found.block, k, v);
  }, 'local');
}

/**
 * Make a columns layout: wraps `targetId` and the moved block `movedId`
 * side-by-side (moved goes left when `side === 'left'`). If `targetId` is
 * already a column's child, the moved block becomes a new adjacent column
 * instead (2 → 3 → 4 columns by dropping beside).
 */
export function dropBeside(doc: Y.Doc, movedId: string, targetId: string, side: 'left' | 'right'): void {
  doc.transact(() => {
    const moved = findBlock(doc, movedId);
    const target = findBlock(doc, targetId);
    if (!moved || !target || movedId === targetId) return;
    if (blockType(moved.block) === 'columns' || blockType(moved.block) === 'column') return;

    const movedJson = toJSONWithIds(moved.block, false);
    // The target sits inside a column → add a sibling column (cap at 4).
    const parentBlock = parentBlockOf(doc, target.parent);
    if (parentBlock && blockType(parentBlock) === 'column') {
      const columnsBlock = parentBlockOf(doc, findBlock(doc, blockId(parentBlock))!.parent);
      const columns = columnsBlock ? blockChildren(columnsBlock) : undefined;
      if (!columnsBlock || !columns || columns.length >= 4) return;
      const colIndex = indexOfBlock(columns, blockId(parentBlock));
      moved.parent.delete(moved.index, 1);
      const at = side === 'left' ? colIndex : colIndex + 1;
      columns.insert(at, [makeBlock({type: 'column', children: [movedJson]})]);
      pruneEmptyContainers(doc);
      ensureNotEmpty(doc);
      return;
    }

    // Wrap target + moved in a fresh 2-column layout (re-find after delete).
    moved.parent.delete(moved.index, 1);
    const target2 = findBlock(doc, targetId);
    if (!target2) return;
    const targetJson = toJSONWithIds(target2.block, false);
    const cols: NewBlock[] = [
      {type: 'column', children: [side === 'left' ? movedJson : targetJson]},
      {type: 'column', children: [side === 'left' ? targetJson : movedJson]},
    ];
    const layout = makeBlock({type: 'columns', children: cols});
    target2.parent.delete(target2.index, 1);
    target2.parent.insert(target2.index, [layout]);
    pruneEmptyContainers(doc);
    ensureNotEmpty(doc);
  }, 'local');
}

/** The block whose `children` array is `arr`, or null for the root list. */
export function parentBlockOf(doc: Y.Doc, arr: Y.Array<BlockMap>): BlockMap | null {
  if (arr === rootBlocks(doc)) return null;
  for (const entry of walkBlocks(rootBlocks(doc))) {
    if (blockChildren(entry.block) === arr) return entry.block;
  }
  return null;
}

function indexOfBlock(arr: Y.Array<BlockMap>, id: string): number {
  for (let i = 0; i < arr.length; i += 1) if (blockId(arr.get(i)) === id) return i;
  return -1;
}

/** Drop empty columns; unwrap single-column layouts; drop empty layouts. */
export function pruneEmptyContainers(doc: Y.Doc): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of walkBlocks(rootBlocks(doc))) {
      const type = blockType(entry.block);
      if (type === 'column' && (blockChildren(entry.block)?.length ?? 0) === 0) {
        entry.parent.delete(entry.index, 1);
        changed = true;
        break;
      }
      if (type === 'columns') {
        const cols = blockChildren(entry.block)!;
        if (cols.length === 0) {
          entry.parent.delete(entry.index, 1);
          changed = true;
          break;
        }
        if (cols.length === 1) {
          // Unwrap: hoist the lone column's blocks in place of the layout.
          const inner = blockChildren(cols.get(0))!;
          const hoisted: BlockMap[] = [];
          for (let i = 0; i < inner.length; i += 1) hoisted.push(cloneBlock(inner.get(i)));
          entry.parent.delete(entry.index, 1);
          entry.parent.insert(entry.index, hoisted);
          changed = true;
          break;
        }
      }
    }
  }
}

/** A document never renders empty — keep one paragraph to type into. */
export function ensureNotEmpty(doc: Y.Doc): void {
  const root = rootBlocks(doc);
  if (root.length === 0) root.push([makeBlock({type: 'paragraph'})]);
}

// ── Tables ───────────────────────────────────────────────────────────────────

export function makeTable(rows: number, cols: number): NewBlock {
  return {
    type: 'table',
    props: {header: true},
    children: Array.from({length: rows}, () => ({
      type: 'row' as const,
      children: Array.from({length: cols}, () => ({type: 'cell' as const})),
    })),
  };
}

/** Insert a row at `rowIndex` (clamped); matches the table's column count. */
export function tableInsertRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rows = blockChildren(table.block)!;
    const cols = rows.length > 0 ? (blockChildren(rows.get(0))?.length ?? 1) : 1;
    rows.insert(Math.max(0, Math.min(rowIndex, rows.length)), [
      makeBlock({type: 'row', children: Array.from({length: cols}, () => ({type: 'cell' as const}))}),
    ]);
  }, 'local');
}

export function tableInsertColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rows = blockChildren(table.block)!;
    for (let r = 0; r < rows.length; r += 1) {
      const cells = blockChildren(rows.get(r))!;
      cells.insert(Math.max(0, Math.min(colIndex, cells.length)), [makeBlock({type: 'cell'})]);
    }
  }, 'local');
}

export function tableDeleteRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rows = blockChildren(table.block)!;
    if (rowIndex < 0 || rowIndex >= rows.length) return;
    if (rows.length === 1) removeBlockInTx(doc, tableId);
    else rows.delete(rowIndex, 1);
  }, 'local');
}

export function tableDeleteColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rows = blockChildren(table.block)!;
    const cols = rows.length > 0 ? (blockChildren(rows.get(0))?.length ?? 0) : 0;
    if (colIndex < 0 || colIndex >= cols) return;
    if (cols === 1) {
      removeBlockInTx(doc, tableId);
      return;
    }
    for (let r = 0; r < rows.length; r += 1) {
      const cells = blockChildren(rows.get(r))!;
      if (colIndex < cells.length) cells.delete(colIndex, 1);
    }
  }, 'local');
}

/**
 * Locate a cell within its table: row/column indices plus the table block.
 * Powers cell navigation (Tab/Enter) — cells are blocks, but movement inside
 * a table is grid-shaped, not list-shaped.
 */
export function cellPosition(doc: Y.Doc, cellId: string): {table: BlockMap; row: number; col: number; rows: number; cols: number} | null {
  const cell = findBlock(doc, cellId);
  if (!cell || blockType(cell.block) !== 'cell') return null;
  const rowBlock = parentBlockOf(doc, cell.parent);
  if (!rowBlock) return null;
  const rowEntry = findBlock(doc, blockId(rowBlock));
  if (!rowEntry) return null;
  const table = parentBlockOf(doc, rowEntry.parent);
  if (!table || blockType(table) !== 'table') return null;
  const rows = blockChildren(table)!;
  return {table, row: rowEntry.index, col: cell.index, rows: rows.length, cols: blockChildren(rowBlock)!.length};
}

/**
 * The neighbouring cell id for grid navigation. `next`/`prev` move within
 * the row and wrap across rows; `down`/`up` move within the column. Returns
 * null at the table's edge (callers may grow the table and retry).
 */
export function cellNeighbor(doc: Y.Doc, cellId: string, dir: 'next' | 'prev' | 'down' | 'up'): string | null {
  const pos = cellPosition(doc, cellId);
  if (!pos) return null;
  let {row, col} = pos;
  if (dir === 'next') {
    col += 1;
    if (col >= pos.cols) {
      col = 0;
      row += 1;
    }
  } else if (dir === 'prev') {
    col -= 1;
    if (col < 0) {
      col = pos.cols - 1;
      row -= 1;
    }
  } else {
    row += dir === 'down' ? 1 : -1;
  }
  if (row < 0 || row >= pos.rows) return null;
  const rows = blockChildren(pos.table)!;
  const cells = blockChildren(rows.get(row))!;
  if (col < 0 || col >= cells.length) return null;
  return blockId(cells.get(col));
}

function removeBlockInTx(doc: Y.Doc, id: string): void {
  const found = findBlock(doc, id);
  if (found) found.parent.delete(found.index, 1);
  ensureNotEmpty(doc);
}

// ── Serialization ────────────────────────────────────────────────────────────

export function blockToJSON(b: BlockMap): BlockJSON {
  const json: BlockJSON = {id: blockId(b), type: blockType(b)};
  const text = blockText(b);
  if (text) {
    json.text = (text.toDelta() as {insert: string; attributes?: InlineAttrs}[]).map((op) => ({
      t: op.insert,
      ...(op.attributes && Object.keys(op.attributes).length > 0 ? {a: op.attributes} : {}),
    }));
  }
  const props = b.get('props') as Y.Map<unknown> | undefined;
  if (props && props.size > 0) json.props = Object.fromEntries(props.entries());
  const children = blockChildren(b);
  if (children) json.children = children.map(blockToJSON);
  return json;
}

export function docToJSON(doc: Y.Doc): BlockJSON[] {
  return rootBlocks(doc).map(blockToJSON);
}

/** The plain concatenated text of a block (search, summaries). */
export function blockPlainText(b: BlockMap): string {
  return blockText(b)?.toString() ?? '';
}

/** Persisted form inside a page snapshot. */
export interface BlockDocSnapshot {
  v: 1;
  /** Base64 Y update — the CRDT state vector clients merge from. */
  update: string;
  /** Plain JSON projection — exports / server / non-CRDT readers. */
  blocks: BlockJSON[];
}

export function encodeSnapshot(doc: Y.Doc): BlockDocSnapshot {
  const update = Y.encodeStateAsUpdate(doc);
  let binary = '';
  for (let i = 0; i < update.length; i += 1) binary += String.fromCharCode(update[i]);
  return {v: 1, update: btoa(binary), blocks: docToJSON(doc)};
}

/** Rebuild a Y.Doc from a snapshot (falls back to the JSON projection). */
export function decodeSnapshot(snapshot: BlockDocSnapshot | undefined | null): Y.Doc {
  if (snapshot?.update) {
    try {
      const binary = atob(snapshot.update);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, bytes);
      ensureNotEmpty(doc);
      return doc;
    } catch {
      // fall through to the JSON projection
    }
  }
  if (snapshot?.blocks && snapshot.blocks.length > 0) {
    return createDoc(snapshot.blocks.map(jsonToNewBlock));
  }
  return createDoc();
}

function jsonToNewBlock(json: BlockJSON): NewBlock {
  return {
    id: json.id,
    type: json.type,
    text: json.text,
    props: json.props,
    children: json.children?.map(jsonToNewBlock),
  };
}

// ── EditorJS migration ───────────────────────────────────────────────────────

interface EditorJsBlock {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

/** Strip an EditorJS HTML string into rich runs (b/i/code/links survive). */
export function htmlToRuns(html: string): TextRun[] {
  if (typeof document === 'undefined') return [{t: html.replace(/<[^>]+>/g, '')}];
  const el = document.createElement('div');
  el.innerHTML = html;
  const runs: TextRun[] = [];
  const visit = (node: Node, attrs: InlineAttrs): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (t) runs.push({t, ...(Object.keys(attrs).length > 0 ? {a: attrs} : {})});
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const next = {...attrs};
    const tag = node.tagName.toLowerCase();
    if (tag === 'b' || tag === 'strong') next.b = true;
    if (tag === 'i' || tag === 'em') next.i = true;
    if (tag === 'u') next.u = true;
    if (tag === 's' || tag === 'del') next.s = true;
    if (tag === 'code') next.c = true;
    if (tag === 'a') {
      const pageId = node.getAttribute('data-page-id');
      if (pageId) next.m = pageId;
      else if (node.getAttribute('href')) next.a = node.getAttribute('href')!;
    }
    if (tag === 'br') {
      runs.push({t: '\n'});
      return;
    }
    node.childNodes.forEach((child) => visit(child, next));
  };
  el.childNodes.forEach((child) => visit(child, {}));
  return runs;
}

/** Reactive context for migration: cell values + the name index, straight
 *  from the page snapshot (`values` / `names`). */
export interface MigrationContext {
  values?: Array<[string, unknown]>;
  names?: Array<[string, string]>;
  /** Page titles by id — gives subpage/database mentions their real names. */
  pageLabels?: Map<string, string>;
}

/** Rewrite an ExprBlock source: `__C__{cellId}__` tokens (and `@name` refs)
 *  become plain variable names, which is what the formula block evaluates. */
function rewriteExprSource(source: string, nameOf: Map<string, string>): string {
  return source
    .replace(/__C__\{([^}]+)\}__/g, (_, cellId: string) => nameOf.get(cellId) ?? `missing_${String(cellId).replace(/\W/g, '_')}`)
    .replace(/@([A-Za-z_][\w]*)/g, '$1');
}

/**
 * One-way migration of an EditorJS document into the block model. Every block
 * type the app ships maps to something — reactive blocks (slider/expr) become
 * the editor's reactive plugins, links to nested pages survive as mention
 * runs, derived blocks (toc) are skipped, and the rest degrade to readable
 * text. Nothing is lost silently — the original snapshot stays on the page.
 */
export function migrateEditorJs(blocks: EditorJsBlock[], ctx: MigrationContext = {}): NewBlock[] {
  const values = new Map(ctx.values ?? []);
  // names is [name, cellId][] — invert to cellId → name for token rewriting.
  const nameOf = new Map((ctx.names ?? []).map(([name, cellId]) => [cellId, name] as const));
  const out: NewBlock[] = [];
  for (const block of blocks) {
    const d = block.data ?? {};
    switch (block.type) {
    case 'paragraph':
      out.push({type: 'paragraph', text: htmlToRuns(String(d.text ?? ''))});
      break;
    case 'header':
      out.push({type: 'heading', text: htmlToRuns(String(d.text ?? '')), props: {level: Math.min(3, Number(d.level ?? 2))}});
      break;
    case 'quote':
      out.push({type: 'quote', text: htmlToRuns(String(d.text ?? ''))});
      break;
    case 'callout':
      out.push({type: 'callout', text: htmlToRuns(String(d.text ?? '')), props: {variant: String(d.variant ?? 'info')}});
      break;
    case 'code':
      out.push({type: 'code', text: String(d.code ?? ''), props: d.language ? {language: String(d.language)} : undefined});
      break;
    case 'delimiter':
    case 'divider':
      out.push({type: 'divider'});
      break;
    case 'list': {
      const kind = d.style === 'ordered' ? 'number' : 'bullet';
      const items = (d.items ?? []) as unknown[];
      for (const item of items) {
        const content = typeof item === 'string' ? item : String((item as {content?: string}).content ?? '');
        out.push({type: 'list', text: htmlToRuns(content), props: {kind}});
      }
      break;
    }
    case 'checklist': {
      const items = (d.items ?? []) as {text?: string; checked?: boolean}[];
      for (const item of items) {
        out.push({type: 'todo', text: htmlToRuns(String(item.text ?? '')), props: item.checked ? {checked: true} : undefined});
      }
      break;
    }
    case 'table': {
      const content = (d.content ?? []) as string[][];
      if (content.length > 0) {
        out.push({
          type: 'table',
          props: {header: Boolean(d.withHeadings)},
          children: content.map((row) => ({
            type: 'row' as const,
            children: row.map((cell) => ({type: 'cell' as const, text: htmlToRuns(cell)})),
          })),
        });
      }
      break;
    }
    case 'toc':
      break; // derived from headings — nothing to migrate
    case 'accordion': {
      // No toggle block (yet): keep both halves readable.
      if (d.title) out.push({type: 'heading', text: htmlToRuns(String(d.title)), props: {level: 3}});
      if (d.content) out.push({type: 'paragraph', text: htmlToRuns(String(d.content))});
      break;
    }
    case 'button': {
      const url = String(d.url ?? '');
      const label = String(d.label ?? '') || url;
      if (url || label) out.push({type: 'paragraph', text: [{t: label, ...(url ? {a: {a: url}} : {})}]});
      break;
    }
    case 'subpage': {
      const pageId = typeof d.pageId === 'string' ? d.pageId : '';
      if (pageId) {
        const label = ctx.pageLabels?.get(pageId);
        const icon = d.kind === 'database' ? '🗃' : '📄';
        out.push({
          type: 'paragraph',
          text: [{t: `${icon} ${label ?? (d.kind === 'database' ? 'Sub-database' : 'Sub-page')}`, a: {m: pageId}}],
        });
      }
      break;
    }
    case 'database': {
      const pageId = typeof d.pageId === 'string' ? d.pageId : '';
      if (pageId) {
        const label = ctx.pageLabels?.get(pageId);
        out.push({type: 'paragraph', text: [{t: `🗃 ${label ?? 'Inline database'}`, a: {m: pageId}}]});
      }
      break;
    }
    case 'slider': {
      const cellId = typeof d.cellId === 'string' ? d.cellId : '';
      const live = values.get(cellId);
      out.push({
        type: 'slider',
        props: {
          name: String(d.name ?? nameOf.get(cellId) ?? 'x'),
          min: Number(d.min ?? 0),
          max: Number(d.max ?? 100),
          value: typeof live === 'number' ? live : Number(d.initial ?? 50),
        },
      });
      break;
    }
    case 'expr': {
      out.push({type: 'formula', props: {source: rewriteExprSource(String(d.source ?? ''), nameOf)}});
      break;
    }
    case 'chart': {
      // No chart block yet — leave an honest, visible marker instead of
      // silently dropping it.
      out.push({type: 'callout', text: 'Chart block — not yet supported in the new editor.', props: {variant: 'warn'}});
      break;
    }
    default: {
      // Preserve what we can read; never silently drop content.
      const text = typeof d.text === 'string' ? d.text : '';
      if (text) out.push({type: 'paragraph', text: htmlToRuns(text)});
      break;
    }
    }
  }
  return out.length > 0 ? out : [{type: 'paragraph'}];
}
