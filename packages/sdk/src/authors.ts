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
export function computeBlockAuthors(
  prev: PageSnapshot | null | undefined,
  next: PageSnapshot,
  authorSubject: string,
): Array<[string, string]> | null {
  const prevBlocks = snapshotBlocks(prev);
  const prevHash = new Map<string, string>();
  for (const b of prevBlocks) prevHash.set(b.id, b.hash);
  const prevAuthor = new Map<string, string>(prev?.authors ?? []);
  const verified = authorSubject.length > 0;

  const out: Array<[string, string]> = [];
  for (const b of snapshotBlocks(next)) {
    const unchanged = prevHash.get(b.id) === b.hash;
    const author = unchanged ? prevAuthor.get(b.id) ?? '' : verified ? authorSubject : '';
    if (author) out.push([b.id, author]);
  }
  return out.length > 0 ? out : null;
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
  const authors = computeBlockAuthors(prev, next, authorSubject);
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
