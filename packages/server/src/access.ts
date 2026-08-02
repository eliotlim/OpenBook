/**
 * Request- and stream-level access enforcement (OB-190; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §1.4 / S4).
 *
 * The decision itself is the pure SDK `authorize()`; the access-aware composition
 * (role, effective visibility, ACL) lives on {@link PageStore}. This module is the
 * thin enforcement skin over those:
 *
 *  - {@link requireAccess} / {@link requireDbAccess} / {@link requireCreate} —
 *    the central default-deny gate every content route calls. `!canRead` ⇒ 404
 *    (hide existence), a writer-only need with `!canWrite` ⇒ 403.
 *  - {@link streamGates} — per-subscriber {@link EventGate}s for the live channels,
 *    so the `PageHub` fan-out filters unreadable pages/rows per subscriber (S4).
 */

import {HTTPException} from 'hono/http-exception';
import type {Context} from 'hono';
import type {Decision, InstanceConfig, Principal} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {EventGate, ListEvent, LiveEvent, PageEvent, RowsEvent} from './hub';
import type {PageStore} from './store';

type Ctx = Context<AppEnv>;

/** What a route needs of a page: read access, or read+write. */
export type AccessNeed = 'read' | 'write';

/**
 * True only for a REAL instance owner: the machine owner over the trusted local
 * transport (the loopback hatch), the in-process `local` principal, or a
 * `jws`-verified identity matching a CLAIMED `ownerSubject`.
 *
 * Unlike the general policy gate, this NEVER falls open on an unclaimed
 * instance. Use it for policy fields whose misuse is dangerous on its own —
 * a filesystem write target, a credential, an exfiltration destination — where
 * "nobody has claimed this instance yet" must mean "nobody may set this",
 * not "anybody may". An owner-minted agent PAT is excluded by the `jws`
 * requirement (AGENT-6 HIGH-1: a PAT carries the owner's subject but must not
 * wield owner authority).
 */
export function isRealInstanceOwner(c: Ctx, config: Pick<InstanceConfig, 'ownerSubject'>): boolean {
  if (c.get('localOwner')) return true; // trusted local transport = machine owner
  const principal = c.get('principal');
  if (principal.verifiedVia === 'local') return true; // in-process loopback owner
  return Boolean(
    config.ownerSubject && principal.verifiedVia === 'jws' && principal.subject === config.ownerSubject,
  );
}

/**
 * The one default-deny gate (contract §1.4). Resolves the request principal's
 * decision on `pageId` and enforces it: a page the caller can't read 404s (hide
 * existence — never reveal that a restricted page exists), and a write need on a
 * readable-but-not-writable page 403s. Returns the {@link Decision} for callers
 * that want the reason. Works for trashed pages and database rows alike (the
 * store's decision reads the row without a `deleted_at` filter).
 */
export async function requireAccess(c: Ctx, store: PageStore, need: AccessNeed, pageId: string): Promise<Decision> {
  const principal = c.get('principal');
  const {decision, exists} = await store.decidePageAccess(principal, pageId);
  if (!exists || !decision.canRead) {
    throw new HTTPException(404, {message: 'page not found'});
  }
  if (need === 'write' && !decision.canWrite) {
    throw new HTTPException(403, {message: 'you do not have write access to this page'});
  }
  return decision;
}

/**
 * Gate CREATING a brand-new top-level page (no existing row to authorize). Only a
 * writer at the instance default scope (local-owner / owner / admin) may; a
 * viewer / jws non-member / write-disabled guest 403s.
 */
export async function requireCreate(c: Ctx, store: PageStore): Promise<void> {
  const decision = await store.decideCreateAccess(c.get('principal'));
  if (!decision.canWrite) {
    throw new HTTPException(403, {message: 'you do not have write access on this instance'});
  }
}

/**
 * Is this request from an AUTHENTICATED identity — a fresh-verified JWS user, the
 * in-process loopback owner (`local`), or the trusted local transport (machine
 * owner)? A guest or a lapsed (`unverified`) caller is NOT. Used to fence
 * identity-INFRASTRUCTURE metadata (the AI engine status, the instance owner /
 * trusted-issuer / audience block) off the anonymous surface a claimed,
 * internet-exposable (`published`-scope) instance presents — without touching the
 * content-access model, which stays the sole enforcement of who reads what.
 */
export function isAuthenticatedPrincipal(c: Ctx): boolean {
  if (c.get('localOwner')) return true; // trusted local transport = machine owner
  const via = c.get('principal').verifiedVia;
  return via === 'jws' || via === 'local';
}

/**
 * Gate a READ route to an {@link isAuthenticatedPrincipal}, 401ing an anonymous
 * guest / lapsed caller — BUT keep the legacy single-user (UNCLAIMED, loopback-only
 * by the §2.6 exposure invariant) path open, exactly like the paid-inference gate:
 * with no owner claimed there is no remote guest to fence, and the loopback owner
 * must keep reading its own instance. For identity-infrastructure metadata a claimed
 * instance must not hand to anonymous callers (GATE-7).
 */
export async function requireAuthenticatedRead(c: Ctx, store: PageStore): Promise<void> {
  if (isAuthenticatedPrincipal(c)) return;
  const {ownerSubject} = await store.getInstanceConfig();
  if (ownerSubject === undefined) return; // legacy unclaimed → no remote guest to fence
  throw new HTTPException(401, {message: 'sign in to view this on this instance'});
}

/**
 * Gate instance ADMINISTRATION (whole-library export/import). Stricter than
 * {@link requireCreate} on a claimed instance — an acl-write member can create
 * pages but must not bulk-exfiltrate (or wholesale-overwrite) pages they can't
 * read — and simultaneously more forgiving to the machine owner: the loopback
 * hatch (`localOwner`) and the in-process `local` principal always pass, so a
 * lapsed account identity never locks the desktop out of its own data.
 *
 * On an UNCLAIMED instance there is no owner/roster to gate by (loopback-only by
 * the §2.6 exposure invariant), so the legacy create-gate floor applies — the
 * single-user local experience is unchanged.
 */
export async function requireInstanceAdmin(c: Ctx, store: PageStore): Promise<void> {
  if (c.get('localOwner')) return; // trusted local transport = machine owner
  const principal = c.get('principal');
  if (principal.verifiedVia === 'local') return; // in-process loopback owner
  const config = await store.getInstanceConfig();
  if (!config.ownerSubject) {
    await requireCreate(c, store);
    return;
  }
  const isOwner = principal.verifiedVia === 'jws' && principal.subject === config.ownerSubject;
  const role = isOwner ? null : await store.resolveMemberRole(principal, config);
  if (isOwner || role === 'admin') return;
  throw new HTTPException(403, {message: 'only the instance owner or an admin can export or import the whole library'});
}

/**
 * Gate a database route on its HOST PAGE's decision (a database inherits the
 * access of the page that hosts it). 404s a missing or unreadable database.
 */
export async function requireDbAccess(c: Ctx, store: PageStore, need: AccessNeed, databaseId: string): Promise<void> {
  const db = await store.getDatabase(databaseId);
  if (!db) throw new HTTPException(404, {message: 'database not found'});
  await requireAccess(c, store, need, db.pageId);
}

/**
 * Per-subscriber {@link EventGate}s for the live channels (S4). Each filters an
 * outbound event against the connection's principal: list/firehose frames drop
 * unreadable pages/rows; a per-page/per-db event is dropped when read access is
 * lost (the stream simply stops emitting — "never emits"). A `deleted` tombstone
 * carries no content, so it always passes (an open editor still learns its page
 * is gone).
 */
export function streamGates(store: PageStore, principal: Principal): {
  list: EventGate<ListEvent>;
  page: EventGate<PageEvent>;
  live: EventGate<LiveEvent>;
  rowsFor: (databaseId: string) => EventGate<RowsEvent>;
} {
  // Per-connection read-gate cache (Collab T1). A live collab session fans out a
  // `yupdate` per keystroke-batch; re-running `canReadPage` (a DB read) on every
  // frame, for every subscriber, is the firehose's hot cost. Cache the per-page
  // read decision for this connection and re-evaluate ONLY when the store's access
  // epoch advances — bumped by every visibility / ACL / policy / membership / page
  // delete-restore mutation. So a permission change takes effect on the very next
  // frame, while steady-state collaboration pays one decision per page, not per
  // frame. Coarse-but-safe: an epoch bump clears the whole cache (never stale-allow).
  const readCache = new Map<string, boolean>();
  let cacheGen = store.accessGeneration();
  const canReadPageCached = async (pageId: string): Promise<boolean> => {
    const gen = store.accessGeneration();
    if (gen !== cacheGen) {
      readCache.clear();
      cacheGen = gen;
    }
    const hit = readCache.get(pageId);
    if (hit !== undefined) return hit;
    const can = await store.canReadPage(principal, pageId);
    readCache.set(pageId, can);
    return can;
  };

  return {
    list: async (event) => ({type: 'list', pages: await store.filterReadablePages(principal, event.pages)}),
    page: async (event) =>
      event.type === 'deleted' ? event : (await canReadPageCached(event.page.id)) ? event : null,
    rowsFor: (databaseId) => async (event) =>
      (await store.canReadDatabase(principal, databaseId))
        ? {type: 'rows', rows: await store.filterReadableRows(principal, event.rows)}
        : null,
    live: async (event) => {
      switch (event.type) {
      case 'list':
        return {type: 'list', pages: await store.filterReadablePages(principal, event.pages)};
      case 'deleted':
        return event;
      case 'page':
        return (await canReadPageCached(event.page.id)) ? event : null;
      case 'rows':
        return (await store.canReadDatabase(principal, event.databaseId))
          ? {type: 'rows', databaseId: event.databaseId, rows: await store.filterReadableRows(principal, event.rows)}
          : null;
      case 'yupdate':
        // An incremental update rides the same per-page read gate as a full `page`
        // snapshot (and shares the cache), so the relay can't become a read bypass.
        return (await canReadPageCached(event.pageId)) ? event : null;
      case 'awareness':
        // Presence rides the SAME per-page read gate (Collab T4): a peer who can
        // READ the page sees who's present (so viewers appear), and a non-reader
        // gets neither presence nor doc updates — the channel can't leak existence.
        return (await canReadPageCached(event.pageId)) ? event : null;
      }
    },
  };
}
