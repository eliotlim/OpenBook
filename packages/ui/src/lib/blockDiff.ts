import {TEXT_BLOCKS, type BlockJSON} from '@/blockeditor/model';

/**
 * A block/word-level diff between two block documents (PVH-6), used by the
 * Version-history "Compare" view to show what changed between a captured version
 * (the `old` side) and the live document (the `new` side).
 *
 * Design
 * ──────
 * • **Block alignment** is an order-preserving LCS over the two top-level block
 *   lists keyed by **block id**. Ids are stable across a page's CRDT lineage
 *   (a version is a past state of the same doc, decoded from the same update),
 *   so editing a block in place, inserting, or deleting all align cleanly:
 *   an aligned pair is `unchanged` or `changed`; an old-only block is `removed`;
 *   a new-only block is `added`. Reorders surface as remove+add (moves are not
 *   tracked — the owner listed them as optional).
 * • **Changed text blocks** get an intra-block **word-level** diff: a second LCS
 *   over word/whitespace/punctuation tokens, yielding `kept` / `added` / `removed`
 *   runs. This is a compact self-contained implementation (the same LCS shape
 *   already used by `textMerge.ts`) — **no diff dependency is added**: pulling in
 *   `diff`/`fast-diff` for one narrow feature isn't worth the bundle weight when
 *   the word-LCS is ~20 lines.
 * • **Non-text blocks** (image, htmlArtifact, kit/db/chart, dividers, tables and
 *   other containers) are never word-diffed — a changed one is reported opaquely
 *   at block granularity (`opaque: true`), and the view shows the old→new pair
 *   rather than pretending to diff a chart's internals.
 *
 * The result is a flat, ordered list of entries the view renders top to bottom.
 * Everything here is pure (plain `BlockJSON` in, plain data out) and unit-tested.
 */

export type BlockDiffStatus = 'added' | 'removed' | 'unchanged' | 'changed';

/** One run of an intra-block word-level text diff. */
export interface WordRun {
  value: string;
  status: 'kept' | 'added' | 'removed';
}

/** One aligned slot in the block-level diff. */
export interface BlockDiffEntry {
  status: BlockDiffStatus;
  /**
   * The block to render for this slot. For `added`/`unchanged`/`changed` it is
   * the NEW (current) block; for `removed` it is the OLD (version) block.
   */
  block: BlockJSON;
  /** The OLD (version) block — present for `changed` so the view can show old→new. */
  oldBlock?: BlockJSON;
  /**
   * Word-level runs for a `changed` block whose text was diffed. Absent when the
   * change is opaque (a non-text block) or the block is not `changed`.
   */
  wordRuns?: WordRun[];
  /** A `changed` block that can't be word-diffed (image/kit/db/table/…). */
  opaque?: boolean;
}

export interface BlockDiff {
  entries: BlockDiffEntry[];
  /** True when any entry is an add / remove / change (i.e. the docs differ). */
  changed: boolean;
}

/**
 * Above this product of block counts we skip the O(n·m) block LCS and fall back
 * to an id-map alignment (loses precise interleaving of add/remove runs, but
 * stays linear on pathological documents). ~250k cells of Int32 is trivial.
 */
const MAX_BLOCK_LCS = 500 * 500;
/** Above this token count a changed text block shows whole-block +/− (no LCS). */
const MAX_WORD_TOKENS = 4000;

/** Plain concatenated text of a block's rich-text runs. */
function plainText(block: BlockJSON): string {
  return (block.text ?? []).map((run) => run.t).join('');
}

/** Whether a block carries diff-able rich text (vs. an opaque widget/container). */
function isTextBlock(block: BlockJSON): boolean {
  return TEXT_BLOCKS.has(block.type as never);
}

/** Structural deep-equality of two blocks (type + text + props + children). */
function blocksEqual(a: BlockJSON, b: BlockJSON): boolean {
  if (a.type !== b.type) return false;
  if (plainText(a) !== plainText(b)) return false;
  // Rich-text attributes, props and children: a stable JSON compare is enough —
  // both sides come from the same serializer (`blockToJSON`), so key order and
  // shape are consistent.
  return (
    stableStringify(a.text ?? []) === stableStringify(b.text ?? []) &&
    stableStringify(a.props ?? {}) === stableStringify(b.props ?? {}) &&
    stableStringify(a.children ?? []) === stableStringify(b.children ?? [])
  );
}

/** Deterministic JSON with sorted object keys (order-independent equality). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Order-preserving LCS of two id sequences, returned as matched `[oldIndex,
 * newIndex]` pairs (both strictly increasing). The anchors around which the
 * block diff is built.
 */
function idAnchors(oldB: BlockJSON[], newB: BlockJSON[]): Array<[number, number]> {
  const n = oldB.length;
  const m = newB.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] =
        oldB[i].id === newB[j].id
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldB[i].id === newB[j].id) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Split a string into word / whitespace / punctuation tokens (reassembles exactly). */
function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Matched `[i, j]` token pairs of a token-level LCS. */
function tokenAnchors(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Word-level diff of two strings → coalesced `kept`/`added`/`removed` runs.
 * Removed runs precede added runs within each gap between kept tokens, so the
 * output reads old→new. Exported for testing.
 */
export function wordDiff(oldText: string, newText: string): WordRun[] {
  if (oldText === newText) return oldText ? [{value: oldText, status: 'kept'}] : [];
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const runs: WordRun[] = [];
  const push = (value: string, status: WordRun['status']): void => {
    if (!value) return;
    const last = runs[runs.length - 1];
    if (last && last.status === status) last.value += value;
    else runs.push({value, status});
  };
  // Guard the quadratic LCS: enormous blocks fall back to whole-string +/−.
  if (a.length + b.length > MAX_WORD_TOKENS) {
    push(oldText, 'removed');
    push(newText, 'added');
    return runs;
  }
  const anchors = tokenAnchors(a, b);
  let i = 0;
  let j = 0;
  for (const [pa, pb] of anchors) {
    while (i < pa) push(a[i++], 'removed');
    while (j < pb) push(b[j++], 'added');
    push(a[i], 'kept');
    i += 1;
    j += 1;
  }
  while (i < a.length) push(a[i++], 'removed');
  while (j < b.length) push(b[j++], 'added');
  return runs;
}

/** Diff an aligned old/new block pair (same id) into a single entry. */
function alignedEntry(oldBlock: BlockJSON, newBlock: BlockJSON): BlockDiffEntry {
  if (blocksEqual(oldBlock, newBlock)) return {status: 'unchanged', block: newBlock};
  // Both sides are text blocks → word-level diff of their plain text.
  if (isTextBlock(oldBlock) && isTextBlock(newBlock)) {
    return {
      status: 'changed',
      block: newBlock,
      oldBlock,
      wordRuns: wordDiff(plainText(oldBlock), plainText(newBlock)),
    };
  }
  // Non-text (image, chart, table, embed…) — report the change opaquely.
  return {status: 'changed', block: newBlock, oldBlock, opaque: true};
}

/** Id-map fallback alignment for pathologically large docs (see MAX_BLOCK_LCS). */
function fallbackDiff(oldB: BlockJSON[], newB: BlockJSON[]): BlockDiffEntry[] {
  const oldById = new Map(oldB.map((b) => [b.id, b] as const));
  const seen = new Set<string>();
  const entries: BlockDiffEntry[] = [];
  for (const nb of newB) {
    const ob = oldById.get(nb.id);
    if (ob) {
      seen.add(nb.id);
      entries.push(alignedEntry(ob, nb));
    } else {
      entries.push({status: 'added', block: nb});
    }
  }
  for (const ob of oldB) {
    if (!seen.has(ob.id)) entries.push({status: 'removed', block: ob});
  }
  return entries;
}

/**
 * Compute the block/word-level diff of `oldBlocks` (a version) against
 * `newBlocks` (the current document). See the module doc for the design.
 */
export function diffBlocks(oldBlocks: BlockJSON[], newBlocks: BlockJSON[]): BlockDiff {
  let entries: BlockDiffEntry[];
  if (oldBlocks.length * newBlocks.length > MAX_BLOCK_LCS) {
    entries = fallbackDiff(oldBlocks, newBlocks);
  } else {
    entries = [];
    const anchors = idAnchors(oldBlocks, newBlocks);
    let oi = 0;
    let nj = 0;
    const flushGap = (oEnd: number, nEnd: number): void => {
      while (oi < oEnd) entries.push({status: 'removed', block: oldBlocks[oi++]});
      while (nj < nEnd) entries.push({status: 'added', block: newBlocks[nj++]});
    };
    for (const [ai, aj] of anchors) {
      flushGap(ai, aj);
      entries.push(alignedEntry(oldBlocks[ai], newBlocks[aj]));
      oi = ai + 1;
      nj = aj + 1;
    }
    flushGap(oldBlocks.length, newBlocks.length);
  }
  const changed = entries.some((e) => e.status !== 'unchanged');
  return {entries, changed};
}
