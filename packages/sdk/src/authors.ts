/**
 * Per-block authorship that travels WITH a page snapshot (OB-170), so an edit
 * made on one instance is correctly attributed when the snapshot reaches another
 * (the sync/merge path). Parallel to `mtimes` (which records *when* each block
 * changed): `authors` records *who* — but only for **verified** identities, so
 * guest/local/unverified edits never pollute the carried attribution.
 *
 * A snapshot's `authors` is a sparse `[blockId, subject]` map (only blocks with
 * a known verified author). The server stamps it on write from the request's
 * verified principal, carrying forward each unchanged block's prior author and
 * setting the current author on changed/new blocks. Pure + isomorphic, mirroring
 * `mtime.ts` so it runs on the server write path and in tests alike.
 */
import {snapshotBlocks} from './mtime';
import type {PageSnapshot} from './types';

/**
 * Compute the `[blockId, subject]` authorship for `next`. Unchanged blocks keep
 * their prior author; changed/new blocks get `authorSubject` when it is a
 * verified identity (a non-empty subject), and are otherwise left unattributed
 * (an anonymous/guest edit honestly clears a block's verified author rather than
 * falsely keeping the previous one). Returns a sparse map — only blocks with a
 * known author — or `null` when none are attributed (so the field stays absent
 * on single-user / unverified documents).
 */
/**
 * Resolve the *verified* author subject for a **changed/new** block. Returns a
 * non-empty subject to attribute the block, or `''`/`undefined` to leave it
 * unattributed (an anonymous/guest edit honestly clears a block's verified
 * author). Only consulted for changed blocks; unchanged blocks keep their prior
 * author regardless. This is the seam that lets one snapshot carry per-block
 * attribution from *different* principals — the server-authoritative persist path
 * (Collab T9), where one durable checkpoint merges edits from several writers.
 */
export type BlockAuthorResolver = (blockId: string) => string | undefined;

/**
 * Compute the `[blockId, subject]` authorship for `next` against `prev`. Unchanged
 * blocks (same content hash) keep their prior author; changed/new blocks are
 * attributed to `resolve(blockId)` when it yields a verified (non-empty) subject,
 * and are otherwise left unattributed. Returns a sparse map — only blocks with a
 * known author — or `null` when none are attributed (so the field stays absent on
 * single-user / unverified documents). The single-principal
 * {@link computeBlockAuthors} and the per-block {@link stampSnapshotAuthorsPerBlock}
 * are both thin resolvers over this one diff.
 */
function computeBlockAuthorsBy(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  resolve: BlockAuthorResolver,
): Array<[string, string]> | null {
  const prevHash = new Map<string, string>();
  for (const b of snapshotBlocks(prev)) prevHash.set(b.id, b.hash);
  const prevAuthor = new Map<string, string>(prev?.authors ?? []);

  const out: Array<[string, string]> = [];
  for (const b of snapshotBlocks(next)) {
    const unchanged = prevHash.get(b.id) === b.hash;
    const author = unchanged ? prevAuthor.get(b.id) ?? '' : resolve(b.id) ?? '';
    if (author) out.push([b.id, author]);
  }
  return out.length > 0 ? out : null;
}

/**
 * Compute the `[blockId, subject]` authorship for `next`. Unchanged blocks keep
 * their prior author; changed/new blocks get `authorSubject` when it is a
 * verified identity (a non-empty subject), and are otherwise left unattributed
 * (an anonymous/guest edit honestly clears a block's verified author rather than
 * falsely keeping the previous one). Returns a sparse map — only blocks with a
 * known author — or `null` when none are attributed (so the field stays absent
 * on single-user / unverified documents).
 */
export function computeBlockAuthors(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  authorSubject: string,
): Array<[string, string]> | null {
  const author = authorSubject.length > 0 ? authorSubject : '';
  return computeBlockAuthorsBy(prev, next, () => author);
}

/** Set `next.authors` from a computed map, or drop the key entirely when nothing
 *  is attributed (so it never appears on single-user/unverified snapshots). */
function withAuthors(next: PageSnapshot, authors: Array<[string, string]> | null): PageSnapshot {
  if (!authors) {
    // Nothing attributed: drop any stale `authors` rather than carry an empty map.
    if (next.authors === undefined) return next;
    const rest = {...next};
    delete rest.authors;
    return rest;
  }
  return {...next, authors};
}

/**
 * Return `next` with its `authors` stamped relative to `prev`. `authorSubject` is
 * the request's *verified* principal subject (`iss#sub`), or `''` for an
 * unverified/guest/local write (which carries no new attribution). Idempotent
 * when the document is unchanged. Omits the `authors` key entirely when nothing
 * is attributed, so it never appears on single-user/unverified snapshots.
 */
export function stampSnapshotAuthors(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  authorSubject: string,
): PageSnapshot {
  return withAuthors(next, computeBlockAuthors(prev, next, authorSubject));
}

/**
 * Per-block variant of {@link stampSnapshotAuthors} for the server-authoritative
 * persist path (Collab T9). When the SERVER persists one converged snapshot that
 * merges edits from several principals, a single `authorSubject` would misattribute
 * every changed block to one writer. Instead each **changed** block is attributed
 * to `authorByBlock.get(blockId)` — the *verified* subject of the principal whose
 * ingested update last changed that block (`''`/absent ⇒ a guest/unverified change,
 * left unattributed). Unchanged blocks keep their prior author. So attribution
 * reflects who actually made each change, never "the server" and never a forged
 * writer. Idempotent when the document is unchanged.
 */
export function stampSnapshotAuthorsPerBlock(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  authorByBlock: ReadonlyMap<string, string>,
): PageSnapshot {
  return withAuthors(next, computeBlockAuthorsBy(prev, next, (id) => authorByBlock.get(id)));
}

/**
 * The verified author of a snapshot's most-recently-changed attributed block —
 * the snapshot's "last verified editor", read on the receiving instance to
 * attribute a synced edit. Uses `mtimes` to find the newest block, falling back
 * to any attributed block. Returns `null` when nothing is attributed.
 */
export function latestSnapshotAuthor(data: PageSnapshot | null | undefined): string | null {
  const authors = new Map<string, string>(data?.authors ?? []);
  if (authors.size === 0) return null;
  let latestIso: string | null = null;
  let latestSubject: string | null = null;
  for (const [blockId, iso] of data?.mtimes ?? []) {
    const subject = authors.get(blockId);
    if (subject && (latestIso === null || iso > latestIso)) {
      latestIso = iso;
      latestSubject = subject;
    }
  }
  // No mtimes overlap (e.g. a snapshot without mtimes) → any attributed author.
  return latestSubject ?? authors.values().next().value ?? null;
}
