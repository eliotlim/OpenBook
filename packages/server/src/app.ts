import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {HTTPException} from 'hono/http-exception';
import {streamSSE} from 'hono/streaming';
import {
  API,
  type AclLevel,
  type BackupCadence,
  type BackupConfig,
  type CommentInput,
  type DatabaseInput,
  type DatabaseUpdate,
  type ImportRequest,
  type InstanceConfig,
  type InstanceInfo,
  type MemberRole,
  type MemberStatus,
  type PageInput,
  type Principal,
  type RowInput,
  type SuggestionInput,
  type SuggestionStatus,
  type SuggestionUpdate,
} from '@book.dev/sdk';
import {PageStore} from './store';
import {PageHub} from './hub';
import {mountAiRoutes} from './ai/routes';
import {mountPluginRoutes} from './pluginRoutes';
import {guestGate, resolvePrincipal, type IdentityProvider} from './principal';
import {requireAccess, requireCreate, requireDbAccess, streamGates} from './access';
import {InviteResolutionError, resolveInvitee, type HandleResolver} from './invites';
import type {BackupController} from './backups';
import type {AppEnv} from './appEnv';
import type {AiService} from './ai/service';

/**
 * Build the Hono app over a page store. Routes implement the shared
 * `@book.dev/sdk` contract. Every write publishes to an in-memory {@link PageHub},
 * and the SSE endpoints relay those events to connected clients — the
 * server-driven refresh loop that powers real-time collaboration.
 */
/**
 * Constant-time string compare (avoids leaking the token length/contents via
 * timing). Returns false on any length mismatch.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface AppOptions {
  /**
   * When set, every `/api/*` request must present this token — as
   * `Authorization: Bearer <token>` or a `?token=` query param (the latter so
   * the SSE `EventSource`, which can't set headers, can authenticate). Used when
   * the desktop publishes its server on the LAN; unset on loopback (local-only),
   * so the local UX needs no token. `/health` is always open.
   */
  accessToken?: string;
  /**
   * True when the store is embedded PGlite (desktop / web webview), false for an
   * external Postgres. Gates the heavy-compaction route: `VACUUM FULL` only makes
   * sense for the self-maintaining embedded DB; a shared Postgres autovacuums and
   * must not be exclusively locked by a client. See OB-164.
   */
  embedded?: boolean;
  /**
   * Multi-user identity (OB-165). When provided, every `/api/*` request resolves
   * a {@link Principal} (a verified user from an `X-OpenBook-Identity` JWS, or a
   * guest) and the guest-access policy is enforced. Omit for a legacy
   * single-user instance: every caller is an anonymous guest with full access,
   * exactly as before.
   */
  identity?: IdentityProvider;
  /**
   * Scheduled backups (OB-166). When provided, the `/api/backups` routes report
   * status and run on-demand snapshots. Omitted in the in-webview store (no
   * filesystem), where backups are reported unavailable.
   */
  backups?: BackupController;
  /**
   * Account handle-resolution seam (OB-191 / OB-195). When wired, inviting by a
   * bare handle (not an email or `iss#sub`) resolves through it; absent, a bare
   * handle is rejected with guidance to invite by email or subject (§4.4 — account
   * handles aren't built yet). See {@link resolveInvitee}.
   */
  handleResolver?: HandleResolver;
}

export function createApp(store: PageStore, ai?: AiService, hub: PageHub = new PageHub(), opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Push the latest page list to list subscribers (nav stays live).
  const broadcastList = async (): Promise<void> => {
    ai?.invalidateIndex(); // any broadcast-worthy write staleness-marks search
    hub.publishList(await store.listPages());
  };

  // Push a database's latest rows to its subscribers (table/list views stay
  // live). Skipped when nobody is watching to avoid a needless row query on
  // every row-page content save.
  const broadcastRows = async (databaseId: string): Promise<void> => {
    if (!hub.hasRowsListeners(databaseId)) return;
    hub.publishRows(databaseId, await store.listRows(databaseId));
  };

  app.use('*', cors());

  // API responses are dynamic; never let a client cache them. The desktop
  // WKWebView shell heuristically caches header-less GETs, which made the Trash
  // dialog keep showing a stale empty `GET /api/trash` even after a page was
  // moved to the trash (the page list still updated, since it also rides the SSE
  // stream — the trash does not). `no-store` keeps every read fresh.
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  // Access-token gate (only when published on the LAN). A missing/wrong token is
  // rejected before any handler runs. The token may ride the Authorization
  // header or a `?token=` query param so `EventSource` (header-less) can connect.
  if (opts.accessToken) {
    const token = opts.accessToken;
    app.use('/api/*', async (c, next) => {
      const auth = c.req.header('Authorization') ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const provided = bearer || c.req.query('token') || '';
      if (!safeEqual(provided, token)) return c.json({error: 'unauthorized'}, 401);
      return next();
    });
  }

  // Principal resolution + guest-access gate (OB-165). Runs after the
  // reachability gate above (a different axis: "may you reach this instance" vs.
  // "who are you / may a guest do this"). Always sets `c.principal` — a guest
  // when no identity is presented — so every handler can attribute its change.
  // With no identity provider configured the instance stays legacy: everyone is
  // an anonymous guest with full access.
  app.use('/api/*', async (c, next) => {
    const resolved = await resolvePrincipal(c, opts.identity);
    if ('reject' in resolved) return c.json({error: resolved.reject.error}, resolved.reject.status);
    const principal = resolved.principal;
    c.set('principal', principal);
    if (opts.identity) {
      // Guest-floor guarantee (OB-190, OB-189 security review #1). On an
      // identity-enabled instance the only request-time principals `authorize()`
      // may ever judge are `guest | jws` (`local` is in-process only and never
      // arrives over a request). `synced` is never request-emitted and
      // `unverified` only arises with NO identity trust configured — make that a
      // hard invariant rather than an accident, so the `guestAccess='off'`
      // public-read floor (keyed on the guest class) can never be stepped around
      // by a non-jws, non-guest `user` principal. A bad credential is a 401.
      if (principal.verifiedVia !== 'jws' && principal.verifiedVia !== 'guest') {
        return c.json({error: 'identity could not be verified'}, 401);
      }
      const {guestAccess} = await opts.identity.policy();
      const gate = guestGate(principal, guestAccess, c.req.method);
      if (gate) return c.json({error: gate.error}, gate.status);
      // Claim-on-sign-in (contract §4.3 step 3). The first time a verified persona
      // JWS appears, bind every matching `invited` roster row / email ACL to its
      // subject — a no-op for a non-authoritative principal. Runs before any route
      // resolves the role, so a just-claimed membership is live this same request.
      // Best-effort: a claim failure must never fail the request.
      if (principal.verifiedVia === 'jws') {
        await store.claimMemberships(principal).catch((err) => {
          console.error('OpenBook claim-on-sign-in failed:', err);
        });
      }
    }
    return next();
  });

  // Record one change to the durable edit log, attributed to the request's
  // principal. Best-effort + fire-after-commit: a lost log row never costs data,
  // and provenance must not be able to fail a write.
  const logEdit = (c: {get(k: 'principal'): Principal}, pageId: string | null, kind: string, summary = ''): void => {
    void store.logEdit({pageId, author: c.get('principal'), kind, summary}).catch((err) => {
      console.error('OpenBook edit-log write failed:', err);
    });
  };

  // Optional local-AI subsystem (status/search/generate). Mounted only when
  // the host passed a service; document APIs never depend on it.
  if (ai) mountAiRoutes(app, ai, store, broadcastList);
  mountPluginRoutes(app, store);

  app.get(API.health, (c) => c.text('ok'));

  app.get(API.pages, async (c) => c.json(await store.listPagesFor(c.get('principal'))));

  app.post(API.pages, async (c) => {
    const input = await c.req.json<PageInput>();
    // A POST with an id of an existing page is an update (write on that page);
    // otherwise it creates a new page (write at the instance default scope).
    if (input.id && (await store.decidePageAccess(c.get('principal'), input.id)).exists) {
      await requireAccess(c, store, 'write', input.id);
    } else {
      await requireCreate(c, store);
    }
    const page = await store.upsertPage(input, c.get('principal'));
    hub.publishPage(page);
    await broadcastList();
    // A row page's content changed — refresh its database's expr columns.
    if (page.databaseId) await broadcastRows(page.databaseId);
    logEdit(c, page.id, 'page.create', page.name ?? '');
    return c.json(page, 201);
  });

  app.get(`${API.pages}/:id`, async (c) => {
    const page = await store.getPageFor(c.get('principal'), c.req.param('id'));
    return page ? c.json(page) : c.json({error: 'page not found'}, 404);
  });

  app.put(`${API.pages}/:id`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    const input = await c.req.json<PageInput>();
    input.id = c.req.param('id');
    const page = await store.upsertPage(input, c.get('principal'));
    hub.publishPage(page);
    await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    logEdit(c, page.id, 'page.save', page.name ?? '');
    return c.json(page);
  });

  app.patch(`${API.pages}/:id`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    const body = await c.req.json<{name?: string | null}>();
    const page = await store.renamePage(c.req.param('id'), body.name ?? null);
    if (!page) return c.json({error: 'page not found'}, 404);
    hub.publishPage(page);
    await broadcastList();
    logEdit(c, page.id, 'page.rename', page.name ?? '');
    return c.json(page);
  });

  // Shallow-merge structured property values (owner, verification, …) onto a
  // page. Publishes the page so an open editor reflects it live, and refreshes
  // the owning database's rows when the page is a row.
  app.patch(`${API.pages}/:id/properties`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    const body = await c.req.json<{properties?: Record<string, unknown>}>();
    const page = await store.setPageProperties(c.req.param('id'), body.properties ?? {});
    if (!page) return c.json({error: 'page not found'}, 404);
    hub.publishPage(page);
    // The icon shows in the sidebar (it's part of PageMeta), so re-stream the
    // page list when it changes; other properties don't affect the list.
    if (body.properties && 'sys_icon' in body.properties) await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    logEdit(c, page.id, 'page.properties');
    return c.json(page);
  });

  // The backlink graph: pages whose document links to this one. Read-gated on the
  // target page, and the returned linking pages are filtered to those the caller
  // may read (a restricted page that links here must not leak via a backlink).
  app.get(`${API.pages}/:id/backlinks`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    const backlinks = await store.listBacklinks(c.req.param('id'));
    return c.json(await store.filterReadablePages(c.get('principal'), backlinks));
  });

  // Reorder / re-nest a page in the sidebar tree: set its parent and the new
  // ordered sibling list under that parent. 404 if the page is gone, 409 if the
  // move would create a cycle (nesting a page under itself or a descendant).
  app.put(`${API.pages}/:id/move`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    const body = await c.req.json<{parentId?: string | null; orderedIds?: string[]}>();
    const existing = await store.getPage(id);
    if (!existing) return c.json({error: 'page not found'}, 404);
    const page = await store.movePage(id, body.parentId ?? null, body.orderedIds ?? []);
    if (!page) return c.json({error: 'invalid move (would create a cycle)'}, 409);
    hub.publishPage(page);
    await broadcastList();
    logEdit(c, page.id, 'page.move');
    return c.json(page);
  });

  // Soft delete: move the page (and its nested subtree) to the trash. It stays
  // recoverable via the restore route until the cleanup job purges it.
  app.delete(`${API.pages}/:id`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    // Learn the page's database membership before it's gone, so we can refresh
    // the owning database's row list after the delete.
    const existing = await store.getPage(id);
    const deleted = await store.deletePage(id);
    if (!deleted) return c.json({error: 'page not found'}, 404);
    hub.publishDeleted(id);
    await broadcastList();
    if (existing?.databaseId) await broadcastRows(existing.databaseId);
    logEdit(c, id, 'page.delete', existing?.name ?? '');
    return c.body(null, 204);
  });

  // ── Whole-space backup ───────────────────────────────────────────────────────

  // Heavy on-demand compaction (VACUUM FULL). Embedded PGlite only — an external
  // Postgres autovacuums and shouldn't be exclusively locked + rewritten by a
  // client, so it answers 409 there (OB-164).
  app.post(API.compact, async (c) => {
    // VACUUM FULL takes an exclusive lock — gate it to an instance writer so it
    // can't be used as an anonymous DoS (OB-190 follow-up).
    await requireCreate(c, store);
    if (!opts.embedded) {
      return c.json({error: 'compaction is only available for the embedded database'}, 409);
    }
    const {before, after} = await store.compact();
    return c.json({before, after, reclaimed: Math.max(0, before - after)});
  });

  // Whole-instance dump: every non-deleted page + all databases, unfiltered. Gate
  // to an instance writer (owner/admin/loopback) — a non-member/guest must not be
  // able to exfiltrate every restricted/members page in one request (OB-190
  // follow-up, [CRITICAL]).
  app.get(API.exportSpace, async (c) => {
    await requireCreate(c, store);
    return c.json(await store.exportAll());
  });

  app.post(API.importSpace, async (c) => {
    // Wholesale overwrite/inject of pages + databases — instance-writer only
    // (OB-190 follow-up, [HIGH]).
    await requireCreate(c, store);
    const req = await c.req.json<ImportRequest>();
    const result = await store.importBundle(req);
    await broadcastList();
    logEdit(c, null, 'space.import', `${result.created} created, ${result.overwritten} overwritten`);
    return c.json(result);
  });

  // ── Multi-user: instance policy + change provenance (OB-165) ─────────────────

  // The instance's multi-user policy, plus who the server resolved *you* to be
  // on this request (so a client can render "signed in as …" / "guest"). Never
  // leaks private JWKS material — trusted issuers are returned as URLs only.
  app.get(API.instance, async (c) => {
    const config = await store.getInstanceConfig();
    const info: InstanceInfo = {
      guestAccess: config.guestAccess,
      ownerSubject: config.ownerSubject ?? null,
      trustedIssuers: config.trustedIssuers.map((i) => i.issuer),
      audience: config.audience ?? null,
      you: c.get('principal'),
    };
    return c.json(info);
  });

  // Update the policy (guest gate, trusted issuers, owner). Once an owner is
  // claimed, only the owner may change it; before then (fresh instance) any
  // caller may set policy — matching the desktop single-user reality where the
  // first user claims the workspace.
  app.put(API.instance, async (c) => {
    const principal = c.get('principal');
    const current = await store.getInstanceConfig();
    const patch = await c.req.json<Partial<InstanceConfig>>();

    // Owner-claim (OB-182 §2.6 B2). Setting `ownerSubject` on a still-unclaimed
    // instance is the ONE-TIME claim: route it through the atomic compare-and-set
    // and bind the VERIFIED claimer's own subject — never a client-supplied value,
    // and only a verified (jws) identity may claim. The CAS makes first-writer-wins
    // race-safe; a second concurrent claim 409s rather than silently overwriting.
    if (!current.ownerSubject && patch.ownerSubject !== undefined) {
      if (principal.verifiedVia !== 'jws') {
        return c.json({error: 'only a verified identity can claim instance ownership'}, 403);
      }
      const {config, claimed} = await store.claimOwnership(principal.subject);
      if (!claimed) return c.json({error: 'this instance has already been claimed'}, 409);
      // Apply any other policy fields the claim request carried (the CAS already
      // owns `ownerSubject` + the §2.6 bootstrap, so it's stripped here).
      const rest: Partial<InstanceConfig> = {...patch};
      delete rest.ownerSubject;
      const next = Object.keys(rest).length > 0 ? await store.updateInstanceConfig(rest) : config;
      logEdit(c, null, 'instance.claim', principal.subject);
      return c.json(next);
    }

    // Post-claim (or non-claim) policy update: once claimed, only the owner.
    if (current.ownerSubject && principal.subject !== current.ownerSubject) {
      return c.json({error: 'only the instance owner can change multi-user policy'}, 403);
    }
    const next = await store.updateInstanceConfig(patch);
    logEdit(c, null, 'instance.policy', `guestAccess=${next.guestAccess}`);
    return c.json(next);
  });

  // ── Sharing: roster invites + per-page ACL (OB-191; §4.3) ─────────────────────
  // Invite by email (an unclaimed persona, bound on first sign-in by the existing
  // claim-on-sign-in middleware) or by handle/subject (granted immediately). The
  // roster is instance-wide, so managing it is gated like creating at the root
  // (owner / admin / loopback); a page's ACL is gated on write of that page.

  app.get(API.members, async (c) => {
    await requireCreate(c, store);
    return c.json(await store.listMembers());
  });

  app.post(API.members, async (c) => {
    await requireCreate(c, store);
    const body = await c.req.json<{invitee?: string; role?: MemberRole; status?: MemberStatus}>();
    const resolved = await resolveInvitee(body.invitee ?? '', opts.handleResolver);
    // By-email ⇒ an unclaimed persona (default 'invited'); by-subject ⇒ an already
    // known identity (default 'active').
    const status = body.status ?? (resolved.email ? 'invited' : 'active');
    const member = await store.addMember({
      email: resolved.email ?? null,
      subject: resolved.subject ?? null,
      role: body.role ?? 'viewer',
      status,
      invitedBy: c.get('principal').subject,
    });
    logEdit(c, null, 'member.invite', resolved.email ?? resolved.subject ?? '');
    return c.json(member, 201);
  });

  app.patch(`${API.members}/:id`, async (c) => {
    await requireCreate(c, store);
    const patch = await c.req.json<{role?: MemberRole; status?: MemberStatus}>();
    const member = await store.updateMember(c.req.param('id'), patch);
    if (!member) return c.json({error: 'member not found'}, 404);
    logEdit(c, null, 'member.update', member.id);
    return c.json(member);
  });

  app.delete(`${API.members}/:id`, async (c) => {
    await requireCreate(c, store);
    const removed = await store.removeMember(c.req.param('id'));
    if (!removed) return c.json({error: 'member not found'}, 404);
    logEdit(c, null, 'member.revoke', c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${API.pages}/:id/acl`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    return c.json(await store.getPageAcl(c.req.param('id')));
  });

  app.post(`${API.pages}/:id/acl`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    const body = await c.req.json<{invitee?: string; level?: AclLevel}>();
    const resolved = await resolveInvitee(body.invitee ?? '', opts.handleResolver);
    const grant = await store.setPageAcl(id, {
      email: resolved.email ?? null,
      subject: resolved.subject ?? null,
      level: body.level ?? 'read',
      invitedBy: c.get('principal').subject,
    });
    logEdit(c, id, 'acl.share', resolved.email ?? resolved.subject ?? '');
    return c.json(grant, 201);
  });

  app.delete(`${API.pages}/:id/acl`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    const subject = c.req.query('subject');
    const email = c.req.query('email');
    if (!subject && !email) return c.json({error: 'a subject or email query param is required'}, 400);
    const removed = await store.removePageAcl(id, subject ? {subject} : {email: email as string});
    if (!removed) return c.json({error: 'acl grant not found'}, 404);
    return c.body(null, 204);
  });

  // A page's change provenance (the edit log), newest first. The top row is its
  // "last edited by". `?limit=` caps the count (default 100, max 1000).
  app.get(`${API.pages}/:id/edits`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    const limit = Number(c.req.query('limit') ?? 100);
    return c.json(await store.listEdits(c.req.param('id'), Number.isFinite(limit) ? limit : 100));
  });

  // ── Scheduled backups (OB-166) ───────────────────────────────────────────────

  // Backup policy + per-cadence status (last/next run, on-disk count). 501 when
  // the host can't write files (the in-webview store reports this client-side).
  app.get(API.backups, async (c) => {
    if (!opts.backups) return c.json({error: 'scheduled backups are not available on this server'}, 501);
    return c.json(await opts.backups.status());
  });

  // Update the policy (enable, cadences, retention, folder). Owner-gated like the
  // instance policy. The scheduler reads config fresh each tick, so a change
  // takes effect on the next check (or immediately via the run route).
  app.put(API.backups, async (c) => {
    const principal = c.get('principal');
    const instance = await store.getInstanceConfig();
    if (instance.ownerSubject && principal.subject !== instance.ownerSubject) {
      return c.json({error: 'only the instance owner can change backups'}, 403);
    }
    const patch = await c.req.json<Partial<BackupConfig>>();
    await store.updateBackupConfig(patch);
    logEdit(c, null, 'backups.config');
    if (!opts.backups) return c.json({error: 'scheduled backups are not available on this server'}, 501);
    return c.json(await opts.backups.status());
  });

  // Run a snapshot immediately (the "Back up now" action). `{cadence}` selects the
  // tier (default daily); 409 when no backup directory is configured.
  app.post(API.backupRun, async (c) => {
    if (!opts.backups) return c.json({error: 'scheduled backups are not available on this server'}, 501);
    const body = await c.req.json<{cadence?: BackupCadence}>().catch(() => ({}) as {cadence?: BackupCadence});
    const result = await opts.backups.runNow(body.cadence);
    if (!result) return c.json({error: 'no backup directory is configured'}, 409);
    logEdit(c, null, 'backups.run', body.cadence ?? 'daily');
    return c.json(result);
  });

  // ── Trash (soft-deleted pages) ───────────────────────────────────────────────

  app.get(API.trash, async (c) => c.json(await store.filterReadablePages(c.get('principal'), await store.listTrash())));

  // Restore a trashed page (and the subtree trashed with it). The page lives only
  // in the trash, so the write gate resolves its scope/ACL directly (the store's
  // decision reads without a deleted_at filter).
  app.post(`${API.pages}/:id/restore`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    const page = await store.restorePage(c.req.param('id'));
    if (!page) return c.json({error: 'page not found in trash'}, 404);
    hub.publishPage(page);
    await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    logEdit(c, page.id, 'page.restore', page.name ?? '');
    return c.json(page);
  });

  // Permanently delete a single trashed page (and its subtree, by cascade).
  app.delete(`${API.trash}/:id`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    const purged = await store.purgePage(c.req.param('id'));
    if (!purged) return c.json({error: 'page not found in trash'}, 404);
    return c.body(null, 204);
  });

  // Permanently empty the whole trash. Instance-wide destructive action — gated to
  // an instance writer (owner / admin / loopback), like creating at the root.
  app.delete(API.trash, async (c) => {
    await requireCreate(c, store);
    const purged = await store.emptyTrash();
    return c.json({purged});
  });

  // ── Databases ──────────────────────────────────────────────────────────────

  app.post(API.databases, async (c) => {
    const input = await c.req.json<DatabaseInput>();
    // Hosting a database on a page is a write to that page.
    await requireAccess(c, store, 'write', input.pageId);
    const database = await store.createDatabase(input);
    // The host page now hosts a database: refresh its page event + the list so
    // the document area renders the view and the sidebar marks it.
    const host = await store.getPage(database.pageId);
    if (host) hub.publishPage(host);
    await broadcastList();
    logEdit(c, database.pageId, 'database.create', database.name ?? '');
    return c.json(database, 201);
  });

  app.get(`${API.databases}/:id`, async (c) => {
    await requireDbAccess(c, store, 'read', c.req.param('id'));
    const database = await store.getDatabase(c.req.param('id'));
    return database ? c.json(database) : c.json({error: 'database not found'}, 404);
  });

  app.patch(`${API.databases}/:id`, async (c) => {
    await requireDbAccess(c, store, 'write', c.req.param('id'));
    const patch = await c.req.json<DatabaseUpdate>();
    const database = await store.updateDatabase(c.req.param('id'), patch);
    if (!database) return c.json({error: 'database not found'}, 404);
    // Schema changes (new/removed columns, filters) affect every row view.
    await broadcastRows(database.id);
    return c.json(database);
  });

  app.delete(`${API.databases}/:id`, async (c) => {
    const id = c.req.param('id');
    await requireDbAccess(c, store, 'write', id);
    const database = await store.getDatabase(id);
    const deleted = await store.deleteDatabase(id);
    if (!deleted) return c.json({error: 'database not found'}, 404);
    // The host page no longer hosts a database; its rows are gone too.
    if (database) {
      const host = await store.getPage(database.pageId);
      if (host) hub.publishPage(host);
    }
    await broadcastList();
    return c.body(null, 204);
  });

  app.get(`${API.pages}/:id/database`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    const database = await store.getDatabaseByPage(c.req.param('id'));
    return database ? c.json(database) : c.json({error: 'page hosts no database'}, 404);
  });

  app.get(`${API.databases}/:id/rows`, async (c) => {
    await requireDbAccess(c, store, 'read', c.req.param('id'));
    return c.json(await store.listRowsFor(c.get('principal'), c.req.param('id')));
  });

  app.post(`${API.databases}/:id/rows`, async (c) => {
    const id = c.req.param('id');
    await requireDbAccess(c, store, 'write', id);
    const input = await c.req.json<RowInput>().catch(() => ({}) as RowInput);
    const page = await store.createRow(id, input, c.get('principal'));
    hub.publishPage(page);
    await broadcastRows(id);
    logEdit(c, page.id, 'row.create');
    return c.json(page, 201);
  });

  app.put(`${API.databases}/:id/rows/order`, async (c) => {
    const id = c.req.param('id');
    await requireDbAccess(c, store, 'write', id);
    const {orderedIds} = await c.req.json<{orderedIds: string[]}>();
    await store.reorderRows(id, orderedIds ?? []);
    await broadcastRows(id);
    return c.json({ok: true});
  });

  app.patch(`${API.databases}/:id/rows/:rowId`, async (c) => {
    const id = c.req.param('id');
    // A row is a page; gate write on the row itself (it may carry its own ACL).
    await requireAccess(c, store, 'write', c.req.param('rowId'));
    const body = await c.req.json<{name?: string | null; properties?: Record<string, unknown>}>();
    const row = await store.updateRow(id, c.req.param('rowId'), body);
    if (!row) return c.json({error: 'row not found'}, 404);
    await broadcastRows(id);
    logEdit(c, row.id, 'row.update');
    return c.json(row);
  });

  // ── Suggestions + comments (the review layer) ─────────────────────────────
  // Persisted proposed changes (AI write tools + human "Suggest edit") and a
  // general comment layer. These never auto-apply; accepting a suggestion is a
  // client concern (the editor bridge replays its payload as one CRDT
  // transaction) — the server just records the accepted/rejected status.

  app.get(`${API.pages}/:id/suggestions`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    const status = c.req.query('status') as SuggestionStatus | undefined;
    return c.json(await store.listSuggestions(c.req.param('id'), status));
  });

  app.post(`${API.pages}/:id/suggestions`, async (c) => {
    // Suggesting an edit inherits the host page's READ decision — a viewer (who
    // can't write the page) may still propose a never-auto-applied suggestion.
    await requireAccess(c, store, 'read', c.req.param('id'));
    const input = await c.req.json<SuggestionInput>();
    const suggestion = await store.createSuggestion({...input, pageId: c.req.param('id')}, c.get('principal'));
    logEdit(c, c.req.param('id'), 'suggestion.create', input.authorName ?? '');
    return c.json(suggestion, 201);
  });

  app.patch('/api/suggestions/:id', async (c) => {
    // Accept/reject + the returned payload are page content — gate on WRITE of the
    // parent page so a non-grantee with the UUID can't read restricted content or
    // drive an accept/reject (OB-190 follow-up, [MED-HIGH]). A missing suggestion
    // and an unreadable parent both 404 (no existence oracle).
    const existing = await store.getSuggestion(c.req.param('id'));
    if (!existing) return c.json({error: 'suggestion not found'}, 404);
    await requireAccess(c, store, 'write', existing.pageId);
    const patch = await c.req.json<SuggestionUpdate>();
    const suggestion = await store.updateSuggestion(c.req.param('id'), patch);
    if (!suggestion) return c.json({error: 'suggestion not found'}, 404);
    return c.json(suggestion);
  });

  app.delete('/api/suggestions/:id', async (c) => {
    const existing = await store.getSuggestion(c.req.param('id'));
    if (!existing) return c.json({error: 'suggestion not found'}, 404);
    await requireAccess(c, store, 'write', existing.pageId);
    const deleted = await store.deleteSuggestion(c.req.param('id'));
    if (!deleted) return c.json({error: 'suggestion not found'}, 404);
    return c.body(null, 204);
  });

  app.get(`${API.pages}/:id/comments`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    return c.json(await store.listComments(c.req.param('id')));
  });

  app.post(`${API.pages}/:id/comments`, async (c) => {
    // Commenting inherits the host page's READ decision (a reader may comment).
    await requireAccess(c, store, 'read', c.req.param('id'));
    const input = await c.req.json<CommentInput>();
    const comment = await store.createComment({...input, pageId: c.req.param('id')}, c.get('principal'));
    logEdit(c, c.req.param('id'), 'comment.create', input.authorName ?? '');
    return c.json(comment, 201);
  });

  app.delete('/api/comments/:id', async (c) => {
    // Gate deletion on WRITE of the parent page (OB-190 follow-up, [MED]). A
    // missing comment and an unreadable parent both 404 (no existence oracle).
    const existing = await store.getComment(c.req.param('id'));
    if (!existing) return c.json({error: 'comment not found'}, 404);
    await requireAccess(c, store, 'write', existing.pageId);
    const deleted = await store.deleteComment(c.req.param('id'));
    if (!deleted) return c.json({error: 'comment not found'}, 404);
    return c.body(null, 204);
  });

  // ── Live update streams (Server-Sent Events) ──────────────────────────────

  // The multiplexed firehose: one connection per client carrying every event.
  // This is what the client uses — it keeps each tab to a single long-lived
  // connection so multiple tabs don't exhaust the browser's per-origin limit.
  app.get(API.live, (c) => {
    // Principal-aware firehose (S4): the initial snapshot is read-filtered, and
    // every subsequent event passes the per-subscriber `live` gate before it is
    // emitted — unreadable pages/rows are filtered out of each frame.
    const principal = c.get('principal');
    const gates = streamGates(store, principal);
    return streamSSE(c, async (stream) => {
      // Initial snapshot uses the same envelope as live events so the client
      // parses every message uniformly.
      await stream.writeSSE({event: 'list', data: JSON.stringify({type: 'list', pages: await store.listPagesFor(principal)})});
      const unsubscribe = hub.subscribeLive((event) => {
        void stream.writeSSE({event: event.type, data: JSON.stringify(event)}).catch(() => undefined);
      }, gates.live);
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get(API.stream, (c) => {
    // The sidebar list stream: each frame is read-filtered per subscriber.
    const principal = c.get('principal');
    const gates = streamGates(store, principal);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({event: 'list', data: JSON.stringify(await store.listPagesFor(principal))});
      const unsubscribe = hub.subscribeList((event) => {
        void stream.writeSSE({event: 'list', data: JSON.stringify(event.pages)}).catch(() => undefined);
      }, gates.list);
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get(`${API.pages}/:id/stream`, async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    // 404 if the page isn't readable right now (hide existence at open time); the
    // per-event `page` gate then drops events should read access be lost later.
    await requireAccess(c, store, 'read', id);
    const gates = streamGates(store, principal);
    return streamSSE(c, async (stream) => {
      const initial = await store.getPageFor(principal, id);
      if (initial) await stream.writeSSE({event: 'page', data: JSON.stringify(initial)});
      const unsubscribe = hub.subscribePage(id, (event) => {
        if (event.type === 'page') {
          void stream.writeSSE({event: 'page', data: JSON.stringify(event.page)}).catch(() => undefined);
        } else {
          void stream.writeSSE({event: 'deleted', data: JSON.stringify({id: event.id})}).catch(() => undefined);
        }
      }, gates.page);
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get(`${API.databases}/:id/stream`, async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');
    // 404 if the database's host page isn't readable now; the per-event `rows`
    // gate filters/drops rows as access changes.
    await requireDbAccess(c, store, 'read', id);
    const gates = streamGates(store, principal);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({event: 'rows', data: JSON.stringify(await store.listRowsFor(principal, id))});
      const unsubscribe = hub.subscribeRows(id, (event) => {
        void stream.writeSSE({event: 'rows', data: JSON.stringify(event.rows)}).catch(() => undefined);
      }, gates.rowsFor(id));
      stream.onAbort(unsubscribe);
      try {
        while (!stream.aborted) {
          await stream.sleep(25_000);
          await stream.writeSSE({event: 'ping', data: ''});
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.onError((err, c) => {
    // Access-gate rejections (requireAccess/requireDbAccess/requireCreate) ride
    // HTTPException; surface them as the JSON `{error}` shape the API uses,
    // preserving the gate's 403/404 (never collapse them to a 500 below).
    if (err instanceof HTTPException) {
      return c.json({error: err.message}, err.status);
    }
    // Invite-resolution failures (bad email, unresolvable handle) carry their own
    // 400/422 status — surface them in the API `{error}` shape (OB-191).
    if (err instanceof InviteResolutionError) {
      return c.json({error: err.message}, err.status);
    }
    if (isUniqueViolation(err)) {
      return c.json({error: 'a page with that name already exists'}, 409);
    }
    console.error('OpenBook server error:', err);
    return c.json({error: 'internal server error'}, 500);
  });

  return app;
}

/** Postgres unique-violation (SQLSTATE 23505), across both DB backends. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {code?: string; message?: string};
  if (e.code === '23505') return true;
  // PGlite surfaces the violation in the message rather than a code field.
  return typeof e.message === 'string' && /duplicate key|unique constraint|pages_name_key/i.test(e.message);
}
