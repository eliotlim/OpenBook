/**
 * Per-block modification tracking — the change/version signal the on-disk book
 * mirror, the external-change watcher, and conflict detection all rely on
 * (OB-133). A page snapshot can carry an `mtimes` array of `[blockId, ISO]`
 * pairs; the server stamps it on every write so an unchanged block keeps its old
 * timestamp while a changed or newly-inserted one is restamped to "now".
 *
 * Pure and isomorphic (no DOM, no Node): it reads whichever block projection a
 * page uses — the CRDT block editor's JSON projection (`blockdoc.blocks`) or the
 * legacy EditorJS blocks (`editorjs.blocks`) — so the same logic runs on the
 * server write path and in unit tests.
 */
import type {PageSnapshot} from './types';

/** A top-level block reduced to the bits that define its identity + content. */
export interface BlockDigest {
  /** Stable block id (used to match the same block across two snapshot versions). */
  id: string;
  /** Block type (`paragraph`, `heading`, …). */
  type: string;
  /** A short, deterministic hash of the block's full content (incl. children). */
  hash: string;
}

interface AnyEditorJsBlock {
  id?: string;
  type?: string;
  data?: unknown;
}
interface AnyBlockJson {
  id?: string;
  type?: string;
  text?: unknown;
  props?: unknown;
  children?: unknown;
}

/**
 * FNV-1a (32-bit) over a string, returned as 8 hex chars. Fast, dependency-free,
 * and stable across platforms — exactly what change-detection needs (a rare
 * collision only means a missed restamp, never corruption).
 */
export function contentHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range via the >>> 0 below.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Stable JSON: object keys sorted so `{a,b}` and `{b,a}` hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * The ordered list of a snapshot's top-level blocks, each as a {@link BlockDigest}.
 * Reads the block-editor projection for `editor: 'blocks'` pages and the EditorJS
 * blocks otherwise. A block with no explicit id falls back to a positional id so
 * an unchanged document still matches itself across versions.
 */
export function snapshotBlocks(data: PageSnapshot | null | undefined): BlockDigest[] {
  if (!data) return [];

  const blockdoc = data.blockdoc as {blocks?: AnyBlockJson[]} | undefined;
  if (data.editor === 'blocks' && Array.isArray(blockdoc?.blocks)) {
    return blockdoc.blocks.map((b, i) => ({
      id: typeof b.id === 'string' && b.id ? b.id : `b${i}`,
      type: typeof b.type === 'string' ? b.type : 'unknown',
      hash: contentHash(stableStringify({type: b.type, text: b.text, props: b.props, children: b.children})),
    }));
  }

  const blocks = (data.editorjs as {blocks?: AnyEditorJsBlock[]} | undefined)?.blocks ?? [];
  return blocks.map((b, i) => ({
    id: typeof b.id === 'string' && b.id ? b.id : `b${i}`,
    type: typeof b.type === 'string' ? b.type : 'unknown',
    hash: contentHash(stableStringify({type: b.type, data: b.data})),
  }));
}

/**
 * Compute the `[blockId, ISO]` mtimes for `next`, carrying forward each block's
 * timestamp from `prev` when its content is unchanged and stamping `nowIso` for
 * new or changed blocks. The result preserves `next`'s block order. Pages with
 * no `prev` (a fresh insert) get every block stamped `nowIso`.
 */
export function computeBlockMtimes(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  nowIso: string,
): Array<[string, string]> {
  const prevBlocks = snapshotBlocks(prev);
  const prevHash = new Map<string, string>();
  for (const b of prevBlocks) prevHash.set(b.id, b.hash);
  const prevMtime = new Map<string, string>(prev?.mtimes ?? []);

  return snapshotBlocks(next).map((b): [string, string] => {
    const unchanged = prevHash.get(b.id) === b.hash && prevMtime.has(b.id);
    return [b.id, unchanged ? prevMtime.get(b.id)! : nowIso];
  });
}

/**
 * Return `next` with its `mtimes` stamped relative to `prev`. The server calls
 * this on every content write so a page snapshot always describes when each of
 * its blocks last changed. Idempotent when the document is unchanged: re-stamping
 * an identical snapshot keeps every timestamp.
 */
export function stampSnapshotMtimes(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  nowIso: string = new Date().toISOString(),
): PageSnapshot {
  return {...next, mtimes: computeBlockMtimes(prev, next, nowIso)};
}

/** The most recent block mtime in a snapshot, or `null` if none are stamped. */
export function latestBlockMtime(data: PageSnapshot | null | undefined): string | null {
  let latest: string | null = null;
  for (const [, iso] of data?.mtimes ?? []) {
    if (latest === null || iso > latest) latest = iso;
  }
  return latest;
}
