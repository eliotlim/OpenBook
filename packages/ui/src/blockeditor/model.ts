import * as Y from 'yjs';
import {
  CONTAINER_BLOCK_TYPES,
  shortId,
  TABLE_COLUMN_MIN_WIDTH,
  TABLE_COLW_PREFIX,
  TEXT_BLOCK_TYPES,
  type CoreBlockType,
} from '@book.dev/sdk';
export {TABLE_COLUMN_MIN_WIDTH, TABLE_COLW_PREFIX} from '@book.dev/sdk';
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

/**
 * The core block `type` union. Defined by the SDK's block-type catalogue
 * (`@book.dev/sdk` blockCatalogue.ts) — the shared, types-only source of truth
 * the server agent and MCP server also validate against — so the editor and
 * the write paths cannot drift apart. Notable members: `notes` (a speaker
 * note, presenter view only), `image` (native picture leaf — props in
 * blockeditor/imageBlock.ts), `htmlArtifact` (sandboxed-iframe HTML leaf —
 * props in blockeditor/htmlArtifactBlock.ts), and the interactive-kit
 * containers `tabs`/`tab`/`accordion`/`accordionsection` (June 2026), which
 * reuse the group container infra (child storage, DnD, lock context).
 */
export type BlockType = CoreBlockType;

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

/** Ephemeral render-order coordinates for a selected table-cell rectangle. */
export interface CellSelection {
  tableId: string;
  anchor: {row: number; col: number};
  focus: {row: number; col: number};
}

/** The JSON projection of a block (exports, server, tests). */
export interface BlockJSON {
  id: string;
  type: AnyBlockType;
  text?: TextRun[];
  props?: Record<string, unknown>;
  children?: BlockJSON[];
}

/** Block types that carry editable rich text — the catalogue's `text` nature. */
export const TEXT_BLOCKS: ReadonlySet<BlockType> = TEXT_BLOCK_TYPES;

/** Block types whose `children` hold ordinary blocks — the catalogue's
 *  `container` nature. */
export const CONTAINER_BLOCKS: ReadonlySet<BlockType> = CONTAINER_BLOCK_TYPES;

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

/**
 * The top-most, document-ordered subset of `ids`: ids that are descendants of
 * another id in the set collapse into their ancestor, and the survivors come
 * back in pre-order (the order they appear in the document). Missing ids drop.
 */
export function orderedTopMost(doc: Y.Doc, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const kept = new Set<string>();
  for (const id of set) {
    let isDescendant = false;
    for (const other of set) {
      if (other === id) continue;
      const found = findBlock(doc, other);
      const children = found ? blockChildren(found.block) : undefined;
      if (children) {
        for (const entry of walkBlocks(children)) {
          if (blockId(entry.block) === id) {
            isDescendant = true;
            break;
          }
        }
      }
      if (isDescendant) break;
    }
    if (!isDescendant && findBlock(doc, id)) kept.add(id);
  }
  const order: string[] = [];
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const id = blockId(block);
    if (kept.has(id)) order.push(id);
  }
  return order;
}

/**
 * Move MANY blocks to `toIndex` of the array identified by `targetParentId`
 * (`null` = the root list) in ONE transaction — one undo step, one broadcast —
 * so a multi-block drag lands and reverts atomically.
 *
 * `toIndex` follows {@link moveBlock}'s caller contract: it is a *current-doc*
 * index into the target array (the slot the drop target reports, before any
 * removal); the movers land contiguously there in document order. Forward moves
 * inside the same parent are adjusted for the gap the removals open.
 *
 * Like `moveBlock`, each block is re-inserted via clone (Yjs forbids
 * re-parenting an attached type), so a concurrent *remote* text edit to a moved
 * block is lost. That is the accepted trade-off for a deliberate local reorder.
 *
 *  - ids that are descendants of another moved id collapse to the top-most;
 *  - a block whose subtree contains the target parent is skipped (a container
 *    can't nest into itself) — the guard is applied per moved block.
 */
export function moveBlocks(doc: Y.Doc, ids: Iterable<string>, targetParentId: string | null, toIndex: number): void {
  doc.transact(() => {
    const target =
      targetParentId === null ? rootBlocks(doc) : blockChildren(findBlock(doc, targetParentId)?.block as BlockMap);
    if (!target) return;

    // Top-most, document-ordered, target-safe movers.
    const moving = orderedTopMost(doc, ids).filter((id) => {
      if (targetParentId === null) return true;
      if (id === targetParentId) return false;
      const found = findBlock(doc, id);
      if (!found) return false;
      // Refuse dropping a container into its own subtree.
      const children = blockChildren(found.block);
      if (children) {
        for (const entry of walkBlocks(children)) {
          if (blockId(entry.block) === targetParentId) return false;
        }
      }
      return true;
    });
    if (moving.length === 0) return;

    // Snapshot the movers (clone off still-attached maps) and count how many sit
    // in the target array before the insertion point — each opens a one-slot gap
    // once removed, so the effective insert index shifts left by that many.
    const clones: BlockMap[] = [];
    let shift = 0;
    for (const id of moving) {
      const found = findBlock(doc, id);
      if (!found) continue;
      if (found.parent === target && found.index < toIndex) shift += 1;
      clones.push(cloneBlock(found.block));
    }

    // Remove each mover (re-find by id — earlier deletes shift indices).
    for (const id of moving) {
      const found = findBlock(doc, id);
      if (found) found.parent.delete(found.index, 1);
    }

    const at = Math.max(0, Math.min(toIndex - shift, target.length));
    target.insert(at, clones);
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
 *
 * Props are merged SHALLOWLY: omitted keys are untouched, and an explicit `null`
 * (or `undefined`) REMOVES the key. `null` is load-bearing because a patch can
 * arrive over JSON — an agent proposal or an MCP `update_block_props` suggestion,
 * where `undefined` cannot survive serialization — so `null` is the only wire-level
 * way to say "clear this prop", and both paths must land identically.
 */
export function patchBlock(block: BlockMap, patch: {type?: string; props?: Record<string, unknown>}): void {
  if (patch.type) {
    block.set('type', patch.type);
    if (TEXT_BLOCKS.has(patch.type as BlockType) && !blockText(block)) block.set('text', new Y.Text());
  }
  if (patch.props) for (const [k, v] of Object.entries(patch.props)) setBlockProp(block, k, v === null ? undefined : v);
}

/** Most columns a layout can hold (a 12-unit grid stays legible up to six). */
export const MAX_COLUMNS = 6;

/** Total units in a columns layout. */
export const COLUMN_GRID_UNITS = 12;

/**
 * Make a possibly partial/stale span list fill the 12-unit grid. Authored
 * widths are kept where possible; a wholly missing layout gets an even split,
 * then any remaining deficit/excess is repaired without taking a column below 1.
 */
export function normalizeColumnSpans(spans: readonly (number | undefined)[]): number[] {
  if (spans.length === 0) return [];
  const fallback = Math.max(1, Math.floor(COLUMN_GRID_UNITS / spans.length));
  let fallbackRemainder = spans.every((span) => !Number.isFinite(span))
    ? Math.max(0, COLUMN_GRID_UNITS - fallback * spans.length)
    : 0;
  const normalized = spans.map((span) => {
    if (Number.isFinite(span)) return Math.max(1, Math.min(COLUMN_GRID_UNITS, Math.round(span!)));
    if (fallbackRemainder <= 0) return fallback;
    fallbackRemainder -= 1;
    return fallback + 1;
  });
  let delta = COLUMN_GRID_UNITS - normalized.reduce((sum, span) => sum + span, 0);
  for (let i = normalized.length - 1; i >= 0 && delta !== 0; i -= 1) {
    if (delta > 0) {
      normalized[i] += delta;
      delta = 0;
    } else {
      const shrink = Math.min(normalized[i] - 1, -delta);
      normalized[i] -= shrink;
      delta += shrink;
    }
  }
  return normalized;
}

/**
 * Move the boundary after `boundaryIndex` to an absolute grid unit. The
 * adjacent donor is consumed first, then columns farther away, so a 1-unit
 * neighbour never pins the resize handle.
 */
export function resizeColumnBoundary(
  spans: readonly number[],
  boundaryIndex: number,
  target: number,
): number[] {
  const next = normalizeColumnSpans(spans);
  if (boundaryIndex < 0 || boundaryIndex >= next.length - 1) return next;
  const leftCount = boundaryIndex + 1;
  const rightCount = next.length - leftCount;
  const wanted = Math.max(leftCount, Math.min(COLUMN_GRID_UNITS - rightCount, Math.round(target)));
  const current = next.slice(0, leftCount).reduce((sum, span) => sum + span, 0);

  if (wanted > current) {
    let remaining = wanted - current;
    for (let i = boundaryIndex + 1; i < next.length && remaining > 0; i += 1) {
      const taken = Math.min(next[i] - 1, remaining);
      next[i] -= taken;
      next[boundaryIndex] += taken;
      remaining -= taken;
    }
  } else if (wanted < current) {
    let remaining = current - wanted;
    for (let i = boundaryIndex; i >= 0 && remaining > 0; i -= 1) {
      const taken = Math.min(next[i] - 1, remaining);
      next[i] -= taken;
      next[boundaryIndex + 1] += taken;
      remaining -= taken;
    }
  }
  return next;
}

/** Absolute grid boundary under an internal separator's pointer. */
export function columnBoundaryFromPointer(
  pointerX: number,
  containerLeft: number,
  pitch: number,
  gap: number,
): number {
  return Math.round((pointerX - containerLeft + gap / 2) / pitch);
}

/** Boundary before the last column when its trailing edge is dragged. */
export function trailingColumnBoundaryFromPointer(
  pointerX: number,
  startPointerX: number,
  startBoundary: number,
  pitch: number,
): number {
  return startBoundary - Math.round((pointerX - startPointerX) / pitch);
}

/** Spread the 12 grid units across a layout's columns (sum stays 12). */
function distributeSpans(columns: Y.Array<BlockMap>): void {
  const n = columns.length;
  if (n === 0) return;
  const spans = normalizeColumnSpans(Array<number | undefined>(n).fill(undefined));
  for (let i = 0; i < n; i += 1) {
    setBlockProp(columns.get(i), 'span', spans[i]);
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

/** Delete every CRDT element carrying one logical block id (concurrent idempotent materialisation may create twins). */
function deleteBlocksById(arr: Y.Array<BlockMap>, id: string): void {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (blockId(arr.get(i)) === id) arr.delete(i, 1);
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
 * Order keys are fractional base-62 strings (`orderKeys.ts`, which re-exports
 * the shared implementation from `@book.dev/sdk` — the SERVER-SIDE twin of these
 * ops, `packages/sdk/src/tableSnapshot.ts`, mints keys with the same algebra so
 * a table migrated by the MCP tools and one migrated here are identical; the
 * cross-path invariant is pinned by `__tests__/tableOpParity.test.ts`): plain
 * string `<` is the comparator. Render order:
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
 *   tableDuplicateRow(doc, tableId, rowIndex)      clones a row (fresh ids,
 *                                                  same col bindings + content)
 *   tableDeleteRow(doc, tableId, rowIndex)         deletes the row node
 *   tableDeleteColumn(doc, tableId, colIndex)      unregisters the column +
 *                                                  deletes its bound cells
 *   tableDeleteRowRange(doc, tableId, top, bottom) the range variants (TBL-6) —
 *   tableDeleteColumnRange(doc, id, left, right)   one transact for the whole set
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

/**
 * Prefix of the per-column colour entries (TBL-4). One entry per tinted column:
 *   table.props['colbg:<colId>'] = <palette token>
 * Keyed on the STABLE `colId` (not a render index), so a column tint survives
 * reorder (moves rewrite only the `col:` order key), concurrent inserts (a new
 * cell in a tinted column inherits via the colId → token lookup — nothing is
 * stored per cell), and clipboard/clone (it rides in table props like the `col:`
 * registry). A ROW tint is the ordinary block `bg` prop on the row block, so a
 * duplicated row keeps it for free ({@link tableDuplicateRow} clones props). A
 * CELL tint (TBL-6) is likewise the ordinary block `bg` prop, on the cell block.
 * At render/export a cell composites CELL-over-ROW-over-COLUMN (see
 * {@link tableCellColor}).
 */
export const TABLE_COLBG_PREFIX = 'colbg:';

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
        // Two peers may materialise the SAME deterministic split cell at once.
        // Treat equal block ids as one logical cell; a genuinely different
        // duplicate binding remains loose/visible per the TBL-1 repair contract.
        else if (blockId(slots[idx]!) !== blockId(cell)) loose.push(cell);
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

/**
 * Insert a row at sorted position `rowIndex` (clamped), one cell per column.
 * Merge-aware (TBL-8): inserting STRICTLY INSIDE a vertical span extends it —
 * the crossing anchors gain a row of `rowspan` and the new row gets NO cells in
 * the covered columns (they stay null slots). Inserting at a span's top or
 * bottom edge does not extend it (the new row sits outside the merge).
 */
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
    // Spans the insertion line crosses: extend them, and remember their columns
    // so the fresh row leaves those slots empty (covered by the grown span).
    const spans = tableSpans(grid);
    const covered = new Set<number>();
    for (let r = 0; r < grid.rows.length; r += 1) {
      for (let c = 0; c < grid.width; c += 1) {
        const s = spans[r][c];
        if (s.kind !== 'cell' || s.rowspan === 1) continue;
        if (r < at && at < r + s.rowspan) {
          const anchor = grid.cells[r][c];
          if (anchor) setCellSpan(anchor, 'rowspan', s.rowspan + 1);
          for (let cc = c; cc < c + s.colspan; cc += 1) covered.add(cc);
        }
      }
    }
    rowsArr.insert(Math.min(at, rowsArr.length), [
      makeBlock({
        type: 'row',
        props: {ord},
        children: tableColumns(table.block).flatMap((c, i) => (covered.has(i) ? [] : [{type: 'cell' as const, props: {col: c.id}}])),
      }),
    ]);
  }, 'local');
}

/** A cell's rich text as explicit runs (for cloning — see {@link tableDuplicateRow}). */
function cellRuns(cell: BlockMap): TextRun[] {
  const text = blockText(cell);
  if (!text) return [];
  return (text.toDelta() as {insert: string; attributes?: InlineAttrs}[]).map((op) => ({
    t: op.insert,
    ...(op.attributes && Object.keys(op.attributes).length > 0 ? {a: op.attributes} : {}),
  }));
}

/** A shallow copy of a block's props (colour tokens, alignment, `col`, …). */
function cloneBlockProps(b: BlockMap): Record<string, unknown> {
  const props = b.get('props') as Y.Map<unknown> | undefined;
  return props ? Object.fromEntries(props.entries()) : {};
}

/**
 * Duplicate the row at sorted position `rowIndex`: a fresh row block (new ids)
 * inserted directly after the source, carrying one cell per registered column
 * with the SAME `col` binding, a copy of the source cell's rich text, and its
 * cell props (so future colour/alignment survive). The order key is placed
 * between the source row and its successor. CONVERGENCE-SAFE: it only INSERTS a
 * node — no existing row's key is rewritten unless a fresh key can't be minted
 * (then the axis rebalances, same as {@link tableInsertRow}). One transact =
 * one undo step.
 */
export function tableDuplicateRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rowsArr = blockChildren(table.block);
    if (!rowsArr) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    if (rowIndex < 0 || rowIndex >= grid.rows.length) return;
    const source = grid.rows[rowIndex];
    const before = rowOrd(source);
    const after = rowIndex + 1 < grid.rows.length ? rowOrd(grid.rows[rowIndex + 1]) : null;
    let ord = insertionKey(before, after);
    if (ord === null) {
      // No room for a fresh key between source and successor — respread the
      // whole axis, opening one slot right after the source row.
      const keys = keysBetween(null, null, grid.rows.length + 1);
      grid.rows.forEach((row, i) => setBlockProp(row, 'ord', keys[i <= rowIndex ? i : i + 1]));
      ord = keys[rowIndex + 1];
    }
    const spans = tableSpans(grid);
    const insertionRow = rowIndex + 1;
    const covered = new Set<number>();
    for (let r = 0; r < grid.rows.length; r += 1) {
      for (let c = 0; c < grid.width; c += 1) {
        const slot = spans[r][c];
        if (slot.kind !== 'cell' || slot.rowspan === 1 || !(r < insertionRow && insertionRow < r + slot.rowspan)) continue;
        const anchor = grid.cells[r][c];
        if (anchor) setCellSpan(anchor, 'rowspan', slot.rowspan + 1);
        for (let cc = c; cc < c + slot.colspan; cc += 1) covered.add(cc);
      }
    }
    // Build cells from sorted coordinates. A vertical span crossing the new
    // row leaves null slots; a horizontal span anchored in the source row is
    // cloned as a horizontal span (its covered slots remain absent).
    const columns = tableColumns(table.block);
    const children = columns.flatMap((c, i) => {
      if (covered.has(i)) return [];
      const sourceSlot = spans[rowIndex]?.[i];
      if (sourceSlot?.kind === 'covered' && sourceSlot.anchorRow === rowIndex) return [];
      const src = grid.cells[rowIndex][i];
      return src && blockType(src) === 'cell'
        ? [{type: 'cell' as const, text: cellRuns(src), props: {...cloneBlockProps(src), col: c.id}}]
        : [{type: 'cell' as const, props: {col: c.id}}];
    });
    const arrayIndex = indexOfBlock(rowsArr, blockId(source));
    const at = arrayIndex >= 0 ? arrayIndex + 1 : rowsArr.length;
    // Carry the source row's own props (e.g. its `bg` tint — TBL-4) onto the
    // clone, overriding only `ord` with the fresh position key.
    rowsArr.insert(Math.min(at, rowsArr.length), [makeBlock({type: 'row', props: {...cloneBlockProps(source), ord}, children})]);
  }, 'local');
}

/**
 * Insert a column at sorted position `colIndex`: register id, add bound cells.
 * Inserting strictly inside a horizontal span extends that span and leaves the
 * new column empty for every row it covers, mirroring {@link tableInsertRow}.
 */
export function tableInsertColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    if (!blockChildren(table.block)) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    const spans = tableSpans(grid);
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
    const covered = new Set<number>();
    for (let r = 0; r < grid.rows.length; r += 1) {
      for (let c = 0; c < grid.width; c += 1) {
        const slot = spans[r][c];
        if (slot.kind !== 'cell' || slot.colspan === 1 || !(c < at && at < c + slot.colspan)) continue;
        const anchor = grid.cells[r][c];
        if (anchor) setCellSpan(anchor, 'colspan', slot.colspan + 1);
        for (let rr = r; rr < r + slot.rowspan; rr += 1) covered.add(rr);
      }
    }
    // Cell order inside a keyed row is irrelevant; its stable `col` binding is
    // the order contract. Appending avoids confusing a render coordinate with
    // a Y.Array index (rows/cells may already be physically out of order).
    for (let r = 0; r < grid.rows.length; r += 1) {
      if (covered.has(r)) continue;
      const cells = blockChildren(grid.rows[r]);
      if (cells) cells.push([makeBlock({type: 'cell', props: {col: id}})]);
    }
  }, 'local');
}

/** Set a stored span canonically: absent means one. */
function setCellSpan(cell: BlockMap, key: 'colspan' | 'rowspan', value: number): void {
  setBlockProp(cell, key, value > 1 ? value : undefined);
}

/** Delete one sorted row inside an existing transaction. */
function tableDeleteRowInTx(doc: Y.Doc, tableId: string, rowIndex: number): void {
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
  const spans = tableSpans(grid);
  for (let r = 0; r < grid.rows.length; r += 1) {
    for (let c = 0; c < grid.width; c += 1) {
      const slot = spans[r][c];
      if (slot.kind !== 'cell' || slot.rowspan === 1 || rowIndex < r || rowIndex >= r + slot.rowspan) continue;
      const anchor = grid.cells[r][c];
      if (!anchor || blockType(anchor) !== 'cell') continue;
      if (rowIndex > r) {
        setCellSpan(anchor, 'rowspan', slot.rowspan - 1);
        continue;
      }
      // The deleted row owns the anchor block. Recreate that logical merged
      // cell on the next row before removing it, retaining content/formatting
      // while shortening the vertical span by one.
      const target = blockChildren(grid.rows[r + 1]);
      const colId = grid.colIds[c];
      if (!target || !colId) continue;
      target.push([
        makeBlock({
          id: `${blockId(anchor)}:row:${blockId(grid.rows[r + 1])}:${colId}`,
          type: 'cell',
          text: cellRuns(anchor),
          props: {
            ...cloneBlockProps(anchor),
            col: colId,
            colspan: slot.colspan > 1 ? slot.colspan : undefined,
            rowspan: slot.rowspan > 2 ? slot.rowspan - 1 : undefined,
          },
        }),
      ]);
    }
  }
  const arrayIndex = indexOfBlock(rowsArr, blockId(grid.rows[rowIndex]));
  if (arrayIndex >= 0) rowsArr.delete(arrayIndex, 1);
}

/** Delete the row at sorted position `rowIndex`; the last row removes the table. */
export function tableDeleteRow(doc: Y.Doc, tableId: string, rowIndex: number): void {
  doc.transact(() => tableDeleteRowInTx(doc, tableId, rowIndex), 'local');
}

/** Delete one sorted column inside an existing transaction. */
function tableDeleteColumnInTx(doc: Y.Doc, tableId: string, colIndex: number): void {
  const table = findBlock(doc, tableId);
  if (!table || !blockChildren(table.block)) return;
  ensureTableOrderInTx(table.block);
  const grid = tableGrid(table.block);
  if (colIndex < 0 || colIndex >= grid.colIds.length) return;
  if (grid.colIds.length === 1) {
    removeBlockInTx(doc, tableId);
    return;
  }
  const spans = tableSpans(grid);
  for (let r = 0; r < grid.rows.length; r += 1) {
    for (let c = 0; c < grid.width; c += 1) {
      const slot = spans[r][c];
      if (slot.kind !== 'cell' || slot.colspan === 1 || colIndex < c || colIndex >= c + slot.colspan) continue;
      const anchor = grid.cells[r][c];
      if (!anchor || blockType(anchor) !== 'cell') continue;
      if (colIndex > c) {
        setCellSpan(anchor, 'colspan', slot.colspan - 1);
        continue;
      }
      // The deleted column owns the anchor binding. Recreate the logical cell
      // in the next covered column, retaining content/formatting and rowspan.
      const target = blockChildren(grid.rows[r]);
      const nextColId = grid.colIds[c + 1];
      if (!target || !nextColId) continue;
      target.push([
        makeBlock({
          id: `${blockId(anchor)}:col:${blockId(grid.rows[r])}:${nextColId}`,
          type: 'cell',
          text: cellRuns(anchor),
          props: {
            ...cloneBlockProps(anchor),
            col: nextColId,
            colspan: slot.colspan > 2 ? slot.colspan - 1 : undefined,
            rowspan: slot.rowspan > 1 ? slot.rowspan : undefined,
          },
        }),
      ]);
    }
  }
  setBlockProp(table.block, TABLE_COL_PREFIX + grid.colIds[colIndex], undefined);
  // Drop the column's colour entry too, so a deleted column leaves no orphan.
  setBlockProp(table.block, TABLE_COLBG_PREFIX + grid.colIds[colIndex], undefined);
  setBlockProp(table.block, TABLE_COLW_PREFIX + grid.colIds[colIndex], undefined);
  grid.rows.forEach((row, r) => {
    const cell = grid.cells[r][colIndex];
    if (!cell) return;
    const cellsArr = blockChildren(row);
    if (!cellsArr) return;
    deleteBlocksById(cellsArr, blockId(cell));
  });
}

/** Delete the column at sorted position `colIndex` (registry + bound cells). */
export function tableDeleteColumn(doc: Y.Doc, tableId: string, colIndex: number): void {
  doc.transact(() => tableDeleteColumnInTx(doc, tableId, colIndex), 'local');
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

// ── Table colours (TBL-4) ────────────────────────────────────────────────────

/** The palette token tinting a row (its block `bg` prop), or null. */
export function tableRowColor(row: BlockMap): string | null {
  const v = blockProp<unknown>(row, 'bg');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The palette token tinting a column (keyed on its stable `colId`), or null. */
export function tableColumnColor(table: BlockMap, colId: string): string | null {
  const v = blockProp<unknown>(table, TABLE_COLBG_PREFIX + colId);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Stored integer pixel width for a stable column id; malformed values are auto. */
export function tableColumnWidth(table: BlockMap, colId: string): number | null {
  const value = blockProp<unknown>(table, TABLE_COLW_PREFIX + colId);
  return typeof value === 'number' && Number.isInteger(value) && value >= TABLE_COLUMN_MIN_WIDTH ? value : null;
}

/** Set a column width, or clear it back to fluid/auto. One call is one undo step. */
export function setTableColumnWidth(doc: Y.Doc, tableId: string, colId: string, px: number | null): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table || tableColumns(table.block).every((column) => column.id !== colId)) return;
    const width = px === null ? undefined : Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round(px));
    setBlockProp(table.block, TABLE_COLW_PREFIX + colId, width);
  }, 'local');
}

/**
 * The palette token tinting a single CELL — its own block `bg` prop (TBL-6), or
 * null. NOTE: `bg` is the ordinary universal block background prop, exactly as
 * it is on a row (and every other block); the api2 block catalogue
 * (`packages/sdk/src/blockCatalogue.ts`, on feat/api2-registry-validation)
 * already declares `bg` universal, so nothing there needs a `cell`-specific
 * entry and no drift is expected when the two branches merge.
 */
export function tableCellOwnColor(cell: BlockMap): string | null {
  const v = blockProp<unknown>(cell, 'bg');
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The composited tint for a cell: the CELL colour (TBL-6) wins over the ROW
 * colour, which wins over the COLUMN colour — narrowest intent first (a single
 * tinted cell is the most deliberate mark, a row band reads as intentional over
 * a column band). `colId` is the cell's `col` binding; `cell` is the cell block
 * (optional — omit it for a structural gap, which has no own tint). Pure — the
 * one definition of cell-tint precedence shared by render and export.
 */
export function tableCellColor(table: BlockMap, row: BlockMap, colId: string | null, cell?: BlockMap | null): string | null {
  return (
    (cell ? tableCellOwnColor(cell) : null) ?? tableRowColor(row) ?? (colId ? tableColumnColor(table, colId) : null)
  );
}

/**
 * Tint (or clear, with `token === null`) a row — writes the row's block `bg`
 * prop. One transact = one undo step. `rowId` is resolved live so a reordered
 * table still tints the right row.
 */
export function setTableRowColor(doc: Y.Doc, tableId: string, rowId: string, token: string | null): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const row = tableGrid(table.block).rows.find((r) => blockId(r) === rowId);
    if (!row) return;
    setBlockProp(row, 'bg', token ?? undefined);
  }, 'local');
}

/**
 * Tint (or clear, with `token === null`) a column — writes the table-level
 * `colbg:<colId>` prop keyed on the stable column id. One transact = one undo
 * step. No-op if the column is not registered.
 */
export function setTableColumnColor(doc: Y.Doc, tableId: string, colId: string, token: string | null): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    if (tableColumns(table.block).every((c) => c.id !== colId)) return;
    setBlockProp(table.block, TABLE_COLBG_PREFIX + colId, token ?? undefined);
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
 * within the column. Merge-aware (TBL-8): Tab-order (`next`/`prev`) skips every
 * covered slot so each real cell is visited once; vertical movement entering a
 * DIFFERENT cell's span lands on that span's anchor, while movement through
 * one's own span (or a plain ragged gap) keeps going. Returns null at the edge.
 */
export function cellNeighbor(doc: Y.Doc, cellId: string, dir: 'next' | 'prev' | 'down' | 'up'): string | null {
  const pos = cellPosition(doc, cellId);
  if (!pos) return null;
  const grid = tableGrid(pos.table);
  const spans = tableSpans(grid);
  let {row, col} = pos;
  const steps = grid.rows.length * Math.max(1, grid.width) + 1; // hard bound
  for (let i = 0; i < steps; i += 1) {
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
    const slot = spans[row]?.[col];
    if (!slot) return null;
    if (slot.kind === 'cell') {
      const cell = grid.cells[row][col];
      return cell && blockType(cell) === 'cell' ? blockId(cell) : null;
    }
    if (slot.kind === 'covered') {
      if (dir === 'next' || dir === 'prev') continue;
      const anchor = grid.cells[slot.anchorRow]?.[slot.anchorCol];
      const anchorId = anchor && blockType(anchor) === 'cell' ? blockId(anchor) : null;
      if (anchorId && anchorId !== cellId) return anchorId; // enter a foreign span at its anchor
      // own span (or a broken cover) — keep stepping past it
    }
    // plain gap — keep stepping (Tab/arrows skip gaps)
  }
  return null;
}

// ── Cell-range selection (TBL-5) ───────────────────────────────────────────────
// A rectangular multi-cell selection is LOCAL, per-user, ephemeral state (never
// CRDT, never awareness). It is stored as two RENDER-order grid coordinates — an
// anchor and a focus — so the rectangle is defined POSITIONALLY at selection
// time: if a row/column is reordered afterwards, the same slots now hold
// whatever moved there (matching how a spreadsheet range behaves). These pure
// helpers resolve/serialize/clear a range against the live sorted grid.

/** An inclusive rectangle of RENDER-order grid coordinates. */
export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Normalise two grid coordinates (any order) into an inclusive rectangle. */
export function normalizeCellRect(a: {row: number; col: number}, b: {row: number; col: number}): CellRect {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
}

/** True when a grid coordinate falls inside the (inclusive) rectangle. */
export const cellInRect = (rect: CellRect, row: number, col: number): boolean =>
  row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;

/**
 * The cell blocks of a rectangular range, in RENDER (sorted) order — a grid of
 * `(bottom−top+1) × (right−left+1)`, `null` for a gap (a merge void or a ragged
 * short row). Coordinates resolve against the live sorted grid, so a rectangle
 * captured BEFORE a row/column reorder maps to whatever now occupies those
 * slots (positional-at-selection, acceptance #7 sorted-vs-array).
 */
export function tableRangeCells(doc: Y.Doc, tableId: string, rect: CellRect): (BlockMap | null)[][] {
  const found = findBlock(doc, tableId);
  if (!found || blockType(found.block) !== 'table') return [];
  const grid = tableGrid(found.block);
  const snapped = tableSnapRectToSpans(found.block, rect);
  const out: (BlockMap | null)[][] = [];
  for (let r = snapped.top; r <= snapped.bottom; r += 1) {
    const rowCells = grid.cells[r] ?? [];
    const line: (BlockMap | null)[] = [];
    for (let c = snapped.left; c <= snapped.right; c += 1) {
      const cell = rowCells[c] ?? null;
      line.push(cell && blockType(cell) === 'cell' ? cell : null);
    }
    out.push(line);
  }
  return out;
}

/** The rich-text runs of a range's cells (empty `[]` for a gap) — clipboard serialization. */
export function tableRangeRuns(doc: Y.Doc, tableId: string, rect: CellRect): TextRun[][][] {
  return tableRangeCells(doc, tableId, rect).map((line) => line.map((cell) => (cell ? cellRuns(cell) : [])));
}

/** One slot of a span-aware cell-range HTML projection. */
export type CellRangeExportCell =
  | {kind: 'cell'; runs: TextRun[]; colspan: number; rowspan: number; color: string | null}
  | {kind: 'covered'};

/**
 * A range projected for HTML clipboard export. Unlike {@link tableRangeRuns},
 * this retains anchor spans and marks covered slots so the serializer omits
 * their `<td>` elements. The rectangle first snaps to whole merged cells.
 */
// Composite (not own) tint: a pasted cell materialises the row/column tint it inherited, so the range looks identical at the destination.
export function tableRangeExport(doc: Y.Doc, tableId: string, rect: CellRect): CellRangeExportCell[][] {
  const found = findBlock(doc, tableId);
  if (!found || blockType(found.block) !== 'table') return [];
  const grid = tableGrid(found.block);
  const spans = tableSpans(grid);
  const snapped = tableSnapRectToSpans(found.block, rect);
  const out: CellRangeExportCell[][] = [];
  for (let r = snapped.top; r <= snapped.bottom; r += 1) {
    const row: CellRangeExportCell[] = [];
    for (let c = snapped.left; c <= snapped.right; c += 1) {
      const slot = spans[r]?.[c];
      if (slot?.kind === 'covered') {
        row.push({kind: 'covered'});
        continue;
      }
      const cell = grid.cells[r]?.[c];
      row.push({
        kind: 'cell',
        runs: cell && blockType(cell) === 'cell' ? cellRuns(cell) : [],
        colspan: slot?.kind === 'cell' ? slot.colspan : 1,
        rowspan: slot?.kind === 'cell' ? slot.rowspan : 1,
        color: cell && blockType(cell) === 'cell'
          ? tableCellColor(found.block, grid.rows[r], grid.colIds[c] ?? null, cell)
          : null,
      });
    }
    out.push(row);
  }
  return out;
}

/** Clear every cell text in a rectangular range in ONE transaction (one undo step). */
export function clearCellRange(doc: Y.Doc, tableId: string, rect: CellRect): void {
  doc.transact(() => {
    for (const line of tableRangeCells(doc, tableId, rect)) {
      for (const cell of line) {
        const text = cell && blockText(cell);
        if (text && text.length > 0) text.delete(0, text.length);
      }
    }
  }, 'local');
}

/**
 * Replace cells from a clipboard grid, growing at the bottom/right as needed.
 * A grid tiles only when a multi-cell selection is an exact multiple of it;
 * otherwise its own dimensions are written from the selection's top-left.
 * Covered merge slots are ignored and declarations are never changed.
 */
const MAX_PASTE_CELLS = 20000;

export function tablePasteGrid(
  doc: Y.Doc,
  tableId: string,
  anchor: {row: number; col: number},
  source: Array<Array<string | {text: string; color?: string}>>,
  opts: {range?: CellSelection} = {},
): {rows: number; cols: number} | null {
  const sourceRows = source.length;
  const sourceCols = source.reduce((max, row) => Math.max(max, row.length), 0);
  if (sourceRows === 0 || sourceCols === 0) return null;
  let written: {rows: number; cols: number} | null = null;
  doc.transact(() => {
    const initial = findBlock(doc, tableId);
    if (!initial || blockType(initial.block) !== 'table') return;
    const rect = opts.range ? normalizeCellRect(opts.range.anchor, opts.range.focus) : null;
    const rangeRows = rect ? rect.bottom - rect.top + 1 : 1;
    const rangeCols = rect ? rect.right - rect.left + 1 : 1;
    const tile = !!rect && rangeRows * rangeCols >= 2 && rangeRows % sourceRows === 0 && rangeCols % sourceCols === 0;
    const start = rect ? {row: rect.top, col: rect.left} : anchor;
    const writeRows = tile ? rangeRows : sourceRows;
    const writeCols = tile ? rangeCols : sourceCols;
    if (writeRows * writeCols > MAX_PASTE_CELLS) return;

    let grid = tableGrid(initial.block);
    while (grid.rows.length < start.row + writeRows) {
      const n = grid.rows.length;
      tableInsertRow(doc, tableId, n);
      grid = tableGrid(initial.block);
      if (grid.rows.length === n) return;
    }
    while (grid.width < start.col + writeCols) {
      const n = grid.width;
      tableInsertColumn(doc, tableId, n);
      grid = tableGrid(initial.block);
      if (grid.width === n) return;
    }

    const spans = tableSpans(grid);
    written = {rows: writeRows, cols: writeCols};
    for (let r = 0; r < writeRows; r += 1) {
      for (let c = 0; c < writeCols; c += 1) {
        const row = start.row + r;
        const col = start.col + c;
        if (spans[row]?.[col]?.kind === 'covered') continue;
        const cell = grid.cells[row]?.[col];
        // gap slot (ragged legacy row): no cell node to write into — skipped.
        if (!cell || blockType(cell) !== 'cell') continue;
        const text = blockText(cell);
        if (!text) continue;
        if (text.length > 0) text.delete(0, text.length);
        const value = source[r % sourceRows]?.[c % sourceCols] ?? '';
        const content = typeof value === 'string' ? value : value.text;
        if (content) text.insert(0, content, {});
        if (typeof value !== 'string') setBlockProp(cell, 'bg', value.color ?? undefined);
      }
    }
  }, 'local');
  return written;
}

// ── Range-scoped table ops (TBL-6) ───────────────────────────────────────────
// The range variants of the single-cell tint / delete ops. Each is ONE transact
// (one undo step) and resolves the sorted grid once inside it, so a rectangle
// captured before a reorder still targets the slots it now covers.

/**
 * Tint (or clear, with `token === null`) every cell of a rectangular range —
 * writes each cell's own block `bg` prop (TBL-6). Gaps are skipped. One
 * transact = one undo step for the whole range.
 */
export function setTableCellRangeColor(doc: Y.Doc, tableId: string, rect: CellRect, token: string | null): void {
  doc.transact(() => {
    for (const line of tableRangeCells(doc, tableId, rect)) {
      for (const cell of line) {
        if (cell) setBlockProp(cell, 'bg', token ?? undefined);
      }
    }
  }, 'local');
}

/**
 * Delete the rows at sorted positions `top…bottom` (inclusive) in ONE
 * transaction. Deleting every row removes the table, matching
 * {@link tableDeleteRow}. Row blocks are resolved from the sorted grid up front
 * and removed by array index, so no index shifts mid-loop (the sorted-vs-array
 * trap).
 */
export function tableDeleteRowRange(doc: Y.Doc, tableId: string, top: number, bottom: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    const rowsArr = blockChildren(table.block);
    if (!rowsArr) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    const from = Math.max(0, Math.min(top, bottom));
    const to = Math.min(grid.rows.length - 1, Math.max(top, bottom));
    if (to < from) return;
    if (to - from + 1 >= grid.rows.length) {
      removeBlockInTx(doc, tableId);
      return;
    }
    // Repair/shrink spans once per deletion. Descending sorted coordinates keep
    // every earlier target stable while the entire band remains one undo step.
    for (let r = to; r >= from; r -= 1) tableDeleteRowInTx(doc, tableId, r);
  }, 'local');
}

/**
 * Delete the columns at sorted positions `left…right` (inclusive) in ONE
 * transaction — registry entries, their `colbg:` tints, and every bound cell.
 * Deleting every column removes the table, matching {@link tableDeleteColumn}.
 */
export function tableDeleteColumnRange(doc: Y.Doc, tableId: string, left: number, right: number): void {
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table) return;
    if (!blockChildren(table.block)) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    const from = Math.max(0, Math.min(left, right));
    const to = Math.min(grid.colIds.length - 1, Math.max(left, right));
    if (to < from) return;
    if (to - from + 1 >= grid.colIds.length) {
      removeBlockInTx(doc, tableId);
      return;
    }
    for (let c = to; c >= from; c -= 1) tableDeleteColumnInTx(doc, tableId, c);
  }, 'local');
}

function removeBlockInTx(doc: Y.Doc, id: string): void {
  const found = findBlock(doc, id);
  if (found) found.parent.delete(found.index, 1);
  ensureNotEmpty(doc);
}

// ── Merged cells (TBL-8) ─────────────────────────────────────────────────────
/*
 * SPAN CONTRACT — colspan/rowspan live on the ANCHOR (top-left) cell.
 *
 *   cell.props.colspan = <int ≥ 2>    columns the anchor covers (absent = 1)
 *   cell.props.rowspan = <int ≥ 2>    rows the anchor covers (absent = 1)
 *
 * The covered slots hold NO cell block — they are the existing null-slot
 * convention of {@link tableGrid} (a row simply has no cell bound to that
 * column). Nothing else changes shape: the column registry, row `ord` keys and
 * `col` bindings are exactly the TBL-1 order contract.
 *
 * EFFECTIVE spans are computed by {@link tableSpans}, which SHRINKS a declared
 * span so it only ever covers slots that are actually empty. This makes spans
 * self-healing: if a covered slot gains a real cell (a concurrent edit, or an
 * external tool materialising a gap), that cell RENDERS and the span contracts
 * around it — content is never hidden under a span.
 *
 * API-3 COORDINATION (table tools on feat/api3-*, not merged here): its
 * `inspect_table` prints `[gap]` for null slots — a span's covered slots print
 * the same way (the anchor's props say why). Its `table_set_cell` materialises
 * a gap cell before writing — per the paragraph above that is SAFE (the span
 * shrinks; nothing is corrupted or hidden), but the invariants those tools must
 * respect are:
 *   1. never bind two cells of one row to the same colId,
 *   2. never write `colspan`/`rowspan` < 2 (absent means 1),
 *   3. to edit merged content, write the ANCHOR cell — materialising a covered
 *      slot splits that slot out of the merge as a side effect.
 *
 * MERGE CONTENT POLICY (matching Google Docs): merging MOVES every covered
 * cell's rich text into the anchor, newline-joined, in reading order — nothing
 * is discarded, and the whole merge is one transaction (one undo step), so it
 * is fully reversible. Splitting keeps all content in the anchor (Docs
 * unmerge) and restores empty cells in the covered slots.
 * Concurrent anchor-row deletion vs promotion-target deletion may lose anchor content; replicas still converge deterministically.
 */

/** Sanity ceiling for a stored span (a hostile/corrupt doc can't OOM render). */
const SPAN_MAX = 512;

const cellSpanProp = (cell: BlockMap, key: 'colspan' | 'rowspan'): number => {
  const v = blockProp<unknown>(cell, key);
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 1;
  return n >= 2 ? Math.min(n, SPAN_MAX) : 1;
};

/** The DECLARED column span of a cell (its `colspan` prop, clamped; 1 = none). */
export const cellColSpan = (cell: BlockMap): number => cellSpanProp(cell, 'colspan');
/** The DECLARED row span of a cell (its `rowspan` prop, clamped; 1 = none). */
export const cellRowSpan = (cell: BlockMap): number => cellSpanProp(cell, 'rowspan');

/** What occupies one grid slot, span-resolved (see {@link tableSpans}). */
export type TableSlot =
  /** A real block: `colspan`/`rowspan` are its EFFECTIVE spans (usually 1/1). */
  | {kind: 'cell'; colspan: number; rowspan: number}
  /** An empty slot covered by a spanning anchor — render/export emit nothing. */
  | {kind: 'covered'; anchorRow: number; anchorCol: number}
  /** An empty slot covered by nothing (a ragged row) — render pads it. */
  | {kind: 'gap'};

/**
 * The span-resolved view of a grid: `slots[r][c]` for every render coordinate
 * (rows × {@link TableGrid.width}). Effective spans are the declared spans
 * clamped to the grid edge and SHRUNK to cover only empty (null) slots — see
 * the span contract above. Scan order is row-major, so overlapping declarations
 * resolve deterministically (an earlier anchor wins; a later one shrinks).
 * Pure and read-only — the single definition shared by render, navigation,
 * export, and the structural ops.
 */
export function tableSpans(grid: TableGrid): TableSlot[][] {
  const slots: TableSlot[][] = grid.cells.map((row) =>
    Array.from({length: grid.width}, (_, c): TableSlot => (row[c] ? {kind: 'cell', colspan: 1, rowspan: 1} : {kind: 'gap'})),
  );
  const isGap = (r: number, c: number): boolean => slots[r]?.[c]?.kind === 'gap';
  for (let r = 0; r < slots.length; r += 1) {
    for (let c = 0; c < grid.width; c += 1) {
      const slot = slots[r][c];
      if (slot.kind !== 'cell') continue;
      const cell = grid.cells[r][c];
      if (!cell || blockType(cell) !== 'cell') continue; // non-cell child: occupied but unspannable
      const declaredC = Math.min(cellColSpan(cell), grid.width - c);
      const declaredR = Math.min(cellRowSpan(cell), slots.length - r);
      if (declaredC === 1 && declaredR === 1) continue;
      let w = 1;
      while (w < declaredC && isGap(r, c + w)) w += 1;
      const rowClear = (rr: number): boolean => {
        for (let cc = c; cc < c + w; cc += 1) {
          if (!isGap(rr, cc)) return false;
        }
        return true;
      };
      let h = 1;
      while (h < declaredR && rowClear(r + h)) h += 1;
      if (w === 1 && h === 1) continue;
      slot.colspan = w;
      slot.rowspan = h;
      for (let rr = r; rr < r + h; rr += 1) {
        for (let cc = c; cc < c + w; cc += 1) {
          if (rr !== r || cc !== c) slots[rr][cc] = {kind: 'covered', anchorRow: r, anchorCol: c};
        }
      }
    }
  }
  return slots;
}

/** Resolve a render coordinate to its real cell (a covered slot → its anchor). */
export function tableCellAt(grid: TableGrid, row: number, col: number, spans = tableSpans(grid)): BlockMap | null {
  const slot = spans[row]?.[col];
  if (!slot || slot.kind === 'gap') return null;
  const anchorRow = slot.kind === 'covered' ? slot.anchorRow : row;
  const anchorCol = slot.kind === 'covered' ? slot.anchorCol : col;
  const cell = grid.cells[anchorRow]?.[anchorCol];
  return cell && blockType(cell) === 'cell' ? cell : null;
}

/**
 * Expand a rectangle so it covers every merged cell it touches, WHOLE — the
 * standard snap-out of range selection over merged regions (Docs/Sheets).
 * Also normalises corner order and clamps to the grid. Iterates to a fixed
 * point (pulling in one span can graze another). Read-only.
 */
export function tableSnapRectToSpans(table: BlockMap, rect: CellRect): CellRect {
  const grid = tableGrid(table);
  const maxRow = grid.rows.length - 1;
  const maxCol = grid.width - 1;
  if (maxRow < 0 || maxCol < 0) return {top: 0, left: 0, bottom: 0, right: 0};
  let top = Math.max(0, Math.min(maxRow, Math.min(rect.top, rect.bottom)));
  let bottom = Math.max(0, Math.min(maxRow, Math.max(rect.top, rect.bottom)));
  let left = Math.max(0, Math.min(maxCol, Math.min(rect.left, rect.right)));
  let right = Math.max(0, Math.min(maxCol, Math.max(rect.left, rect.right)));
  const spans = tableSpans(grid);
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r <= maxRow; r += 1) {
      for (let c = 0; c <= maxCol; c += 1) {
        const s = spans[r][c];
        if (s.kind !== 'cell' || (s.colspan === 1 && s.rowspan === 1)) continue;
        const r2 = r + s.rowspan - 1;
        const c2 = c + s.colspan - 1;
        if (r > bottom || r2 < top || c > right || c2 < left) continue; // no overlap
        if (r < top) { top = r; changed = true; }
        if (r2 > bottom) { bottom = r2; changed = true; }
        if (c < left) { left = c; changed = true; }
        if (c2 > right) { right = c2; changed = true; }
      }
    }
  }
  return {top, left, bottom, right};
}

/**
 * Merge the cells of a rectangular range into one spanning anchor (TBL-8).
 * The rect SNAPS OUT over any merged cell it partially overlaps (never a
 * partial overlap — {@link tableSnapRectToSpans}), the top-left cell becomes
 * the anchor (gains `colspan`/`rowspan`), every other cell's rich text MOVES
 * into the anchor (newline-joined, reading order — nothing discarded), and the
 * other cell blocks are deleted, leaving the null slots the span contract
 * expects. Refused (no-op) when: the table/rect has no top-left cell to anchor
 * on, the rect contains a non-`cell` child (merging would hide it), or the
 * rect holds fewer than two real cells. ONE transaction = one undo step, so a
 * merge is fully reversible.
 */
export function tableMergeCells(doc: Y.Doc, tableId: string, rect: CellRect): void {
  // Refuse a hostile cell with no real Y.Text before ensureTableOrderInTx gets
  // any chance to migrate/backfill the table: refusal must be mutation-free.
  const candidate = findBlock(doc, tableId);
  if (candidate && blockType(candidate.block) === 'table' && blockChildren(candidate.block)) {
    const candidateGrid = tableGrid(candidate.block);
    if (candidateGrid.rows.length > 0 && candidateGrid.width > 0) {
      const snapped = tableSnapRectToSpans(candidate.block, rect);
      const candidateAnchor = candidateGrid.cells[snapped.top]?.[snapped.left];
      if (candidateAnchor && blockType(candidateAnchor) === 'cell' && !(candidateAnchor.get('text') instanceof Y.Text)) return;
    }
  }
  doc.transact(() => {
    const table = findBlock(doc, tableId);
    if (!table || blockType(table.block) !== 'table') return;
    if (!blockChildren(table.block)) return;
    ensureTableOrderInTx(table.block);
    const grid = tableGrid(table.block);
    if (grid.rows.length === 0 || grid.width === 0 || !grid.keyed) return;
    const {top, left, bottom, right} = tableSnapRectToSpans(table.block, rect);
    if (top === bottom && left === right) return; // one slot — nothing to merge
    const anchor = grid.cells[top]?.[left];
    if (!anchor || blockType(anchor) !== 'cell') return; // nothing to anchor on
    const text = anchor.get('text');
    if (!(text instanceof Y.Text)) return; // hostile doc — never discard covered runs
    // Survey the rect first: refuse if it holds a non-cell child (a STAB-1
    // poison block — merging over it would hide content), and count real cells.
    const doomed: Array<{row: BlockMap; cell: BlockMap}> = [];
    for (let r = top; r <= bottom; r += 1) {
      for (let c = left; c <= right; c += 1) {
        const cell = grid.cells[r]?.[c];
        if (!cell) continue;
        if (blockType(cell) !== 'cell') return;
        if (cell !== anchor) doomed.push({row: grid.rows[r], cell});
      }
    }
    if (doomed.length === 0) return; // a single already-merged cell re-snapped to itself
    // MOVE content: append each covered cell's runs to the anchor, in reading
    // order, one newline between non-empty cells (the Google Docs policy — no
    // data loss; undo restores the original grid in one step).
    for (const {row, cell} of doomed) {
      const runs = cellRuns(cell).filter((run) => run.t.length > 0);
      if (runs.length > 0) {
        if (text.length > 0) text.insert(text.length, '\n', {});
        let at = text.length;
        for (const run of runs) {
          text.insert(at, run.t, run.a ?? {});
          at += run.t.length;
        }
      }
      const cellsArr = blockChildren(row);
      if (!cellsArr) continue;
      deleteBlocksById(cellsArr, blockId(cell));
    }
    const w = right - left + 1;
    const h = bottom - top + 1;
    setBlockProp(anchor, 'colspan', w > 1 ? w : undefined);
    setBlockProp(anchor, 'rowspan', h > 1 ? h : undefined);
  }, 'local');
}

/**
 * Split a merged cell back into single cells (TBL-8). Drops the anchor's
 * `colspan`/`rowspan` and materialises a fresh EMPTY cell in every slot the
 * span covered (bound to that slot's colId). All content stays in the anchor
 * (the Google Docs unmerge policy). Clears stale span props even when the
 * effective span had already shrunk to 1×1. ONE transaction = one undo step.
 */
export function tableSplitCell(doc: Y.Doc, cellId: string): void {
  doc.transact(() => {
    const found = findBlock(doc, cellId);
    if (!found || blockType(found.block) !== 'cell') return;
    const pos = cellPosition(doc, cellId);
    if (!pos) return;
    const tableEntry = findBlock(doc, blockId(pos.table));
    if (!tableEntry) return;
    ensureTableOrderInTx(tableEntry.block);
    const grid = tableGrid(tableEntry.block);
    const spans = tableSpans(grid);
    const slot = spans[pos.row]?.[pos.col];
    setBlockProp(found.block, 'colspan', undefined);
    setBlockProp(found.block, 'rowspan', undefined);
    if (!slot || slot.kind !== 'cell' || (slot.colspan === 1 && slot.rowspan === 1)) return;
    for (let r = pos.row; r < pos.row + slot.rowspan; r += 1) {
      const cellsArr = blockChildren(grid.rows[r]);
      if (!cellsArr) continue;
      for (let c = pos.col; c < pos.col + slot.colspan; c += 1) {
        if (r === pos.row && c === pos.col) continue;
        const colId = grid.colIds[c];
        if (colId) {
          cellsArr.push([
            makeBlock({
              id: `${cellId}:split:${blockId(grid.rows[r])}:${colId}`,
              type: 'cell',
              props: {col: colId},
            }),
          ]);
        }
      }
    }
  }, 'local');
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
  const spans = tableSpans(grid);
  return grid.rows.map((row, r) => {
    const json = blockToJSON(row);
    if (blockType(row) !== 'row') return json; // malformed child — verbatim
    const slots = grid.cells[r];
    let end = grid.width;
    while (end > 0 && spans[r][end - 1].kind === 'gap') end -= 1;
    json.children = [];
    for (let c = 0; c < end; c += 1) {
      const slot = spans[r][c];
      if (slot.kind === 'covered') continue; // the anchor's span represents it
      const cell = slots[c];
      if (cell) {
        const child = blockToJSON(cell);
        if (slot.kind === 'cell') {
          const props = {...child.props};
          delete props.colspan;
          delete props.rowspan;
          if (slot.colspan > 1) props.colspan = slot.colspan;
          if (slot.rowspan > 1) props.rowspan = slot.rowspan;
          child.props = Object.keys(props).length > 0 ? props : undefined;
        }
        json.children.push(child);
      } else {
        json.children.push({
          id: `${blockId(row)}-void-${c}`,
          type: 'cell' as const,
          text: [],
          props: grid.colIds[c] ? {col: grid.colIds[c]} : undefined,
        });
      }
    }
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
  return Math.min(Math.floor(raw), SPAN_MAX);
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

interface NormalizedTableCell {
  runs: TextRun[];
  colspan: number;
  rowspan: number;
}

/**
 * Turn a (possibly ragged, span-laden, spacer-row-ridden) HTML `<table>` into
 * the model's rectangular null-gap grid. A real origin retains its declared
 * colspan/rowspan; every covered coordinate is `null`; ordinary ragged gaps are
 * materialised as empty cells. Nested tables flatten and structural rows drop
 * exactly as before. This is the inverse of the span-aware HTML exporter.
 */
const normalizeTableGrid = (table: HTMLElement): (NormalizedTableCell | null)[][] => {
  const grid: (NormalizedTableCell | null)[][] = [];
  // column → number of further rows a rowspan still occupies
  const carry = new Map<number, number>();
  for (const tr of directTableRows(table)) {
    const cells = [...tr.querySelectorAll<HTMLElement>(':scope > td, :scope > th:not([data-obe-chrome])')];
    const carried = [...carry.values()].some((n) => n > 0);
    // A structural/spacer row (e.g. Notion's spacer <tr>): nothing to place and
    // nothing carried into it — skip entirely.
    if (cells.length === 0 && !carried) continue;
    const row: Array<NormalizedTableCell | null | undefined> = [];
    for (const [c, n] of carry) {
      if (n <= 0) continue;
      row[c] = null;
      carry.set(c, n - 1);
    }
    let col = 0;
    for (const cell of cells) {
      while (row[col] !== undefined) col += 1;
      const runs = cellToRuns(cell);
      const cspan = cellSpanAttr(cell, 'colspan');
      const rspan = cellSpanAttr(cell, 'rowspan');
      row[col] = {runs, colspan: cspan, rowspan: rspan};
      for (let c = 0; c < cspan; c += 1) {
        if (c > 0) row[col + c] = null;
        if (rspan > 1) carry.set(col + c, rspan - 1);
      }
      col += cspan;
    }
    grid.push(row as (NormalizedTableCell | null)[]);
  }
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  for (const row of grid) {
    for (let c = 0; c < width; c += 1) {
      if (row[c] === undefined) row[c] = {runs: [], colspan: 1, rowspan: 1};
    }
  }
  // Note: only truly cell-less structural rows are dropped (skipped above). A row
  // with real `<td>`/`<th>` cells is kept even if blank — its cell may carry an
  // image (emitted separately) or be an intentionally empty grid cell.
  return grid;
};

/** Build a keyed table while retaining the null covered slots from HTML. */
function tableFromNormalizedGrid(grid: (NormalizedTableCell | null)[][], header: boolean, widths: Array<number | null> = []): NewBlock {
  const width = Math.max(1, ...grid.map((row) => row.length));
  const colIds = Array.from({length: width}, (_, i) => `c${i}`);
  const colKeys = keysBetween(null, null, width);
  const rowKeys = keysBetween(null, null, grid.length);
  return {
    type: 'table',
    props: {
      header,
      ...Object.fromEntries(colIds.map((id, i) => [TABLE_COL_PREFIX + id, colKeys[i]])),
      ...Object.fromEntries(colIds.flatMap((id, i) => widths[i] == null ? [] : [[TABLE_COLW_PREFIX + id, widths[i]]] )),
    },
    children: grid.map((cells, r) => ({
      type: 'row' as const,
      props: {ord: rowKeys[r]},
      children: cells.flatMap((cell, c) =>
        cell
          ? [
            {
              type: 'cell' as const,
              text: cell.runs,
              props: {
                col: colIds[c],
                colspan: cell.colspan > 1 ? cell.colspan : undefined,
                rowspan: cell.rowspan > 1 ? cell.rowspan : undefined,
              },
            },
          ]
          : [],
      ),
    })),
  };
}

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
      // Scoped + rectangular: nested tables stay in their own cell, spans keep
      // null covered slots, ragged rows pad, and spacer rows drop — so a
      // Notion-shaped clipboard table is faithful and cannot poison render.
      const rows = normalizeTableGrid(node);
      if (rows.length > 0) {
        const firstRow = directTableRows(node)[0];
        const widths = Array.from(node.querySelectorAll(':scope > colgroup > col')).map((col) => {
          const px = /^([0-9]+(?:\.[0-9]+)?)px$/.exec((col as HTMLElement).style.width)?.[1];
          return px ? Math.max(TABLE_COLUMN_MIN_WIDTH, Math.round(Number(px))) : null;
        });
        out.push(tableFromNormalizedGrid(rows, firstRow?.querySelector(':scope > th') != null, widths));
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
