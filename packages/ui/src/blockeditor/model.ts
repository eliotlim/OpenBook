import * as Y from 'yjs';
import {shortId} from '@book.dev/sdk';
import {isOrderKey, keyBetween, keysBetween, ORDER_KEY_REBALANCE_LENGTH} from './orderKeys';

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
  // A speaker note: editable on the page, shown only in the presenter view —
  // never to the audience deck or any export.
  | 'notes'
  // A native image (Assets A0). Leaf block — no text, no children; the picture
  // lives in props (`src` is a `data:` URL in phase-1, an `assetId` after A2).
  // See blockeditor/imageBlock.ts for props + ingest.
  | 'image'
  // An untrusted-HTML artifact rendered in a sandboxed iframe (SandboxedHtml).
  // Leaf block — no text, no children; the document lives in the asset store
  // (`assetId`). See blockeditor/htmlArtifactBlock.ts for props + ingest.
  | 'htmlArtifact'
  | 'divider'
  | 'columns'
  | 'column'
  | 'table'
  | 'row'
  | 'cell'
  | 'group'
  // Interactive-kit containers (June 2026). Tabs/accordion hold one child per
  // tab/section; each tab/section block holds arbitrary blocks. They reuse the
  // group container infra (child storage, DnD, lock context).
  | 'tabs'
  | 'tab'
  | 'accordion'
  | 'accordionsection';

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
  /** Text colour — a palette token (see `colors.ts`). */
  tc?: string;
  /** Highlight colour — a palette token. */
  hl?: string;
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
  'notes',
  'cell',
]);

/** Block types whose `children` hold ordinary blocks. */
export const CONTAINER_BLOCKS: ReadonlySet<BlockType> = new Set([
  'columns', 'column', 'table', 'row', 'group',
  'tabs', 'tab', 'accordion', 'accordionsection',
]);

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

/**
 * Coerce an untrusted plain object (e.g. from an AI `append_blocks` proposal)
 * into a {@link NewBlock}, recursing into `children`. Returns null for anything
 * that isn't a usable block. Keeps {@link makeBlock} fed only well-formed input
 * so a malformed model response can't corrupt the document — and unlike the old
 * flat `{type, text}` handling, it preserves rich-text runs, props, and nested
 * children, so the agent can build interactive kit inputs and layouts.
 */
export function coerceNewBlock(value: unknown): NewBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const type = typeof v.type === 'string' && v.type ? v.type : 'paragraph';
  const block: NewBlock = {type};
  if (typeof v.id === 'string') block.id = v.id;
  if (typeof v.text === 'string') {
    block.text = v.text;
  } else if (Array.isArray(v.text)) {
    const runs: TextRun[] = [];
    for (const r of v.text) {
      if (!r || typeof r !== 'object') continue;
      const run = r as {t?: unknown; a?: unknown};
      runs.push({t: String(run.t ?? ''), ...(run.a && typeof run.a === 'object' ? {a: run.a as InlineAttrs} : {})});
    }
    if (runs.length > 0) block.text = runs;
  }
  if (v.props && typeof v.props === 'object' && !Array.isArray(v.props)) block.props = v.props as Record<string, unknown>;
  if (Array.isArray(v.children)) {
    const kids = v.children.map(coerceNewBlock).filter((b): b is NewBlock => b !== null);
    if (kids.length > 0) block.children = kids;
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

/**
 * Rewrite a Y.Text to `next` with a MINIMAL splice: the shared leading prefix
 * and trailing suffix are left untouched, so only the changed middle is deleted
 * and reinserted. Better for cursors, collaboration, and inline formatting on
 * the unchanged ends than a full delete-all + reinsert.
 */
export function replaceText(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current[start] === next[start]) start += 1;
  let endC = current.length;
  let endN = next.length;
  while (endC > start && endN > start && current[endC - 1] === next[endN - 1]) {
    endC -= 1;
    endN -= 1;
  }
  if (endC > start) text.delete(start, endC - start);
  if (endN > start) text.insert(start, next.slice(start, endN));
}

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
 * Apply an optional `{type, props}` patch to a block IN PLACE — call from inside
 * a transaction. Like {@link turnInto} but the type is optional (props-only
 * updates keep the type) and there's no own transaction, so the agent bridge can
 * fold it into its single 'local' transaction. Turning into a text block adds an
 * empty Y.Text when missing.
 */
export function patchBlock(block: BlockMap, patch: {type?: string; props?: Record<string, unknown>}): void {
  if (patch.type) {
    block.set('type', patch.type);
    if (TEXT_BLOCKS.has(patch.type as BlockType) && !blockText(block)) block.set('text', new Y.Text());
  }
  if (patch.props) for (const [k, v] of Object.entries(patch.props)) setBlockProp(block, k, v);
}

/** Most columns a layout can hold (a 12-unit grid stays legible up to six). */
export const MAX_COLUMNS = 6;

/** Spread the 12 grid units evenly across a layout's columns (sum stays 12). */
function distributeSpans(columns: Y.Array<BlockMap>): void {
  const n = columns.length;
  if (n === 0) return;
  const base = Math.floor(12 / n);
  let rem = 12 - base * n;
  for (let i = 0; i < n; i += 1) {
    setBlockProp(columns.get(i), 'span', base + (rem > 0 ? 1 : 0));
    if (rem > 0) rem -= 1;
  }
}

/**
 * Make a columns layout: wraps `targetId` and the moved block `movedId`
 * side-by-side (moved goes left when `side === 'left'`). If `targetId` is
 * already a column's child, the moved block becomes a new adjacent column
 * instead (2 → 3 → … columns by dropping beside, up to {@link MAX_COLUMNS}).
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
      if (!columnsBlock || !columns || columns.length >= MAX_COLUMNS) return;
      const colIndex = indexOfBlock(columns, blockId(parentBlock));
      moved.parent.delete(moved.index, 1);
      const at = side === 'left' ? colIndex : colIndex + 1;
      columns.insert(at, [makeBlock({type: 'column', children: [movedJson]})]);
      distributeSpans(columns); // even out the widths as the layout grows
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

/**
 * Walk up from `id` (inclusive) to the nearest ancestor whose type is in
 * `types`, or null if there is none before the root. Used to redirect a paste
 * out of a table cell: a cell holds only text, so a container block inserted as
 * a cell sibling poisons the doc — callers insert after the enclosing table.
 */
export function enclosingBlock(
  doc: Y.Doc,
  id: string,
  types: ReadonlySet<BlockType>,
): {block: BlockMap; parent: Y.Array<BlockMap>; index: number} | null {
  let cur = findBlock(doc, id);
  while (cur) {
    if (types.has(blockType(cur.block))) return cur;
    const parent = parentBlockOf(doc, cur.parent);
    if (!parent) return null;
    cur = findBlock(doc, blockId(parent));
  }
  return null;
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

// ── Tables — the order contract (TBL-1) ─────────────────────────────────────
/**
 * TABLE ORDER CONTRACT — fractional order keys + stable column identity.
 * TBL-2 (drag-reorder), TBL-3 (context menus), TBL-4 (column colours) build
 * on exactly this; nothing else may define table order.
 *
 * Schema (all keys live in ordinary block `props`, so they survive the JSON
 * projection, snapshots, clipboard copy, and `cloneBlock` unchanged):
 *
 *   table.props['col:<colId>'] = <orderKey>   column registry: one entry per
 *                                             column — EXISTENCE defines the
 *                                             column, the value defines its
 *                                             position. `colId` is opaque and
 *                                             stable for the column's life
 *                                             (TBL-4 keys colours on it).
 *   row.props.ord              = <orderKey>   the row's position.
 *   cell.props.col             = <colId>      the column this cell belongs to
 *                                             — IMMUTABLE once set. A cell's
 *                                             index in its row array is NOT
 *                                             its column.
 *
 * Order keys are fractional base-62 strings (`orderKeys.ts`): plain string
 * `<` is the comparator. Render order:
 *   rows    — sort by (ord, id); rows without `ord` keep array order, after
 *             all keyed rows (only possible mid-merge with a legacy peer).
 *   columns — registry entries sorted by (key, id). A row's cells bind to
 *             columns by `props.col`; cells without one (legacy peer) fill
 *             the empty column slots left-to-right in array order; cells
 *             whose column id is NOT in the registry are hidden (their
 *             column was deleted concurrently) — content is never destroyed,
 *             just not rendered. `tableGrid()` is the single source of this
 *             ordering; render, navigation, projection/export, and every op
 *             below go through it.
 *
 * Invariants:
 *   1. MOVES REWRITE ONE KEY. `tableMoveRow` / `tableMoveColumn` write only
 *      the moved row's `ord` / the moved column's registry value. They NEVER
 *      delete, re-insert, or clone the row/cell CRDT nodes — concurrent cell
 *      edits inside a moved row/column merge cleanly. (`moveBlock`'s
 *      clone-based move is the anti-pattern here; never use it for grids.)
 *   2. One op = one `doc.transact(…, 'local')` = one undo step.
 *   3. LEGACY TABLES (empty registry) render in pure array order —
 *      byte-identical to the pre-TBL-1 renderer — and migrate lazily inside
 *      the first structural op's transaction. Migration is DETERMINISTIC
 *      (ids `c0…cN-1`, `keysBetween` spreads), so two peers migrating the
 *      same state write identical values and converge trivially.
 *   4. Structural indices (`rowIndex` / `colIndex` arguments) are positions
 *      in the SORTED render order, not Y.Array indices.
 *   5. The header row is simply the FIRST row in render order (when
 *      `props.header` is true) — moving a row above it changes the header.
 *   6. If a fresh key would exceed ORDER_KEY_REBALANCE_LENGTH (or bounds
 *      collide after a key tie), the op rewrites the whole axis with evenly
 *      spread keys in the same transaction. Rebalance is LWW-coarse (may
 *      override one concurrent move) but always converges.
 *
 * Op API (all clamp indices, all no-op on a missing table):
 *   makeTable(rows, cols)                          → NewBlock, born keyed
 *   tableInsertRow(doc, tableId, rowIndex)         row at sorted position
 *   tableInsertColumn(doc, tableId, colIndex)      registers a fresh colId +
 *                                                  one bound cell per row
 *   tableDeleteRow(doc, tableId, rowIndex)         deletes the row node
 *   tableDeleteColumn(doc, tableId, colIndex)      unregisters the column +
 *                                                  deletes its bound cells
 *   tableMoveRow(doc, tableId, rowId, toIndex)     key rewrite only
 *   tableMoveColumn(doc, tableId, colId, toIndex)  key rewrite only
 *   tableGrid(table)                               the sorted grid view
 *   tableColumns(table)                            sorted {id, key} registry
 *   cellPosition / cellNeighbor                    grid coordinates in
 *                                                  SORTED order (read-only —
 *                                                  they never migrate)
 *   `toIndex` is the target position with the moved row/column removed
 *   (same convention as `moveBlock`).
 */

/** Prefix of the column-registry entries in a table block's props. */
export const TABLE_COL_PREFIX = 'col:';

const rowOrd = (row: BlockMap): string | null => {
  const v = blockProp<unknown>(row, 'ord');
  return typeof v === 'string' && v.length > 0 ? v : null;
};

const cellCol = (cell: BlockMap): string | null => {
  const v = blockProp<unknown>(cell, 'col');
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/** The table's column registry, sorted into render order (key, then id). */
export function tableColumns(table: BlockMap): Array<{id: string; key: string}> {
  const props = table.get('props') as Y.Map<unknown> | undefined;
  if (!props) return [];
  const out: Array<{id: string; key: string}> = [];
  for (const [k, v] of props.entries()) {
    if (k.startsWith(TABLE_COL_PREFIX) && typeof v === 'string' && v.length > 0) {
      out.push({id: k.slice(TABLE_COL_PREFIX.length), key: v});
    }
  }
  out.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** The sorted grid view of a table — the ONLY definition of render order. */
export interface TableGrid {
  /** True once the table has a column registry (migrated / born keyed). */
  keyed: boolean;
  /** Row blocks in render order. */
  rows: BlockMap[];
  /** Column ids in render order (empty for a legacy table). */
  colIds: string[];
  /**
   * `cells[r][c]` is the cell of `rows[r]` in column `c` of the render order
   * (null = no cell there — a merge gap; render pads, projection emits an
   * empty cell). Legacy tables: the row's children verbatim (pure positional).
   * Keyless cells bound positionally may trail past `colIds.length`.
   */
  cells: (BlockMap | null)[][];
  /** Rendered column count (max slots over all rows; ≥ colIds.length). */
  width: number;
}

export function tableGrid(table: BlockMap): TableGrid {
  const rowsArr = blockChildren(table);
  const rawRows: BlockMap[] = rowsArr ? [...rowsArr] : [];
  const columns = tableColumns(table);
  const keyed = columns.length > 0;

  // Rows: keyed rows by (ord, id); keyless rows keep array order, after all
  // keyed rows (a transient mid-merge state — migration backfills them).
  const rows = rawRows
    .map((b, i) => ({b, i, k: rowOrd(b)}))
    .sort((x, y) => {
      if (x.k !== null && y.k !== null) {
        if (x.k !== y.k) return x.k < y.k ? -1 : 1;
        const xi = blockId(x.b);
        const yi = blockId(y.b);
        if (xi !== yi) return xi < yi ? -1 : 1;
        return x.i - y.i;
      }
      if (x.k !== null) return -1;
      if (y.k !== null) return 1;
      return x.i - y.i;
    })
    .map((e) => e.b);

  const colIndex = new Map(columns.map((c, i) => [c.id, i]));
  const cells: (BlockMap | null)[][] = rows.map((row) => {
    const raw: BlockMap[] = blockChildren(row) ? [...blockChildren(row)!] : [];
    if (!keyed) return raw; // legacy: pure positional, byte-identical render
    const slots: (BlockMap | null)[] = columns.map(() => null);
    const loose: BlockMap[] = [];
    for (const cell of raw) {
      const col = cellCol(cell);
      if (col === null) {
        loose.push(cell); // legacy-peer cell: binds positionally below
      } else {
        const idx = colIndex.get(col);
        if (idx === undefined) continue; // column deleted concurrently → hidden
        if (slots[idx] === null) slots[idx] = cell;
        else loose.push(cell); // duplicate binding (merge artifact) — keep visible
      }
    }
    let s = 0;
    for (const cell of loose) {
      while (s < slots.length && slots[s] !== null) s += 1;
      if (s < slots.length) slots[s] = cell;
      else slots.push(cell);
    }
    return slots;
  });

  const width = cells.reduce((m, r) => Math.max(m, r.length), 0);
  return {keyed, rows, colIds: columns.map((c) => c.id), cells, width};
}

/**
 * Lazy migration + backfill — call INSIDE a structural op's transaction.
 * Legacy table (no registry): registers deterministic columns `c0…cN-1` and
 * spreads row/column keys over the CURRENT array order, then binds every cell
 * by position. Partially keyed table (merged with a behind peer): appends
 * keys/bindings so the current render order is preserved. Idempotent.
 */
function ensureTableOrderInTx(table: BlockMap): void {
  const rowsArr = blockChildren(table);
  const rawRows: BlockMap[] = rowsArr ? [...rowsArr] : [];

  if (tableColumns(table).length === 0) {
    // Full migration — deterministic so concurrent migrations converge.
    const width = Math.max(1, ...rawRows.map((r) => blockChildren(r)?.length ?? 0));
    const colIds = Array.from({length: width}, (_, i) => `c${i}`);
    const colKeys = keysBetween(null, null, width);
    colIds.forEach((id, i) => setBlockProp(table, TABLE_COL_PREFIX + id, colKeys[i]));
    const rowKeys = keysBetween(null, null, rawRows.length);
    rawRows.forEach((row, r) => {
      if (rowOrd(row) === null) setBlockProp(row, 'ord', rowKeys[r]);
      const cellsArr = blockChildren(row);
      if (!cellsArr) return;
      for (let c = 0; c < cellsArr.length && c < width; c += 1) {
        const cell = cellsArr.get(c);
        if (blockType(cell) === 'cell' && cellCol(cell) === null) setBlockProp(cell, 'col', colIds[c]);
      }
    });
    return;
  }

  // Backfill a partially keyed table, preserving what is rendered today.
  const grid = tableGrid(table);
  let prev: string | null = null;
  for (const row of grid.rows) {
    const k = rowOrd(row);
    if (k !== null) {
      prev = k;
      continue;
    }
    if (prev !== null && !isOrderKey(prev)) {
      // Malformed foreign key would throw on append — rebalance repairs the axis,
      // rewriting every row's ord over the current render order (order preserved).
      const keys = keysBetween(null, null, grid.rows.length);
      grid.rows.forEach((r, i) => setBlockProp(r, 'ord', keys[i]));
      break;
    }
    const next = keyBetween(prev, null); // keyless rows render last — append
    setBlockProp(row, 'ord', next);
    prev = next;
  }
  // Register columns for slots beyond the registry (ragged legacy rows).
  const columns = tableColumns(table);
  const colIds = columns.map((c) => c.id);
  let lastKey: string | null = columns.length > 0 ? columns[columns.length - 1].key : null;
  const maxSlots = grid.cells.reduce((m, r) => Math.max(m, r.length), 0);
  if (colIds.length < maxSlots && lastKey !== null && !isOrderKey(lastKey)) {
    // Malformed foreign key would throw on append — rebalance repairs the axis,
    // rewriting every registry value over the current render order (order preserved).
    const keys = keysBetween(null, null, columns.length);
    columns.forEach((col, i) => setBlockProp(table, TABLE_COL_PREFIX + col.id, keys[i]));
    lastKey = keys[keys.length - 1] ?? null;
  }
  while (colIds.length < maxSlots) {
    const id = shortId('col');
    lastKey = keyBetween(lastKey, null);
    setBlockProp(table, TABLE_COL_PREFIX + id, lastKey);
    colIds.push(id);
  }
  grid.cells.forEach((slots) => {
    slots.forEach((cell, c) => {
      if (cell && blockType(cell) === 'cell' && cellCol(cell) === null && c < colIds.length) {
        setBlockProp(cell, 'col', colIds[c]);
      }
    });
  });
}

/**
 * A key between two bounds, or null when the axis needs a rebalance (bound
 * collision after a key tie, or the key has grown past the rebalance limit).
 */
function insertionKey(before: string | null, after: string | null): string | null {
  if (before !== null && after !== null && before >= after) return null;
  try {
    const key = keyBetween(before, after);
    return key.length > ORDER_KEY_REBALANCE_LENGTH ? null : key;
  } catch {
    return null; // malformed foreign key — rebalance repairs the axis
  }
}

/** A keyed table NewBlock from a grid of cell runs (paste / legacy import). */
export function tableFromRuns(grid: TextRun[][][], header: boolean): NewBlock {
  const width = Math.max(1, ...grid.map((r) => r.length));
  const colIds = Array.from({length: width}, (_, i) => `c${i}`);
  const colKeys = keysBetween(null, null, width);
  const rowKeys = keysBetween(null, null, grid.length);
  return {
    type: 'table',
    props: {header, ...Object.fromEntries(colIds.map((id, i) => [TABLE_COL_PREFIX + id, colKeys[i]]))},
    children: grid.map((cells, r) => ({
      type: 'row' as const,
      props: {ord: rowKeys[r]},
      children: cells.map((runs, c) => ({type: 'cell' as const, text: runs, props: {col: colIds[c]}})),
    })),
  };
}

export function makeTable(rows: number, cols: number): NewBlock {
  const colIds = Array.from({length: cols}, (_, i) => `c${i}`);
  const colKeys = keysBetween(null, null, cols);
  const rowKeys = keysBetween(null, null, rows);
  return {
    type: 'table',
    props: {header: true, ...Object.fromEntries(colIds.map((id, i) => [TABLE_COL_PREFIX + id, colKeys[i]]))},
    children: Array.from({length: rows}, (_, r) => ({
      type: 'row' as const,
      props: {ord: rowKeys[r]},
      children: colIds.map((id) => ({type: 'cell' as const, props: {col: id}})),
    })),
  };
}

/** Insert a row at sorted position `rowIndex` (clamped), one cell per column. */
export function tableInsertRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rowsArr = blockChildren(table.block);
    if (!rowsArr) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    const at = Math.max(0, Math.min(rowIndex, grid.rows.length));
    const before = at > 0 ? rowOrd(grid.rows[at - 1]) : null;
    const after = at < grid.rows.length ? rowOrd(grid.rows[at]) : null;
    let ord = insertionKey(before, after);
    if (ord === null) {
      const keys = keysBetween(null, null, grid.rows.length + 1);
      grid.rows.forEach((row, i) => setBlockProp(row, 'ord', keys[i < at ? i : i + 1]));
      ord = keys[at];
    }
    rowsArr.insert(Math.min(at, rowsArr.length), [
      makeBlock({type: 'row', props: {ord}, children: tableColumns(table.block).map((c) => ({type: 'cell' as const, props: {col: c.id}}))}),
    ]);
  }, 'local');
}

/** Insert a column at sorted position `colIndex`: register id, add bound cells. */
export function tableInsertColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    if (!blockChildren(table.block)) return;
    ensureTableOrderInTx(table.block);
    const columns = tableColumns(table.block);
    const at = Math.max(0, Math.min(colIndex, columns.length));
    const before = at > 0 ? columns[at - 1].key : null;
    const after = at < columns.length ? columns[at].key : null;
    let key = insertionKey(before, after);
    if (key === null) {
      const keys = keysBetween(null, null, columns.length + 1);
      columns.forEach((c, i) => setBlockProp(table.block, TABLE_COL_PREFIX + c.id, keys[i < at ? i : i + 1]));
      key = keys[at];
    }
    const id = shortId('col');
    setBlockProp(table.block, TABLE_COL_PREFIX + id, key);
    const rowsArr = blockChildren(table.block)!;
    for (let r = 0; r < rowsArr.length; r += 1) {
      const cells = blockChildren(rowsArr.get(r));
      if (cells) cells.insert(Math.max(0, Math.min(at, cells.length)), [makeBlock({type: 'cell', props: {col: id}})]);
    }
  }, 'local');
}

/** Delete the row at sorted position `rowIndex`; the last row removes the table. */
export function tableDeleteRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rowsArr = blockChildren(table.block);
    if (!rowsArr) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    if (rowIndex < 0 || rowIndex >= grid.rows.length) return;
    if (grid.rows.length === 1) {
      removeBlockInTx(doc, tableId);
      return;
    }
    const arrayIndex = indexOfBlock(rowsArr, blockId(grid.rows[rowIndex]));
    if (arrayIndex >= 0) rowsArr.delete(arrayIndex, 1);
  }, 'local');
}

/** Delete the column at sorted position `colIndex` (registry + bound cells). */
export function tableDeleteColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    if (!blockChildren(table.block)) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    if (colIndex < 0 || colIndex >= grid.colIds.length) return;
    if (grid.colIds.length === 1) {
      removeBlockInTx(doc, tableId);
      return;
    }
    setBlockProp(table.block, TABLE_COL_PREFIX + grid.colIds[colIndex], undefined);
    grid.rows.forEach((row, r) => {
      const cell = grid.cells[r][colIndex];
      if (!cell) return;
      const cellsArr = blockChildren(row);
      if (!cellsArr) return;
      const idx = indexOfBlock(cellsArr, blockId(cell));
      if (idx >= 0) cellsArr.delete(idx, 1);
    });
  }, 'local');
}

/**
 * Move a row to sorted position `toIndex` (counted with the row removed).
 * Rewrites ONLY the row's order key — the row and its cells are untouched, so
 * concurrent cell edits inside it merge cleanly.
 */
export function tableMoveRow(doc: Y.Doc, tableId: string, rowId: string, toIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    const from = grid.rows.findIndex((r) => blockId(r) === rowId);
    if (from < 0) return;
    const moved = grid.rows[from];
    const rest = grid.rows.filter((_, i) => i !== from);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    const before = at > 0 ? rowOrd(rest[at - 1]) : null;
    const after = at < rest.length ? rowOrd(rest[at]) : null;
    const ord = insertionKey(before, after);
    if (ord !== null) {
      setBlockProp(moved, 'ord', ord);
      return;
    }
    const final = [...rest.slice(0, at), moved, ...rest.slice(at)];
    const keys = keysBetween(null, null, final.length);
    final.forEach((row, i) => setBlockProp(row, 'ord', keys[i]));
  }, 'local');
}

/**
 * Move a column to sorted position `toIndex` (counted with it removed).
 * Rewrites ONLY the column's registry key — no cell is touched, so concurrent
 * edits in that column (and concurrent column inserts) merge cleanly.
 */
export function tableMoveColumn(doc: Y.Doc, tableId: string, colId: string, toIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    ensureTableOrderInTx(table.block);
    const columns = tableColumns(table.block);
    const from = columns.findIndex((c) => c.id === colId);
    if (from < 0) return;
    const rest = columns.filter((_, i) => i !== from);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    const before = at > 0 ? rest[at - 1].key : null;
    const after = at < rest.length ? rest[at].key : null;
    const key = insertionKey(before, after);
    if (key !== null) {
      setBlockProp(table.block, TABLE_COL_PREFIX + colId, key);
      return;
    }
    const final = [...rest.slice(0, at), columns[from], ...rest.slice(at)];
    const keys = keysBetween(null, null, final.length);
    final.forEach((c, i) => setBlockProp(table.block, TABLE_COL_PREFIX + c.id, keys[i]));
  }, 'local');
}

/**
 * Locate a cell within its table: row/column indices plus the table block.
 * Powers cell navigation (Tab/Enter) — cells are blocks, but movement inside
 * a table is grid-shaped, not list-shaped. Coordinates are RENDER (sorted)
 * order, per the table order contract. Read-only — never migrates.
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
  const grid = tableGrid(table);
  const row = grid.rows.indexOf(rowBlock);
  if (row < 0) return null;
  const col = grid.cells[row].indexOf(cell.block);
  if (col < 0) return null; // orphaned cell (its column was deleted)
  return {table, row, col, rows: grid.rows.length, cols: grid.width};
}

/**
 * The neighbouring cell id for grid navigation, in RENDER (sorted) order.
 * `next`/`prev` move within the row and wrap across rows; `down`/`up` move
 * within the column. Returns null at the table's edge or a grid gap (callers
 * may grow the table and retry).
 */
export function cellNeighbor(doc: Y.Doc, cellId: string, dir: 'next' | 'prev' | 'down' | 'up'): string | null {
  const pos = cellPosition(doc, cellId);
  if (!pos) return null;
  const grid = tableGrid(pos.table);
  let {row, col} = pos;
  if (dir === 'next') {
    col += 1;
    if (col >= grid.width) {
      col = 0;
      row += 1;
    }
  } else if (dir === 'prev') {
    col -= 1;
    if (col < 0) {
      col = grid.width - 1;
      row -= 1;
    }
  } else {
    row += dir === 'down' ? 1 : -1;
  }
  if (row < 0 || row >= grid.rows.length) return null;
  const cell = grid.cells[row][col];
  if (!cell || blockType(cell) !== 'cell') return null;
  return blockId(cell);
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
  if (children) json.children = blockType(b) === 'table' ? tableChildrenToJSON(b) : children.map(blockToJSON);
  return json;
}

/**
 * A table's rows/cells projected in RENDER order (the table order contract):
 * rows sorted by `ord`, each row's cells in column order. Grid gaps in the
 * middle become empty placeholder cells (so downstream consumers stay
 * positional); trailing gaps are trimmed. Legacy tables project verbatim.
 */
function tableChildrenToJSON(table: BlockMap): BlockJSON[] {
  const grid = tableGrid(table);
  return grid.rows.map((row, r) => {
    const json = blockToJSON(row);
    if (blockType(row) !== 'row') return json; // malformed child — verbatim
    const slots = grid.cells[r];
    let end = slots.length;
    while (end > 0 && slots[end - 1] === null) end -= 1;
    json.children = slots
      .slice(0, end)
      .map((cell, c) => (cell ? blockToJSON(cell) : {id: `${blockId(row)}-void-${c}`, type: 'cell' as const, text: []}));
    return json;
  });
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

// ── Legacy migration ─────────────────────────────────────────────────────────

/** A legacy stored block (`{type, data}`) — the migrate-on-open input shape. */
interface LegacyBlock {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

/** Strip a legacy HTML string into rich runs (b/i/code/links survive). */
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

/** A reference to an `<img>` — its `src` plus alt/title, for {@link HtmlToBlocksOptions.onImage}. */
export interface HtmlImageRef {
  src: string;
  alt?: string;
  title?: string;
}

/** Clamp an HTML span attribute (`colspan`/`rowspan`) to a sane positive int.
 *  Guards against non-numeric, zero, negative, and pathologically large spans. */
const cellSpanAttr = (cell: HTMLElement, attr: 'colspan' | 'rowspan'): number => {
  const raw = Number(cell.getAttribute(attr) ?? '1');
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.floor(raw), 1000);
};

/**
 * The `<tr>` that belong *directly* to `table` — never to a table nested inside
 * one of its cells. Notion's clipboard HTML nests tables inside cells and wraps
 * rows in `thead`/`tbody`/`tfoot` (plus `colgroup`/spacer noise); an unscoped
 * `querySelectorAll('tr')` would splice a nested table's rows into the outer
 * grid. Scoping to `:scope > …` keeps each table's rows to itself.
 */
const directTableRows = (table: HTMLElement): HTMLElement[] => [
  ...table.querySelectorAll<HTMLElement>(':scope > thead > tr'),
  ...table.querySelectorAll<HTMLElement>(':scope > tbody > tr'),
  ...table.querySelectorAll<HTMLElement>(':scope > tfoot > tr'),
  ...table.querySelectorAll<HTMLElement>(':scope > tr'),
];

/** A cell's rich runs, with any table nested inside it flattened to plain text
 *  (the block model has no nested-table cell) — its text is folded into the
 *  cell rather than dropped or exploded into the outer grid. */
const cellToRuns = (cell: HTMLElement): TextRun[] => {
  if (cell.querySelector('table') === null) return htmlToRuns(cell.innerHTML);
  const clone = cell.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('table').forEach((nested) => {
    // Join the nested cells' text with spaces so flattening reads as words, not
    // a run-together blob (`x y`, not `xy`); fall back to raw text if cell-less.
    const cells = [...nested.querySelectorAll('td, th')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
    const flat = cells.length > 0 ? cells.filter(Boolean).join(' ') : (nested.textContent ?? '').replace(/\s+/g, ' ').trim();
    nested.replaceWith(document.createTextNode(flat));
  });
  return htmlToRuns(clone.innerHTML);
};

/**
 * Turn a (possibly ragged, colspan/rowspan-laden, spacer-row-ridden) HTML
 * `<table>` into a rectangular grid of cell runs. colspan/rowspan expand into
 * distinct grid cells (origin keeps the content, spanned positions are blank);
 * short rows pad to the widest row; structural/spacer rows (no direct cells,
 * nothing carried in) and fully-blank rows drop out. The result always yields a
 * well-formed table → row → cell tree the editor can render.
 */
const normalizeTableGrid = (table: HTMLElement): TextRun[][][] => {
  const grid: TextRun[][][] = [];
  // column → number of further rows a rowspan still occupies (blank continuation)
  const carry = new Map<number, number>();
  for (const tr of directTableRows(table)) {
    const cells = [...tr.querySelectorAll<HTMLElement>(':scope > td, :scope > th')];
    const carried = [...carry.values()].some((n) => n > 0);
    // A structural/spacer row (e.g. Notion's spacer <tr>): nothing to place and
    // nothing carried into it — skip entirely.
    if (cells.length === 0 && !carried) continue;
    const row: TextRun[][] = [];
    let col = 0;
    const skipCarried = (): void => {
      while ((carry.get(col) ?? 0) > 0) {
        row[col] = [];
        carry.set(col, carry.get(col)! - 1);
        col += 1;
      }
    };
    for (const cell of cells) {
      skipCarried();
      const runs = cellToRuns(cell);
      const cspan = cellSpanAttr(cell, 'colspan');
      const rspan = cellSpanAttr(cell, 'rowspan');
      for (let c = 0; c < cspan; c += 1) {
        row[col + c] = c === 0 ? runs : [];
        if (rspan > 1) carry.set(col + c, rspan - 1);
      }
      col += cspan;
    }
    // Drain rowspan carries not reached by a cell in this row (gaps / trailing).
    skipCarried();
    for (const [c, n] of carry) {
      if (n > 0 && row[c] === undefined) {
        row[c] = [];
        carry.set(c, n - 1);
      }
    }
    grid.push(row);
  }
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of grid) for (let c = 0; c < width; c += 1) if (r[c] === undefined) r[c] = [];
  // Note: only truly cell-less structural rows are dropped (skipped above). A row
  // with real `<td>`/`<th>` cells is kept even if blank — its cell may carry an
  // image (emitted separately) or be an intentionally empty grid cell.
  return grid;
};

/** Options for {@link htmlToBlocks}. */
export interface HtmlToBlocksOptions {
  /**
   * Map an `<img>` to a block. Supplied by the HTML *importer* (which returns a
   * visible image-placeholder block preserving the src/alt), so an image is
   * never silently dropped. Omitted for clipboard paste — where, as today,
   * images fall away (the editor has no inline-image block yet). Returning `null`
   * drops the image (e.g. an empty `<img>` with nothing worth keeping).
   */
  onImage?: (img: HtmlImageRef) => NewBlock | null;
}

const imageRefOf = (img: HTMLElement): HtmlImageRef => {
  const src = img.getAttribute('src') ?? '';
  const alt = img.getAttribute('alt')?.trim();
  const title = img.getAttribute('title')?.trim();
  return {src, ...(alt ? {alt} : {}), ...(title ? {title} : {})};
};

/**
 * Parse clipboard/external HTML into blocks: top-level block elements map to
 * block types, inline markup folds into rich runs (via {@link htmlToRuns}),
 * lists flatten to one block per item, tables come across whole. Anything
 * unrecognized degrades to a paragraph with its text — never dropped.
 *
 * With {@link HtmlToBlocksOptions.onImage} (the HTML importer's path), every
 * `<img>` — standalone, in a `<figure>`, or tucked inside a paragraph / list
 * item / table cell — is mapped to a block instead of being dropped by the
 * text-only `htmlToRuns`. Without it (clipboard paste) the behaviour is
 * unchanged.
 */
export function htmlToBlocks(html: string, opts: HtmlToBlocksOptions = {}): NewBlock[] {
  if (typeof document === 'undefined') return [{type: 'paragraph', text: html.replace(/<[^>]+>/g, '')}];
  const root = document.createElement('div');
  root.innerHTML = html;
  const out: NewBlock[] = [];

  // Emit an image block for every <img> in `el` (importer path only) — used after
  // a text-bearing block so an image inside a paragraph / list item / cell is
  // preserved rather than dropped by the text-only `htmlToRuns`. A no-op for
  // clipboard paste (no `onImage`), keeping that path byte-for-byte unchanged.
  const emitImagesIn = (el: HTMLElement): void => {
    if (!opts.onImage) return;
    el.querySelectorAll('img').forEach((img) => {
      const block = opts.onImage!(imageRefOf(img as HTMLElement));
      if (block) out.push(block);
    });
  };

  // An inline-ish / unrecognised element at the top level: fold its whole subtree
  // to a single rich paragraph (via `htmlToRuns` over `outerHTML`), then emit any
  // images (importer path only). This is the original `default` behaviour, shared
  // so the paste path keeps folding a `<figure>`/`<figcaption>` exactly as before.
  const foldInline = (el: HTMLElement): void => {
    const runs = htmlToRuns(el.outerHTML);
    if (runs.some((r) => r.t.trim())) out.push({type: 'paragraph', text: runs});
    emitImagesIn(el);
  };

  const pushListItems = (listEl: HTMLElement, kind: 'bullet' | 'number'): void => {
    listEl.querySelectorAll(':scope > li').forEach((li) => {
      const checkbox = li.querySelector(':scope > input[type="checkbox"]');
      const clone = li.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('ul, ol, input').forEach((nested) => nested.remove());
      const runs = htmlToRuns(clone.innerHTML);
      if (checkbox) {
        out.push({type: 'todo', text: runs, props: (checkbox as HTMLInputElement).checked ? {checked: true} : undefined});
      } else {
        out.push({type: 'list', text: runs, props: {kind}});
      }
      // The clone has nested lists stripped, so this catches only THIS item's own
      // images (a nested list's images come through when it is recursed below).
      emitImagesIn(clone);
      li.querySelectorAll(':scope > ul').forEach((ul) => pushListItems(ul as HTMLElement, 'bullet'));
      li.querySelectorAll(':scope > ol').forEach((ol) => pushListItems(ol as HTMLElement, 'number'));
    });
  };

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').trim();
      if (t) out.push({type: 'paragraph', text: [{t}]});
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      out.push({type: 'heading', text: htmlToRuns(node.innerHTML), props: {level: Math.min(3, Number(tag[1]))}});
      emitImagesIn(node);
      return;
    case 'p': {
      const runs = htmlToRuns(node.innerHTML);
      // Paste keeps an empty <p> (unchanged); the importer skips an image-only
      // paragraph so no blank line precedes the placeholder emitted next.
      if (!opts.onImage || runs.some((r) => r.t.trim())) out.push({type: 'paragraph', text: runs});
      emitImagesIn(node);
      return;
    }
    case 'ul':
      pushListItems(node, 'bullet');
      return;
    case 'ol':
      pushListItems(node, 'number');
      return;
    case 'blockquote':
      out.push({type: 'quote', text: htmlToRuns(node.innerHTML)});
      emitImagesIn(node);
      return;
    case 'pre':
      out.push({type: 'code', text: node.textContent ?? ''});
      emitImagesIn(node);
      return;
    case 'hr':
      out.push({type: 'divider'});
      return;
    case 'img':
      if (opts.onImage) {
        const block = opts.onImage(imageRefOf(node));
        if (block) out.push(block);
      }
      return;
    case 'figure':
    case 'figcaption':
      // Importer path: recurse so the <img> (+ caption) each map through their own
      // case rather than collapsing to text — the image is thereby preserved. Paste
      // path (no `onImage`): fold to one rich paragraph, exactly as `default` did
      // before figures were special-cased, keeping clipboard paste byte-identical.
      if (opts.onImage) {
        node.childNodes.forEach(visit);
        return;
      }
      foldInline(node);
      return;
    case 'table': {
      // Scoped + rectangular: nested tables stay in their own cell, colspan/
      // rowspan expand, ragged rows pad, spacer rows drop — so a Notion-shaped
      // clipboard table can never produce a malformed block tree (which used to
      // throw on render and white-screen the app).
      const rows = normalizeTableGrid(node);
      if (rows.length > 0) {
        const firstRow = directTableRows(node)[0];
        out.push(tableFromRuns(rows, firstRow?.querySelector(':scope > th') != null));
      }
      // A cell holds only inline text, so an image in one would vanish — keep it
      // as a placeholder block after the table (importer path only).
      emitImagesIn(node);
      return;
    }
    case 'div':
    case 'section':
    case 'article':
    case 'body':
      node.childNodes.forEach(visit);
      return;
    case 'br':
    case 'style':
    case 'script':
    case 'meta':
      return;
    default:
      // Inline-ish element at the top level: fold it (and following inline
      // siblings would each become paragraphs — acceptable for pastes).
      foldInline(node);
    }
  };
  root.childNodes.forEach(visit);
  return out;
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
 * One-way migration of a legacy stored document into the block model. Every
 * block type the app ships maps to something — reactive blocks (slider/expr)
 * become the editor's reactive plugins, links to nested pages survive as
 * mention runs, derived blocks (toc) are skipped, and the rest degrade to
 * readable text. Nothing is lost silently — the original snapshot stays on the
 * page. Kept as the on-open path for pre-existing pages that lack a `blockdoc`;
 * new pages are born block-native (see sdk `textSnapshot`).
 */
export function migrateLegacyBlocks(blocks: LegacyBlock[], ctx: MigrationContext = {}): NewBlock[] {
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
        out.push(tableFromRuns(content.map((row) => row.map((cell) => htmlToRuns(cell))), Boolean(d.withHeadings)));
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
        // An inline database migrates to a live embedded view (dbview block).
        out.push({type: 'dbview', props: {pageId, name: label ?? 'Inline database'}});
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
