/**
 * Pure logic for applying a peer/echo snapshot to the live editor and for
 * deciding whether an editor change is worth autosaving. Kept free of EditorJS
 * and React so it can be unit-tested directly (see `liveSync.test.ts`); the
 * effectful glue (calling the EditorJS block API) lives in `PageDocument`.
 */

/** The subset of an EditorJS saved block this module reasons about. */
export interface SyncBlock {
  id?: string;
  type: string;
  data: unknown;
}

/** An insert anchored after `afterId` (null = document start), with the index
 *  in the incoming list as a fallback when the anchor can't be located live. */
export interface BlockInsert {
  id?: string;
  type: string;
  data: unknown;
  afterId: string | null;
  index: number;
}

export interface BlockSyncPlan {
  /** Block ids to delete (present locally, gone in the incoming snapshot). */
  deletes: string[];
  /** Blocks whose data changed — update in place (never re-render others). */
  updates: {id: string; data: unknown}[];
  /** Blocks the peer added that we don't have yet. */
  inserts: BlockInsert[];
}

/**
 * Diff the current editor blocks against an incoming snapshot and return the
 * minimal set of operations to reconcile them. Crucially, an *identical*
 * snapshot yields an empty plan (no churn) — that's what stops the save loop and
 * layout shift on pages with reactive blocks, where a full re-render would
 * otherwise re-mount and re-run every block. The block under the caret
 * (`focusedBlockId`) is never deleted or updated, so typing is never disrupted.
 */
export function planBlockSync(
  current: SyncBlock[],
  next: SyncBlock[],
  focusedBlockId: string | null,
): BlockSyncPlan {
  const currentById = new Map(current.filter((b) => b.id).map((b) => [b.id as string, b] as const));
  const nextById = new Map(next.filter((b) => b.id).map((b) => [b.id as string, b] as const));
  const live = new Set(current.filter((b) => b.id).map((b) => b.id as string));

  const deletes: string[] = [];
  for (const b of current) {
    if (b.id && b.id !== focusedBlockId && !nextById.has(b.id)) {
      deletes.push(b.id);
      live.delete(b.id);
    }
  }

  const updates: {id: string; data: unknown}[] = [];
  for (const b of next) {
    if (!b.id || b.id === focusedBlockId) continue;
    const cur = currentById.get(b.id);
    if (cur && JSON.stringify(cur.data) !== JSON.stringify(b.data)) {
      updates.push({id: b.id, data: b.data});
    }
  }

  const inserts: BlockInsert[] = [];
  for (let i = 0; i < next.length; i++) {
    const b = next[i];
    if (!b.id || live.has(b.id)) continue;
    inserts.push({id: b.id, type: b.type, data: b.data, afterId: i > 0 ? next[i - 1].id ?? null : null, index: i});
    live.add(b.id);
  }

  return {deletes, updates, inserts};
}

/** The shape of an EditorJS block-mutation event we care about. */
export interface BlockMutationLike {
  type?: string;
  detail?: {target?: {name?: string}};
}

/**
 * Whether an editor `onChange` event represents a genuine, persist-worthy edit.
 *
 * Structural changes (add/remove/move) always count. `block-changed` is the
 * trap: many blocks fire it for non-edit reasons — the reactive blocks
 * (slider/expr/chart) on every recompute, and third-party blocks (table,
 * checklist) when they re-normalize their data on mount/update — and treating
 * those as edits drives an autosave loop. So `block-changed` only counts for the
 * blocks that emit it *exclusively* on a real user action with no accompanying
 * native `input` event: a subpage recording its created child id, and the
 * tune-driven blocks (callout variant, accordion collapse, divider style).
 * Everything else that the user actually edits — paragraphs, table cells,
 * checklist text — reaches autosave through the editor holder's `input` listener.
 */
const EDIT_SIGNALING_BLOCKS = new Set(['subpage', 'callout', 'accordion', 'divider']);

export function isPersistWorthyChange(
  event: BlockMutationLike | BlockMutationLike[] | undefined,
): boolean {
  const events = Array.isArray(event) ? event : [event];
  return events.some((e) => {
    const type = e?.type;
    if (type === 'block-added' || type === 'block-removed' || type === 'block-moved') return true;
    if (type === 'block-changed') return EDIT_SIGNALING_BLOCKS.has(e?.detail?.target?.name ?? '');
    return false;
  });
}
