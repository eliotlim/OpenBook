import {Hono, type Context} from 'hono';
import {cors} from 'hono/cors';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';
import {streamSSE} from 'hono/streaming';
import {
  API,
  AGENT_EDITS_MODES,
  AGENT_EDITS_POLICIES,
  FORWARDED_HEADER,
  PAGE_VISIBILITIES,
  type AclLevel,
  type AgentEditsPolicy,
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
  type PageVisibility,
  type Principal,
  type RowInput,
  type SuggestionInput,
  type SuggestionStatus,
  type SuggestionUpdate,
  localPrincipal,
  verifiedSubject,
} from '@book.dev/sdk';
import {PageStore, AssetBudgetError} from './store';
import {PageHub} from './hub';
import {CollabRelay} from './collab';
import {ServerAuthoritativePersister} from './collabPersist';
import {AwarenessRelay, awarenessUser, stampAwarenessIdentity} from './collabAwareness';
import {mountAiRoutes} from './ai/routes';
import {mountPluginRoutes} from './pluginRoutes';
import {guestGate, isLocalOwnerRequest, recoverAudienceLockedPrincipal, resolvePrincipal, type IdentityProvider} from './principal';
import {requireAccess, requireCreate, requireDbAccess, requireInstanceAdmin, streamGates} from './access';
import {
  AGENT_FAILED_RATE_LIMIT,
  AGENT_RATE_WINDOW_MS,
  AGENT_TOKEN_RATE_LIMIT,
  FixedWindowLimiter,
  agentPrincipal,
  agentRequireRemoteFlagOn,
  agentScopeAllows,
  bearerAgentToken,
  clientIpKey,
  hashAgentToken,
  isAgentApiEnabled,
  isAgentRemoteEnabled,
} from './agentTokens';
import {mountAgentTokenRoutes} from './agentTokenRoutes';
import {mountMcpHttp} from './mcpHttp';
import {InviteResolutionError, resolveInvitee, type HandleResolver} from './invites';
import type {BackupController} from './backups';
import type {RosterController} from './rosterSync';
import type {AppEnv} from './appEnv';
import type {AiService} from './ai/service';
import type {McpClientManager} from './ai/mcpClients';
import type {AiUsageLog} from './ai/usage';

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

/**
 * AGENT-6 / AGED-1 defense-in-depth: privileged jws-only page POLICY controls that an
 * agent PAT must NEVER change. Two families gate here:
 *
 *  - SHARING / EXPOSURE (per-page ACL grants + visibility scope): a durable ACL grant
 *    would SURVIVE the token's revocation (a permanent backdoor defeating
 *    revocation-as-mitigation), and flipping a restricted page to `public` is an
 *    outright confidentiality break.
 *  - AGENT-EDITS policy (AGED-1): letting a PAT set a page to `agentEdits='direct'`
 *    would be SELF-AUTHORIZATION — the token relaxing the very policy that governs
 *    whether agents may edit that page directly.
 *
 * These routes ordinarily gate on mere page-write (which a write-PAT passes), so they
 * get an explicit `pat` refusal at the handler — belt-and-braces on top of the
 * scope-gate, which also carves these sub-paths out of the PAT allowlist entirely.
 */
function denyPatPolicy(c: Context<AppEnv>): void {
  if (c.get('principal').verifiedVia === 'pat') {
    throw new HTTPException(403, {message: 'agent tokens cannot change page sharing, visibility, or agent-edits policy'});
  }
}

/**
 * The image mime types the asset store echoes back verbatim as a response
 * `Content-Type` (Assets A1 is image-only for v1 — A0's block only produces image
 * data-URLs). `image/svg+xml` is deliberately EXCLUDED: SVG can carry inline
 * `<script>`, so serving it as `image/svg+xml` in the app origin would be stored
 * XSS. Anything off this list is coerced to `application/octet-stream`, which —
 * with `nosniff` + `Content-Disposition: attachment` on the served response — can
 * never execute. Grow this list (never add `svg+xml`) if v2 serves more types.
 */
const ASSET_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
]);

/**
 * Canonicalize an uploader-controlled mime into a value SAFE to store and echo as a
 * response `Content-Type` (stored-XSS defense — the uploader picks this string via
 * the upload `Content-Type` header or the JSON `mime` field). Returns `null` when
 * the raw value carries a control char / CR / LF — a header-injection or
 * header-set-throw (500) risk — so the route rejects it (400). Otherwise the
 * parameter-stripped, lowercased base type when it's an allowlisted image, else
 * `application/octet-stream`. Because every path stores only a sanitized mime, the
 * `ON CONFLICT DO NOTHING` first-seen-mime dedup can never be poisoned into serving
 * an executable type.
 */
function safeAssetMime(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control chars (CR/LF/NUL/etc)
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const base = raw.split(';', 1)[0].trim().toLowerCase();
  return ASSET_IMAGE_MIMES.has(base) ? base : 'application/octet-stream';
}

/**
 * RFC 9110 `If-None-Match` matcher for our strong, content-addressed asset ETag.
 * Returns true when the client's cached validator still matches `etag` (⇒ 304 Not
 * Modified). `*` matches any existing representation; otherwise any comma-separated
 * member equals `etag` under the spec's WEAK comparison for `If-None-Match` — a
 * `W/` prefix on either side is ignored, which is harmless here because the asset
 * bytes are immutable (equal id ⇔ equal bytes), so there is no weak/strong drift.
 * Callers MUST run the read-gate first: a 304 is only ever reachable once the asset
 * has been authorized, so this validator can never become a gated-content oracle.
 */
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const strip = (t: string): string => t.trim().replace(/^W\//, '');
  const want = strip(etag);
  return header.split(',').some((raw) => {
    const t = raw.trim();
    return t === '*' || strip(t) === want;
  });
}

/**
 * The Hono app augmented with the optional Collab T9 server-authoritative persister
 * (`null` when `serverPersist` is off). The host ({@link server.ts}) reaches it to
 * flush every dirty canonical doc on shutdown before the store closes.
 */
export type AppWithCollab = Hono<AppEnv> & {collabPersist?: ServerAuthoritativePersister | null};

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
  /**
   * Managed-library roster sync (OB-199; LIB-5 wire rename). When provided (the
   * instance is bound, or could be), the `/api/library/sync` routes (and their
   * legacy `/api/workspace/sync` alias) report binding status and run an on-demand
   * reconcile of the bound library roster into the local roster. Omitted ⇒ the
   * routes report "unavailable" (standalone instance).
   */
  roster?: RosterController;
  /**
   * Server-authoritative Yjs persistence (Collab T9) — opt-in, default off. When
   * true, the server keeps a per-page canonical CRDT doc fed by every write-gated
   * `/updates` and debounce-persists a snapshot FROM it (with per-block attribution
   * derived from the ingesting principal), so a stale client's whole-snapshot save
   * can no longer overwrite newer content — the durable end-state always converges
   * to the CRDT merge. When off, the persister is never constructed and durability
   * is exactly the shipped T3 client-saver model. Applies to the durable native
   * server (desktop/tunneled/headless); the in-webview store has no shared server.
   */
  serverPersist?: boolean;
  /**
   * Per-instance total asset-storage budget in bytes (Assets A6). When set, an
   * upload that would push the sum of all stored asset bytes past this budget is
   * rejected with a friendly 507 (a byte-identical re-upload of existing content is
   * always allowed — dedup adds no bytes). Defaults to
   * {@link DEFAULT_ASSET_STORAGE_BUDGET_BYTES} (overridable via
   * `OPENBOOK_ASSET_STORAGE_BUDGET_BYTES`); `<= 0` disables the budget (unlimited).
   */
  assetStorageBudgetBytes?: number;
  /**
   * The per-run local-owner secret (the loopback-owner hatch — see
   * {@link isLocalOwnerRequest}). Minted by the host that spawned this server (the
   * desktop app) and stamped by its IPC bridge on exactly the requests that
   * originate in the app's own webview. A non-forwarded request presenting it is
   * granted machine-owner authority: it resolves as the `local` principal when it
   * carries no verified identity, keeps owner-gated routes reachable when it does,
   * and may repair a drifted `ownerSubject`. Unset (headless/server mode, tests,
   * the in-browser client) ⇒ the hatch is inert.
   */
  localOwnerSecret?: string;
  /**
   * The server-managed AI usage-attribution log (C1). When provided, the AI
   * routes log a usage row per model call through it, and the database write
   * routes reject end-user create-row / update-row / patch / delete against its
   * managed database (only the server's own attribution writes land). Seeded and
   * owned by the caller (`startServer`); omitted in tests / the in-webview store.
   */
  aiUsage?: AiUsageLog;
  /**
   * The external-tools (MCP client) manager (AGENT-3). When provided, the AI
   * routes expose the admin-only `/api/ai/mcp` surface and the agent run merges
   * its namespaced `mcp__*` tools (for writer-gated principals only). Owned by
   * the caller (`startServer`); omitted in tests / the in-webview store, where
   * external tools are simply unavailable.
   */
  mcp?: McpClientManager;
}

/**
 * Default per-instance asset-storage budget (Assets A6): a generous 5 GiB backstop
 * against runaway storage from an authed-but-hostile (or just runaway-import)
 * writer. Each asset is separately capped at 10 MiB, so this is ~500+ max-size
 * assets before the friendly 507. Overridable per-instance via the option or
 * `OPENBOOK_ASSET_STORAGE_BUDGET_BYTES`; a non-positive value disables it.
 */
export const DEFAULT_ASSET_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;

/** Resolve the configured asset-storage budget (option → env → default). A
 *  non-positive result means "no budget" (unlimited). */
function resolveAssetStorageBudgetBytes(opt: number | undefined): number {
  if (opt != null) return opt;
  const env = process.env.OPENBOOK_ASSET_STORAGE_BUDGET_BYTES;
  if (env != null && env.trim() !== '' && Number.isFinite(Number(env))) return Number(env);
  return DEFAULT_ASSET_STORAGE_BUDGET_BYTES;
}

export function createApp(store: PageStore, ai?: AiService, hub: PageHub = new PageHub(), opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Live-collaboration catch-up memory (Collab T1): per-page ephemeral relay docs,
  // seeded from the durable snapshot, so a late joiner can sync to the current doc.
  // Persists nothing — the debounced snapshot save stays the sole durable checkpoint.
  const relay = new CollabRelay();
  // Ephemeral presence (Collab T4): per-page identity-stamped awareness snapshot so
  // a late joiner sees who's here at once. Persists nothing, like the relay above.
  const awarenessRelay = new AwarenessRelay();

  // Agent PAT rate limiters (AGENT-6), scoped to this app instance (the native
  // server is single-process). `patTokenLimiter` caps a valid token's request rate;
  // `patFailLimiter` caps FAILED PAT attempts per client IP so the hash space can't
  // be brute-forced or used to DoS the lookup.
  const patTokenLimiter = new FixedWindowLimiter(AGENT_TOKEN_RATE_LIMIT, AGENT_RATE_WINDOW_MS);
  const patFailLimiter = new FixedWindowLimiter(AGENT_FAILED_RATE_LIMIT, AGENT_RATE_WINDOW_MS);
  // Loads a page's durable snapshot as raw Yjs update bytes — the seed base for the
  // relay doc. The block document stores its CRDT state as base64 in `blockdoc.update`.
  const loadRelayBase = async (pageId: string): Promise<Uint8Array | null> => {
    const page = await store.getPage(pageId);
    const update = (page?.data as {blockdoc?: {update?: string}} | undefined)?.blockdoc?.update;
    return typeof update === 'string' && update.length > 0 ? Buffer.from(update, 'base64') : null;
  };

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

  // Server-authoritative Yjs persistence (Collab T9) — opt-in (default off). When
  // enabled, the server persists the durable snapshot FROM its own canonical CRDT
  // doc (fed by every write-gated `/updates`), removing the LWW window. A checkpoint
  // fans out exactly like a PUT save (hub publish → live peers + the OB-241 disk
  // mirror), so the mirror/conflict/mtimes machinery is untouched. Constructed only
  // when enabled, so the default path allocates nothing and behaves identically.
  let persister: ServerAuthoritativePersister | null = null;
  if (opts.serverPersist) {
    persister = new ServerAuthoritativePersister({
      loadBase: loadRelayBase,
      saveDoc: (id, blockdoc, authorsByBlock) => store.saveServerDoc(id, blockdoc, authorsByBlock),
      onPersisted: (page) => {
        hub.publishPage(page); // → live peers + OB-241 disk mirror (server.ts subscription)
        void broadcastList();
        if (page.databaseId) void broadcastRows(page.databaseId);
      },
    });
  }
  // Expose the persister so the host (server.ts) can flush every dirty canonical doc
  // on shutdown BEFORE the store closes — the no-lost-edit-on-shutdown guarantee.
  (app as AppWithCollab).collabPersist = persister;

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
      // An agent PAT (AGENT-6) is its OWN credential class and, when valid, satisfies
      // reachability on its own ("PAT ≥ accessToken" — an intentional LAN trust
      // change): don't measure a `Bearer obat_…` against the instance accessToken
      // (which it would always fail). It is validated — or HARD-401'd — by the PAT
      // resolution in the principal middleware below, so a garbage/disabled PAT never
      // gets served here; it just isn't rejected by THIS gate.
      if (bearerAgentToken(c)) return next();
      if (isLocalOwnerRequest(c, opts.localOwnerSecret)) return next(); // loopback owner satisfies the LAN reachability gate
      const auth = c.req.header('Authorization') ?? '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const provided = bearer || c.req.query('token') || '';
      if (!safeEqual(provided, token)) return c.json({error: 'unauthorized'}, 401);
      return next();
    });
  }

  // Forwarded-exposure backstop (OB-209). Forwarding is an OUTBOUND tunnel: the
  // instance stays on loopback/IPC, so a forwarded inbound request slips past the
  // BOOT exposure backstop (`assertExposureSafe`, which only guards a *listener*
  // bind). The tunnel client marks every request it forwards (`FORWARDED_HEADER`);
  // if such a request reaches a still-UNCLAIMED instance, `authorize()` rule-0 would
  // short-circuit to the legacy guest gate (default `guestAccess:'write'`) and serve
  // it anonymous + world-writable over the public address (OB-182 §2.6 B2). Fail
  // closed: the exposed path is only ever served once the instance is claimed. The
  // publish flow claims BEFORE it exposes (the client guard); this is the origin-side
  // last line if that is ever bypassed (a stale client, a replayed marker, a manual
  // tunnel). A loopback request never carries the marker, so the local single-user
  // experience is untouched. `/health` is not under `/api/*` and stays reachable.
  app.use('/api/*', async (c, next) => {
    if (!c.req.header(FORWARDED_HEADER)) return next();
    const {ownerSubject} = await store.getInstanceConfig();
    if (!ownerSubject) {
      return c.json(
        {error: 'this instance is not claimed; forwarding requires an instance owner before it can be exposed (OB-182 §2.6)'},
        403,
      );
    }
    return next();
  });

  // Principal resolution + guest-access gate (OB-165). Runs after the
  // reachability gate above (a different axis: "may you reach this instance" vs.
  // "who are you / may a guest do this"). Always sets `c.principal` — a guest
  // when no identity is presented — so every handler can attribute its change.
  // With no identity provider configured the instance stays legacy: everyone is
  // an anonymous guest with full access.
  app.use('/api/*', async (c, next) => {
    // An agent PAT (AGENT-6) is a distinct credential class — detect it FIRST. A
    // PAT-bearing request never ALSO claims the loopback-owner hatch (so a stolen
    // PAT can't ride `localOwner` past `requireInstanceAdmin`); the host secret is
    // irrelevant when the caller presents a token.
    const pat = bearerAgentToken(c);

    // Loopback-owner hatch: a non-forwarded request presenting the host's per-run
    // secret is the machine owner's own app. Resolved once here; owner-gated routes
    // (instance policy, ownership repair, whole-library export/import) also read
    // the flag, so a signed-in-but-drifted identity keeps machine-owner authority.
    const localOwner = !pat && isLocalOwnerRequest(c, opts.localOwnerSecret);
    if (localOwner) c.set('localOwner', true);

    let principal: Principal;
    if (pat) {
      const forwarded = !!c.req.header(FORWARDED_HEADER);
      // Whether this request must satisfy the REMOTE-MCP conjunction (AGENT-7). A
      // FORWARDED PAT always must; when `OPENBOOK_REQUIRE_REMOTE_FLAG` is set a
      // MARKER-LESS PAT must too (R4 — closes the direct-to-origin self-host residual
      // where a PAT is dialed straight at an internet-exposed origin that never crosses
      // the edge, so no marker is ever stamped).
      const requireRemoteFlag = agentRequireRemoteFlagOn();
      const remoteGated = forwarded || requireRemoteFlag;

      // ── Conjunctive forwarded-guard (AGENT-7, replaces the old unconditional 403) ──
      // A forwarded PAT is admitted ONLY on the exact `/api/mcp` path of a
      // remote-enabled instance; every OTHER forwarded `/api/*` path 403s exactly as
      // before. The CHEAP legs (path, instance setting) run BEFORE the DB token lookup
      // so a forwarded flood on a non-`/api/mcp` path (or a remote-off instance) is
      // rejected without hash+DB work; the per-token `remote_ok` leg necessarily runs
      // after resolution (below). The unclaimed-instance backstop above already ran.
      if (forwarded) {
        if (c.req.path !== API.mcp || !(await isAgentRemoteEnabled(store))) {
          return c.json({error: 'agent tokens are not accepted over a forwarded connection'}, 403);
        }
      } else if (requireRemoteFlag) {
        // R4: a marker-less PAT on a require-remote-flag instance must ALSO be
        // remote-enabled. Unlike a forwarded request this does NOT narrow the path — an
        // admitted remote token's in-process loop-back calls (`/api/pages`, …) must
        // still resolve. The `remote_ok` leg runs after resolution (below).
        if (!(await isAgentRemoteEnabled(store))) {
          return c.json({error: 'this agent token is not enabled for remote access'}, 403);
        }
      }

      // Agent-PAT resolution. DARK by default: a PAT only resolves when the admin has
      // enabled `agentApi` AND the `OPENBOOK_AGENT_API=0` kill-switch env is unset —
      // otherwise the token is treated as invalid and HARD-401s (never a silent
      // downgrade to guest). An invalid / revoked / expired token 401s here too, before
      // any route runs. The per-IP failed-PAT limiter makes the hash space
      // un-brute-forceable; the per-token limiter caps a valid token's rate.
      if (!(await isAgentApiEnabled(store))) {
        return c.json({error: 'unauthorized'}, 401);
      }
      // R2 early-429 (design §3.4.7): if the failed-PAT bucket is ALREADY over the
      // limit, shed the request BEFORE the expensive SHA-256 + row lookup — this stops
      // a garbage-PAT flood (through the tunnel or a direct-dial self-host origin) from
      // churning DB work per request. `peek` never increments, so a valid token's
      // traffic (keyed on `row.id` at the per-token limiter) is untouched.
      if (patFailLimiter.peek(clientIpKey(c))) {
        return c.json({error: 'too many failed attempts'}, 429);
      }
      const row = await store.resolveAgentToken(hashAgentToken(pat));
      if (!row) {
        const over = patFailLimiter.exceeded(clientIpKey(c));
        return c.json({error: over ? 'too many failed attempts' : 'unauthorized'}, over ? 429 : 401);
      }
      // Final remote conjunct (L7): a remote-gated request needs a `remote_ok` token. A
      // valid-but-non-remote token gets a distinct 403 (not an oracle — the caller
      // already holds the token; the message drives the right operator action).
      if (remoteGated && !row.remoteOk) {
        return c.json({error: 'this agent token is not enabled for remote access'}, 403);
      }
      if (patTokenLimiter.exceeded(row.id)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      principal = agentPrincipal(row);
      c.set('agentToken', {id: row.id, scope: row.scope, remote: row.remoteOk});
      void store.touchAgentTokenUsed(row.id).catch(() => {});
    } else {
      const resolved = await resolvePrincipal(c, opts.identity);
      if ('reject' in resolved) {
        // The machine owner is never locked out of their own instance by a bad
        // credential: an expired / re-issued / audience-locked token over the trusted
        // local transport degrades to the local-owner principal instead of a 401. The
        // strict no-silent-downgrade rule stays in force for every other caller —
        // over the hatch the *transport* is the credential.
        if (localOwner) {
          c.set('principal', localPrincipal());
          return next();
        }
        // Loopback-owner audience-lockout recovery (OB-202): a token rejected solely
        // for its audience may still relax this instance's own audience requirement,
        // so the owner is never permanently stranded behind it. Everything else stays
        // rejected, and the instance route's owner-check still gates WHO may apply it.
        const recovered = await recoverAudienceLockedPrincipal(c, opts.identity);
        if (recovered) {
          c.set('principal', recovered);
          return next();
        }
        return c.json({error: resolved.reject.error}, resolved.reject.status);
      }
      // A signed-out machine owner is the local owner, not an anonymous guest; a
      // verified identity (when presented) still wins, so edits stay attributed to
      // the signed-in user and persona/email-ACL matching keeps working.
      principal = localOwner && resolved.principal.kind === 'guest' ? localPrincipal() : resolved.principal;
    }
    c.set('principal', principal);
    if (opts.identity) {
      // Guest-floor guarantee (OB-190, OB-189 security review #1). On an
      // identity-enabled instance the only request-time principals `authorize()`
      // may ever judge are `guest | jws | pat` — plus `local`, which arrives over a
      // request ONLY via the loopback-owner hatch above (the host-minted secret;
      // never mintable from a header alone). A `pat` is admitted HERE explicitly and
      // ONLY after `resolveAgentToken` above confirmed it valid (an invalid PAT never
      // reaches this line — it 401'd). `synced` is never request-emitted and
      // `unverified` only arises with NO identity trust configured — make that a
      // hard invariant rather than an accident, so the `guestAccess='off'`
      // public-read floor (keyed on the guest class) can never be stepped around
      // by a non-jws, non-guest, non-pat `user` principal. A bad credential is a 401.
      if (
        principal.verifiedVia !== 'jws' &&
        principal.verifiedVia !== 'guest' &&
        principal.verifiedVia !== 'pat'
      ) {
        if (!(localOwner && principal.verifiedVia === 'local')) {
          return c.json({error: 'identity could not be verified'}, 401);
        }
      }
      const {guestAccess} = await opts.identity.policy();
      const gate = guestGate(principal, guestAccess, c.req.method);
      if (gate) return c.json({error: gate.error}, gate.status);
      // Claim-on-sign-in (contract §4.3 step 3). The first time a verified persona
      // JWS appears, bind every matching `invited` roster row / email ACL to its
      // subject — a no-op for a non-authoritative principal. Runs before any route
      // resolves the role, so a just-claimed membership is live this same request.
      // Best-effort: a claim failure must never fail the request. Never for a PAT (it
      // is not a persona sign-in and must not claim invited rows).
      if (principal.verifiedVia === 'jws') {
        await store.claimMemberships(principal).catch((err) => {
          console.error('OpenBook claim-on-sign-in failed:', err);
        });
      }
    }
    return next();
  });

  // Agent-PAT scope-gate (AGENT-6). A STRICT explicit default-deny PATH allowlist
  // that confines a `pat` request to its read/write scope — it runs only for a
  // PAT-authenticated request (the `agentToken` var is set) and never touches any
  // other principal. Deliberately PATH-shaped, not method-shaped: many privileged
  // routes are GETs (export/members/backups/instance/library-sync/plugins/ai-status),
  // so "any GET is a read" would be a hole. Everything not explicitly allowlisted is
  // DENIED. This is defence in depth ON TOP of the per-route gates + the jws-only
  // privileged owner checks — not the sole confinement.
  app.use('/api/*', async (c, next) => {
    const agentToken = c.get('agentToken');
    if (!agentToken) return next();
    if (!agentScopeAllows(agentToken.scope, c.req.method, c.req.path)) {
      return c.json({error: 'this agent token is not permitted to access this resource'}, 403);
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

  // The server-managed AI usage database (C1) is read-only over the API. The
  // DB-route guard (`rejectManaged`, below) covers `/api/databases/*`, but its
  // host page and attribution rows are ordinary pages reachable through the generic
  // `/api/pages/*` routes — so an owner/admin could otherwise delete rows, trash the
  // host, un-restrict it (exposing every user's usage), re-home it, or grant it an
  // ACL. This mirrors `rejectManaged` for a PAGE id and is called AFTER the access
  // gate, so a non-reader still gets an existence-hiding 404 and only a would-be
  // mutator sees the managed 403. Server-internal store calls (the seed, attribution
  // writes, the auto-expiry sweep) never pass through here, so they're untouched.
  const rejectManagedPage = async (pageId: string): Promise<void> => {
    if (await opts.aiUsage?.isManagedPage(pageId)) {
      throw new HTTPException(403, {message: 'this page is server-managed and cannot be edited via the API'});
    }
  };

  // Optional local-AI subsystem (status/search/generate). Mounted only when
  // the host passed a service; document APIs never depend on it.
  if (ai) mountAiRoutes(app, ai, store, broadcastList, opts.aiUsage, opts.mcp);
  // Remote streamable-HTTP MCP transport (AGENT-5). The `/api/*` middleware stack
  // registered above (bearer gate, forwarded-reject, PAT resolution + guest floor,
  // scope-gate) runs before this handler. DARK by default and structurally loopback/
  // LAN-only (see mcpHttp.ts). The `agentApi` scope-gate allowlist admits ALL of
  // `/api/mcp`; scope is re-enforced per tool call by the handler's PAT loop-back.
  mountMcpHttp(app, store);
  mountPluginRoutes(app, store);
  // Agent-PAT management (AGENT-6): admin-only mint/list/revoke + the dark `agentApi`
  // toggle. A PAT can never reach these (both `requireInstanceAdmin` and the
  // scope-gate deny it); minting binds each token to the minter's own verified
  // subject.
  mountAgentTokenRoutes(app, store, logEdit);

  app.get(API.health, (c) => c.text('ok'));

  app.get(API.pages, async (c) => c.json(await store.listPagesFor(c.get('principal'))));

  app.post(API.pages, async (c) => {
    const input = await c.req.json<PageInput>();
    // A POST whose id names a page the caller may READ is an update (write-gated on
    // that page); anything else is a create (gated at the instance default scope).
    // Keying on read-access — not mere existence — closes the N6 existence oracle:
    // an existing-but-unreadable id and a nonexistent id both fall to the create
    // gate and answer alike (403 for a non-creator), so POST can't distinguish a
    // private page from a missing one.
    if (input.id && (await store.canReadPage(c.get('principal'), input.id))) {
      await requireAccess(c, store, 'write', input.id);
    } else {
      await requireCreate(c, store);
    }
    // A POST carrying a managed usage page's id is an upsert onto it (ON CONFLICT →
    // name+data overwrite), so gate it like the other page routes. Placed after the
    // access gate: a would-be mutator (reader, or a create-capable guest whose upsert
    // would otherwise clobber the managed host/row) sees the managed 403; a normal
    // create/update is untouched (isManagedPage is false for any other id).
    if (input.id) await rejectManagedPage(input.id);
    // ER-7: a keyless create carrying an `input.idempotencyKey` is deduped
    // per-principal inside `upsertPage` — a retried/replayed POST returns the page
    // the first call minted instead of a duplicate. The key is scoped to this
    // request's resolved principal, so it can never dedupe against another user's
    // write. (The SDK also pre-mints the page id for keyless creates, so a replay
    // hits the store's `ON CONFLICT` no-op even without a key.)
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
    // A managed usage page (host or attribution row) can't be renamed/body-overwritten
    // via upsert either — after the access gate so a non-reader stays 404 (see PATCH).
    await rejectManagedPage(c.req.param('id'));
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
    await rejectManagedPage(c.req.param('id'));
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
    await rejectManagedPage(c.req.param('id'));
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

  // ── Assets: content-addressed binary store (OB-ASSETS A1) ────────────────────

  // 10 MiB per upload, measured on the DECODED bytes. A single embedded image /
  // attachment is comfortably under this; the cap stops an authed-but-hostile
  // writer inflating the store with one giant asset.
  const ASSET_MAX_BYTES = 10 * 1024 * 1024;
  // The request BODY can be base64 (the in-webview / desktop-IPC transports send
  // `{data: base64, mime}`), which inflates the payload ~4/3 plus a small JSON
  // envelope. Size the raw-body limit to fit a full ASSET_MAX_BYTES image once
  // base64-encoded, so the advertised 10 MiB cap is actually reachable over that
  // path (a ~10 MiB raw image → ~13.3 MiB body would otherwise 413). The handler
  // still enforces ASSET_MAX_BYTES on the DECODED bytes below, so a genuinely
  // oversize decoded payload is rejected regardless of the transport.
  const ASSET_MAX_BODY_BYTES = Math.ceil(ASSET_MAX_BYTES * 4 / 3) + 64 * 1024;
  // Per-instance total-storage budget (A6): a NEW upload that would push the sum of
  // all stored asset bytes past this is rejected with a friendly 507. `<= 0` means
  // no budget. A dedup re-upload adds no bytes and is always allowed (in the store).
  const ASSET_STORAGE_BUDGET_BYTES = resolveAssetStorageBudgetBytes(opts.assetStorageBudgetBytes);

  // Upload an asset. Write-gated to `?pageId=<id>` — a page the uploader can write —
  // and ref'd to that page in the same request, so the asset is immediately
  // reachable (readable) by that page's readers and never lands orphaned/ungated.
  // The body is raw binary (its `Content-Type` is the stored mime) or, for the
  // in-webview transports whose bridge corrupts raw binary, a JSON `{data: base64,
  // mime}`. Returns `{id}` — the SHA-256 content hash; a byte-identical re-upload
  // dedups to the same id. 201 / 400 / 403|404 (write gate) / 413 (too large).
  app.post(
    API.assets,
    bodyLimit({maxSize: ASSET_MAX_BODY_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
      const pageId = c.req.query('pageId');
      if (!pageId) return c.json({error: 'pageId is required'}, 400);
      // A page the uploader cannot read 404s (hide existence); readable-but-not-
      // writable 403s — the same gate every content write uses.
      await requireAccess(c, store, 'write', pageId);

      const contentType = c.req.header('Content-Type') ?? '';
      let bytes: Uint8Array;
      let mime: string;
      if (contentType.includes('application/json')) {
        const body = await c.req.json<{data?: string; mime?: string}>().catch(() => ({}) as {data?: string; mime?: string});
        if (typeof body.data !== 'string' || body.data.length === 0) {
          return c.json({error: 'missing or invalid base64 data'}, 400);
        }
        bytes = new Uint8Array(Buffer.from(body.data, 'base64'));
        mime = typeof body.mime === 'string' && body.mime ? body.mime : 'application/octet-stream';
      } else {
        bytes = new Uint8Array(await c.req.arrayBuffer());
        mime = contentType || 'application/octet-stream';
      }
      if (bytes.byteLength === 0) return c.json({error: 'empty asset'}, 400);
      // Enforce the 10 MiB cap on the DECODED bytes: the raw-body limit is sized
      // for base64 overhead, so a genuinely oversize image (or an over-cap base64
      // payload that slipped under the body limit) is caught here, not just by the
      // pre-handler bodyLimit. Same 413 either way.
      if (bytes.byteLength > ASSET_MAX_BYTES) return c.json({error: 'request body too large'}, 413);

      // Stored-XSS defense: the uploader controls `mime` (the upload Content-Type or
      // the JSON `mime` field). Canonicalize it to a safe, allowlisted image type (or
      // `application/octet-stream`) before it's stored, and reject a malformed one
      // (control chars / CR/LF → header-injection / 500) rather than echo it later as
      // a response Content-Type. Only sanitized mimes ever land in the store, so the
      // first-seen-mime dedup can't be poisoned into serving an executable type.
      const safeMime = safeAssetMime(mime);
      if (safeMime === null) return c.json({error: 'invalid content type'}, 400);

      // A6 storage budget: a NEW asset over the instance budget is rejected 507
      // (Insufficient Storage) — never a 5xx crash. A byte-identical re-upload of
      // content already stored is a dedup no-op and never throws.
      let id: string;
      try {
        ({id} = await store.putAsset(bytes, safeMime, {
          maxTotalBytes: ASSET_STORAGE_BUDGET_BYTES > 0 ? ASSET_STORAGE_BUDGET_BYTES : undefined,
        }));
      } catch (err) {
        if (err instanceof AssetBudgetError) return c.json({error: 'asset storage is full'}, 507);
        throw err;
      }
      await store.refAsset(id, pageId);
      logEdit(c, pageId, 'asset.upload', id);
      return c.json({id}, 201);
    },
  );

  // Fetch an asset by content-hash id. READ-GATED: served only to a caller who can
  // read at least one page that references it (the asset inherits its referencing
  // pages' read-gate); otherwise 404 — the SAME answer as a nonexistent asset, so
  // there is no existence oracle and no cross-page/cross-principal leak. The gate
  // (`getAssetFor`) runs FIRST — the immutable cache header is set only on the
  // authorized path, never on the 404. Content-addressed ⇒ the bytes are immutable,
  // so an authorized response is `private` (browser-only, never a shared proxy) +
  // long-lived. `?encoding=base64` returns JSON `{id, mime, size, data}` for the
  // in-webview transports; otherwise the raw binary — served with `nosniff` +
  // `Content-Disposition: attachment` so an uploader-chosen mime can never execute
  // in the app origin (attachment doesn't break `<img src>` / `<a download>`, which
  // fetch the bytes rather than navigate to the URL).
  //
  // ETag / 304 (Assets A5): the id IS the SHA-256 content hash, so `"<id>"` is a
  // perfect STRONG validator (equal id ⇔ equal bytes). It's set on BOTH the raw and
  // base64 responses, and an `If-None-Match` hit short-circuits to a bodyless 304 —
  // saving the full bytes on a cache-miss revalidation, which matters most through a
  // *.book.pub tunnel (the browser caches the first fetch, then revalidates). The
  // read-gate runs FIRST, so the ETag/304 is only ever reachable AFTER authorization
  // — it never becomes a gated-content existence oracle.
  app.get(`${API.assets}/:id`, async (c) => {
    const id = c.req.param('id');
    // A content-hash id is 64 lowercase hex chars; anything else can't name a stored
    // asset, so 404 early (hygiene — also keeps a malformed id out of the DB query).
    if (!/^[0-9a-f]{64}$/.test(id)) return c.json({error: 'asset not found'}, 404);
    const asset = await store.getAssetFor(c.get('principal'), id);
    if (!asset) return c.json({error: 'asset not found'}, 404);

    // Gate passed — safe to set the content-addressed validator + immutable cache
    // header (on the 304, the 200, and the base64 variant alike). These are set
    // AFTER the read-gate so a non-reader gets a plain 404 with neither.
    const etag = `"${id}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, max-age=31536000, immutable');
    if (ifNoneMatchMatches(c.req.header('If-None-Match'), etag)) {
      // Revalidation hit: the client already holds these immutable bytes. Empty body,
      // keep ETag + Cache-Control (RFC 9110 §15.4.5); no Content-Type/-Length/-body.
      return c.body(null, 304);
    }

    if (c.req.query('encoding') === 'base64') {
      return c.json({id, mime: asset.mime, size: asset.size, data: Buffer.from(asset.bytes).toString('base64')});
    }
    c.header('Content-Type', asset.mime);
    c.header('Content-Length', String(asset.size));
    // Defense-in-depth (stored-XSS): never let the browser sniff/execute the bytes,
    // and force a download disposition. The stored mime is already sanitized, so this
    // is belt-and-braces on top of the upload-time allowlist.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', 'attachment');
    // Slice to an exact ArrayBuffer (a Buffer's `.buffer` may be a larger shared pool).
    const ab = asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength);
    return c.body(ab as ArrayBuffer);
  });

  // ── Live collaboration: incremental relay + late-joiner sync (Collab T1) ──────

  // Body caps for the relay endpoints. A single incremental Yjs update — even a
  // coalesced burst or a large paste — is at most a few hundred KB; a state vector
  // is tiny (it scales with the number of clients, not the doc). Cap the raw body
  // so an authed-but-hostile writer can't inflate a relay `Y.Doc` with one giant
  // request between TTL sweeps. Generous-but-bounded; 413 past the cap.
  const RELAY_UPDATE_MAX_BYTES = 1024 * 1024; // 1 MiB per /updates POST
  const RELAY_SYNC_MAX_BYTES = 256 * 1024; //    256 KiB per /sync handshake

  // Incremental Yjs-update ingest. Write-gated like a content save; broadcasts the
  // opaque update to the firehose as a read-gated `yupdate` frame so open editors
  // converge live (between the 600ms snapshot saves, not on them) and folds it into
  // the in-memory relay doc so a late joiner can catch up. Persists NOTHING — the
  // debounced `PUT` snapshot stays the durable checkpoint (OB-164 untouched), so
  // this is a cheap, lossy nudge; not attributed to the edit log. 204 / 400 / 413.
  app.post(
    `${API.pages}/:id/updates`,
    bodyLimit({maxSize: RELAY_UPDATE_MAX_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
      const id = c.req.param('id');
      await requireAccess(c, store, 'write', id);
      const body = await c.req
        .json<{update?: string; clientId?: number}>()
        .catch(() => ({}) as {update?: string; clientId?: number});
      if (typeof body.update !== 'string' || body.update.length === 0) {
        return c.json({error: 'missing or invalid update'}, 400);
      }
      // Explicit per-update bound (the body cap above subsumes it, but pin the
      // intent so a single update can never grow the relay doc unboundedly).
      if (body.update.length > RELAY_UPDATE_MAX_BYTES) {
        return c.json({error: 'update too large'}, 413);
      }
      const clientId = typeof body.clientId === 'number' ? body.clientId : 0;
      const updateBytes = Buffer.from(body.update, 'base64');
      hub.publishPageUpdate(id, body.update, clientId); // live fan-out to connected peers
      // Fold into the relay doc for late-joiner sync (best-effort, off the hot path).
      void relay.ingest(id, updateBytes, loadRelayBase).catch((err) => {
        console.error('OpenBook collab relay ingest failed:', err);
      });
      // Collab T9 (opt-in): fold into the SERVER's canonical doc too, attributing the
      // blocks this update changes to the write-gated principal (its VERIFIED subject,
      // or '' for a guest/unverified writer — never forged). The persister debounce-
      // checkpoints the merged doc, so the durable state converges to the merge, not a
      // stale client's overwrite. Best-effort, off the hot path — a failed fold never
      // fails the /updates fan-out, and the T3 client saver remains the safety net.
      if (persister) {
        void persister
          .ingest(id, updateBytes, verifiedSubject(c.get('principal')))
          .catch((err) => console.error('OpenBook server-persist ingest failed:', err));
      }
      return c.body(null, 204);
    },
  );

  // Late-joiner sync handshake. Read-gated (you may sync a doc you may read). The
  // client sends its state vector; we answer with exactly the ops it's missing,
  // computed from the relay doc (snapshot base + every relayed update since). This
  // is what makes a client that joins mid-session converge to the CURRENT doc —
  // not just future edits. `{update: null}` when there's nothing newer to send.
  app.post(
    `${API.pages}/:id/sync`,
    bodyLimit({maxSize: RELAY_SYNC_MAX_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
      const id = c.req.param('id');
      await requireAccess(c, store, 'read', id);
      const body = await c.req.json<{sv?: string}>().catch(() => ({}) as {sv?: string});
      const sv =
        typeof body.sv === 'string' && body.sv.length > 0 ? Buffer.from(body.sv, 'base64') : new Uint8Array();
      const diff = await relay.sync(id, sv, loadRelayBase);
      const update = diff ? Buffer.from(diff).toString('base64') : null;
      // Collab T9 reconciliation seam (opt-in, additive): when the server is the
      // persistence authority, report how far the durable store is (its last
      // checkpoint's state vector) so a client can confirm its relayed edits landed
      // server-side and stand its own whole-snapshot save down (the T3 handoff). The
      // field is OMITTED entirely when server-persist is off, so the flag-off response
      // is byte-identical to the pre-T9 shape — current clients ignore it either way.
      if (persister) return c.json({update, savedSv: persister.savedStateVector(id)});
      return c.json({update});
    },
  );

  // ── Live collaboration: ephemeral awareness / presence (Collab T4) ────────────

  // An awareness update is tiny — one client's identity + selection, JSON-encoded.
  // Cap the body well below the relay's so a hostile reader can't inflate presence
  // with a giant blob; 413 past it.
  const AWARENESS_MAX_BYTES = 64 * 1024; // 64 KiB per /awareness POST

  // Publish this client's presence. READ-gated (unlike /updates' write gate): a
  // viewer — read but not write — DOES appear present (the T6 "viewers broadcast
  // presence" behaviour), while a non-reader 404s and the page's existence stays
  // hidden. The identity is RE-STAMPED from the verified principal, so the body
  // can't spoof name/colour (only its own selection). Fanned out read-gated +
  // folded into the presence snapshot for late joiners. Persists NOTHING — never a
  // store write, never in the edit log. 204 / 400 / 413.
  app.post(
    `${API.pages}/:id/awareness`,
    bodyLimit({maxSize: AWARENESS_MAX_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
      const id = c.req.param('id');
      await requireAccess(c, store, 'read', id);
      const body = await c.req
        .json<{update?: string; clientId?: number}>()
        .catch(() => ({}) as {update?: string; clientId?: number});
      if (typeof body.update !== 'string' || body.update.length === 0) {
        return c.json({error: 'missing or invalid update'}, 400);
      }
      const clientId = typeof body.clientId === 'number' ? body.clientId : 0;
      // Re-stamp identity from THIS request's verified principal — the only
      // who-you-are the server trusts — and keep ONLY this one client's state, so the
      // body may set a selection, never another user's name or a phantom cursor.
      const {stamped, present} = stampAwarenessIdentity(
        Buffer.from(body.update, 'base64'),
        awarenessUser(c.get('principal')),
        clientId,
      );
      if (stamped.length === 0) return c.json({error: 'missing or invalid update'}, 400);
      const stampedB64 = Buffer.from(stamped).toString('base64');
      hub.publishPageAwareness(id, stampedB64, clientId); // live fan-out (read-gated)
      // Track the snapshot: a still-present state refreshes it, a pure removal drops it.
      if (present) awarenessRelay.ingest(id, clientId, stamped);
      else awarenessRelay.remove(id, clientId);
      return c.body(null, 204);
    },
  );

  // Current presence snapshot for a late joiner (Collab T4). Read-gated like the
  // sync handshake. Returns every present client's already-stamped awareness update
  // so a client connecting mid-session sees who's here immediately, rather than
  // waiting out the next periodic awareness refresh. Empty when nobody else is here.
  app.get(`${API.pages}/:id/awareness`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    return c.json({updates: awarenessRelay.snapshot(id).map((u) => Buffer.from(u).toString('base64'))});
  });

  // The backlink graph: pages whose document links to this one. Read-gated on the
  // target page, and the returned linking pages are filtered to those the caller
  // may read (a restricted page that links here must not leak via a backlink).
  app.get(`${API.pages}/:id/backlinks`, async (c) => {
    await requireAccess(c, store, 'read', c.req.param('id'));
    const backlinks = await store.listBacklinks(c.req.param('id'));
    return c.json(await store.filterReadablePages(c.get('principal'), backlinks));
  });

  // ── Page version history (PVH-3) ───────────────────────────────────────────────
  //
  // Read/restore of the snapshot-on-save history captured in the page upsert (PVH-1).
  // Version access INHERITS the page's capability — the routes gate on the PAGE id
  // with the SAME `requireAccess` default-deny gate every page route uses (read for
  // list/get, write for restore). So a caller who can't read the page 404s (existence
  // hidden), and one who can read but not write can't restore (403). The store's
  // `page_id`-scoped queries also mean a version id from another page never resolves
  // here — no cross-page leak even for a caller who could read both pages.

  // List a page's captured versions (metadata only — no snapshot payload), newest
  // first. `?limit=` caps the page (store clamps 1..1000; default 100). Read-gated.
  app.get(`${API.pages}/:id/versions`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
    return c.json(await store.listPageVersions(id, limit));
  });

  // Read one captured version WITH its snapshot payload (the state to roll back to).
  // Read-gated on the page; 404 when the version id isn't this page's (the store's
  // `AND page_id = $2` guard means a valid id under a DIFFERENT page resolves null —
  // no cross-page leak).
  app.get(`${API.pages}/:id/versions/:vid`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    const version = await store.getPageVersion(id, c.req.param('vid'));
    return version ? c.json(version) : c.json({error: 'version not found'}, 404);
  });

  // Roll the page back to a captured version. Write-gated on the page. Non-destructive
  // by construction: writing the old snapshot back through `upsertPage` captures the
  // CURRENT (pre-restore) state as a fresh version first (PVH-1), so a restore is
  // itself undoable. `captureMode: 'force'` bypasses the 45s coalesce window so that
  // capture ALWAYS happens — a restore landing right after a save would otherwise
  // coalesce the pre-restore state away and silently lose it. The page's name is
  // untouched (name isn't versioned). Mirrors the `PUT /api/pages/:id` publish wiring.
  app.post(`${API.pages}/:id/versions/:vid/restore`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
    const version = await store.getPageVersion(id, c.req.param('vid'));
    if (!version) return c.json({error: 'version not found'}, 404);
    // Preserve the page's current name — only the document content rolls back.
    const existing = await store.getPage(id);
    if (!existing) return c.json({error: 'page not found'}, 404);
    // A restore writes the old snapshot straight through `upsertPage` — an EXTERNAL write
    // that bypasses the /updates collab stream. Any live collab doc for this page still
    // holds the PRE-restore state, so we make the restore's write the LAST durable write the
    // persister allows for the page, then reseed so connected clients converge onto the
    // restored content (PVH-8). Order matters — quiesce BEFORE the write, reseed AFTER it:
    //  • quiesce: freeze new checkpoints, cancel the debounce, and DRAIN any in-flight
    //    checkpoint so a stale pre-restore write lands (or is refused) BEFORE this write —
    //    never behind it on the write mutex, where it would durably clobber the restore.
    //  • upsertPage: the restore write, now the final durable write for the page.
    //  • reseed: drop the canonical doc (next access reseeds from the restored pages.data)
    //    and clear the freeze. Runs in `finally` so a failed write never leaks the freeze.
    await persister?.quiesce(id);
    let page: Awaited<ReturnType<typeof store.upsertPage>>;
    try {
      page = await store.upsertPage({id, name: existing.name, data: version.data}, c.get('principal'), {captureMode: 'force'});
    } finally {
      relay.forget(id); // Collab T1: drop the relay doc so a late-joiner /sync reseeds from the restored snapshot
      persister?.reseed(id); // Collab T9: drop the canonical doc + clear the restore freeze (restore wins; a
      // still-connected client's edits are CRDT deltas that re-merge on its next /sync). Called only here, never
      // from the checkpoint path (saveServerDoc), so the checkpoint can't self-invalidate — no feedback loop.
    }
    hub.publishPage(page);
    await broadcastList();
    if (page.databaseId) await broadcastRows(page.databaseId);
    logEdit(c, page.id, 'page.version.restore', c.req.param('vid'));
    return c.json(page);
  });

  // Reorder / re-nest a page in the sidebar tree: set its parent and the new
  // ordered sibling list under that parent. 404 if the page is gone, 409 if the
  // move would create a cycle (nesting a page under itself or a descendant).
  app.put(`${API.pages}/:id/move`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
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
    await rejectManagedPage(id);
    // Learn the page's database membership before it's gone, so we can refresh
    // the owning database's row list after the delete.
    const existing = await store.getPage(id);
    const deleted = await store.deletePage(id);
    if (!deleted) return c.json({error: 'page not found'}, 404);
    hub.publishDeleted(id);
    relay.forget(id); // free the page's relay doc (Collab T1); reseeds if restored
    persister?.forget(id); // drop the canonical doc WITHOUT persisting (Collab T9) — a
    // checkpoint of a just-deleted page would resurrect it; saveServerDoc also no-ops on it
    awarenessRelay.forget(id); // drop any lingering presence (Collab T4)
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
  // to instance ADMINISTRATION (local-owner / owner / admin) — not the blanket
  // write gate: an acl-write member could otherwise exfiltrate every
  // restricted/members page in one request, and conversely the read-shaped export
  // must never 403 the machine owner just because their account identity lapsed
  // (the post-upgrade "Export failed: you do not have write access" lockout).
  app.get(API.exportLibrary, async (c) => {
    await requireInstanceAdmin(c, store);
    return c.json(await store.exportAll());
  });

  app.post(API.importLibrary, async (c) => {
    // Wholesale overwrite/inject of pages + databases — instance administration
    // only, same gate (and rationale) as the export above.
    await requireInstanceAdmin(c, store);
    const req = await c.req.json<ImportRequest>();
    const result = await store.importBundle(req);
    // ER-6: a deduped re-apply wrote nothing — skip the list re-broadcast and the
    // `space.import` provenance row (a sync/restore daemon re-POSTing its bundle
    // would otherwise grow the edit log unboundedly). Only a real import is logged.
    if (!result.deduped) {
      await broadcastList();
      logEdit(c, null, 'space.import', `${result.created} created, ${result.overwritten} overwritten`);
    }
    return c.json(result);
  });

  // ── Multi-user: instance policy + change provenance (OB-165) ─────────────────

  // The instance's multi-user policy, plus who the server resolved *you* to be
  // on this request (so a client can render "signed in as …" / "guest"). Never
  // leaks private JWKS material — trusted issuers are returned as URLs only.
  app.get(API.instance, async (c) => {
    const config = await store.getInstanceConfig();
    const principal = c.get('principal');
    // The loopback-owner hatch fired: this caller holds machine-owner authority
    // (mirrors authorize()), so a client can offer (or auto-run) an ownership
    // repair when `you` doesn't match `ownerSubject`.
    const localOwner = Boolean(c.get('localOwner'));
    const info: InstanceInfo = {
      guestAccess: config.guestAccess,
      // The instance-wide agent-edits mode (AGED-1) — so a client can render the
      // policy and resolve a page's `inherit` without a second probe.
      agentEdits: config.agentEdits,
      // Stable, opaque per-library id (STAB-5) so an out-of-process MCP connector
      // can confirm it reached THIS library and refuse a foreign responder on the
      // same port. Not a secret — authorizes nothing.
      instanceId: config.instanceId ?? null,
      ownerSubject: config.ownerSubject ?? null,
      trustedIssuers: config.trustedIssuers.map((i) => i.issuer),
      audience: config.audience ?? null,
      requireAudience: config.requireAudience ?? false,
      // What `visibility='inherit'` resolves to at the root once claimed — so a
      // client can show the TRUE effective default behind "Library default"
      // (SHR-6), not just the unclaimed-only guest gate. Never `inherit`.
      defaultVisibility: config.defaultVisibility ?? null,
      you: principal,
      // The hatch grants owner authority regardless of `you`, so it must read as
      // `owner` here too — otherwise a drifted `ownerSubject` sinks the local owner
      // to `viewer` and locks them into read-only chrome the server wouldn't enforce.
      youRole: localOwner ? 'owner' : await store.resolveEffectiveRole(principal, config),
      localOwner,
    };
    return c.json(info);
  });

  // Update the policy (guest gate, trusted issuers, owner). Once an owner is
  // claimed, only the owner may change it; before then (fresh instance) any
  // caller may set policy — matching the desktop single-user reality where the
  // first user claims the library.
  app.put(API.instance, async (c) => {
    const principal = c.get('principal');
    const current = await store.getInstanceConfig();
    const patch = await c.req.json<Partial<InstanceConfig>>();

    // AGED-1: enum-validate the agent-edits mode before any owner/claim path so an
    // unknown value is a 400 (never silently persisted by the shallow merge). Only
    // `suggest` / `direct` are valid at the instance level (`inherit` is page-only).
    if (patch.agentEdits !== undefined && !AGENT_EDITS_MODES.includes(patch.agentEdits)) {
      return c.json({error: 'agentEdits must be "suggest" or "direct"'}, 400);
    }

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

    // Ownership repair (the claim-once escape hatch). A claimed `ownerSubject` is
    // pinned as `iss#sub` at claim time and normally immutable — but issuer/subject
    // drift (an account migration, a re-issued identity) leaves the REAL owner
    // permanently mismatched, with no recovery short of SQL surgery. The machine
    // owner may re-point it, under the narrowest possible rules: only over the
    // trusted local transport (the hatch), only to the caller's OWN verified (jws)
    // subject — never a client-chosen value — and never cleared. A remote caller,
    // however credentialed, cannot re-point ownership.
    // Engages only over the trusted local transport: every other caller falls
    // through to the normal owner gate + the store's un-claim guard (409), so the
    // remote contract is unchanged.
    if (current.ownerSubject && patch.ownerSubject !== undefined && patch.ownerSubject !== current.ownerSubject && c.get('localOwner')) {
      if (principal.verifiedVia !== 'jws' || patch.ownerSubject !== principal.subject) {
        return c.json({error: 'ownership can only be repaired to your own verified identity'}, 403);
      }
      const repaired = await store.repairOwnership(principal.subject);
      const rest: Partial<InstanceConfig> = {...patch};
      delete rest.ownerSubject;
      const next = Object.keys(rest).length > 0 ? await store.updateInstanceConfig(rest) : repaired;
      logEdit(c, null, 'instance.repair', `${current.ownerSubject} -> ${principal.subject}`);
      return c.json(next);
    }

    // Post-claim (or non-claim) policy update: once claimed, only the owner — or
    // the machine owner over the trusted local transport (the loopback hatch), so
    // a missing/stale account identity can't lock the desktop out of its own
    // policy (the "only the instance owner can change multi-user" lockout).
    // AGENT-6 (Sasha HIGH-1 + HIGH-3): the owner match MUST require `verifiedVia ===
    // 'jws'`, not merely a subject match — an owner-minted agent PAT carries the
    // owner's subject but is `verifiedVia:'pat'` and must NEVER change instance
    // policy (guestAccess / issuers / audience / visibility). This is defence in
    // depth: the scope-gate already denies `PUT /api/instance` for any PAT.
    if (
      current.ownerSubject &&
      !c.get('localOwner') &&
      !(principal.verifiedVia === 'jws' && principal.subject === current.ownerSubject)
    ) {
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

  // ── Managed library: roster sync (OB-199; LIB-5 wire rename) ─────────────────
  // Report binding/last-sync status, and run an on-demand reconcile of the bound
  // library roster into the local roster. Instance-writer (owner/admin/loopback)
  // only — same gate as managing the roster directly. The reconcile is the same
  // one the periodic syncer runs; it fails safe (keeps last-good) on a fetch error.
  // Registered on BOTH the new `/api/library/sync` and the legacy
  // `/api/workspace/sync` alias (identical handlers) so a not-yet-updated caller
  // still resolves during the transition; retire the alias in the last phase.

  const rosterStatusHandler = async (c: Context<AppEnv>) => {
    await requireCreate(c, store);
    if (!opts.roster) return c.json({bound: false, available: false}, 200);
    return c.json({available: true, ...(await opts.roster.status())});
  };

  const rosterSyncHandler = async (c: Context<AppEnv>) => {
    await requireCreate(c, store);
    if (!opts.roster) return c.json({error: 'roster sync is not available on this instance'}, 501);
    try {
      const result = await opts.roster.syncNow();
      if (!result) return c.json({error: 'this instance is not bound to a library'}, 409);
      logEdit(c, null, 'library.sync', `+${result.added}/~${result.updated}/-${result.removed}`);
      return c.json(result);
    } catch (err) {
      // Fail-safe: the roster is untouched; surface the upstream failure as a 502.
      return c.json({error: err instanceof Error ? err.message : 'roster sync failed'}, 502);
    }
  };

  app.get(API.librarySync, (c) => rosterStatusHandler(c));
  app.post(API.librarySync, (c) => rosterSyncHandler(c));
  // Legacy alias (LIB-5) — same handlers, kept live through the transition.
  // @deprecated Wire residue — removal target v3.0.0 (see docs/wire-sunset.md).
  // A dev-only (NO telemetry) warning fires when the legacy path is exercised, so the
  // v3.0.0 cutover can be confirmed to have no remaining `/api/workspace/sync` caller.
  const warnLegacyWorkspaceSync = () => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[wire-sunset] a client hit the legacy /api/workspace/sync alias (deprecated, use /api/library/sync; removal v3.0.0)',
      );
    }
  };
  app.get(API.workspaceSync, (c) => {
    warnLegacyWorkspaceSync();
    return rosterStatusHandler(c);
  });
  app.post(API.workspaceSync, (c) => {
    warnLegacyWorkspaceSync();
    return rosterSyncHandler(c);
  });

  app.get(`${API.pages}/:id/acl`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    return c.json(await store.getPageAcl(c.req.param('id')));
  });

  app.post(`${API.pages}/:id/acl`, async (c) => {
    const id = c.req.param('id');
    denyPatPolicy(c);
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
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
    denyPatPolicy(c);
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
    const subject = c.req.query('subject');
    const email = c.req.query('email');
    if (!subject && !email) return c.json({error: 'a subject or email query param is required'}, 400);
    const removed = await store.removePageAcl(id, subject ? {subject} : {email: email as string});
    if (!removed) return c.json({error: 'acl grant not found'}, 404);
    return c.body(null, 204);
  });

  // A page's audience-scope visibility (OB-182 §1.1). Read is gated on reading the
  // page (so a viewer can see "who can see this"); changing it is gated on write
  // of the page — the same "you manage sharing of pages you can write" rule as the
  // ACL. `requireAccess` 404s a page the caller can't even read (hide existence).
  app.get(`${API.pages}/:id/visibility`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    return c.json({visibility: (await store.getPageVisibility(id)) ?? 'inherit'});
  });

  app.put(`${API.pages}/:id/visibility`, async (c) => {
    const id = c.req.param('id');
    denyPatPolicy(c);
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
    const {visibility} = await c.req.json<{visibility?: PageVisibility}>();
    if (!visibility || !PAGE_VISIBILITIES.includes(visibility)) {
      return c.json({error: 'a valid visibility scope is required'}, 400);
    }
    const ok = await store.setPageVisibility(id, visibility);
    if (!ok) return c.json({error: 'page not found'}, 404);
    logEdit(c, id, 'page.visibility', visibility);
    return c.json({visibility});
  });

  // A page's agent-edits policy (AGED-1). Read is gated on reading the page (a viewer
  // may see whether agents edit this page directly). Unlike visibility's write (gated
  // on page-write), the PUT is jws-only via `denyPatPolicy`: an agent PAT must NEVER
  // set the policy that governs whether agents may edit this page directly —
  // self-authorization. `requireAccess` 404s a page the caller can't even read.
  app.get(`${API.pages}/:id/agent-edits`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    return c.json({agentEdits: (await store.getPageAgentEdits(id)) ?? 'inherit'});
  });

  app.put(`${API.pages}/:id/agent-edits`, async (c) => {
    const id = c.req.param('id');
    denyPatPolicy(c);
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
    const {agentEdits} = await c.req.json<{agentEdits?: AgentEditsPolicy}>();
    if (!agentEdits || !AGENT_EDITS_POLICIES.includes(agentEdits)) {
      return c.json({error: 'a valid agent-edits policy is required'}, 400);
    }
    const ok = await store.setPageAgentEdits(id, agentEdits);
    if (!ok) return c.json({error: 'page not found'}, 404);
    logEdit(c, id, 'page.agentEdits', agentEdits);
    return c.json({agentEdits});
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
  // Owner-gated like the policy below: the status leaks the backup folder path,
  // retention, and snapshot counts, so it's not served to viewers/guests.
  app.get(API.backups, async (c) => {
    await requireCreate(c, store);
    if (!opts.backups) return c.json({error: 'scheduled backups are not available on this server'}, 501);
    return c.json(await opts.backups.status());
  });

  // Update the policy (enable, cadences, retention, folder). Owner-gated like the
  // instance policy. The scheduler reads config fresh each tick, so a change
  // takes effect on the next check (or immediately via the run route).
  app.put(API.backups, async (c) => {
    const principal = c.get('principal');
    const instance = await store.getInstanceConfig();
    // AGENT-6 (Sasha HIGH-1 + HIGH-3): require `verifiedVia === 'jws'` for the owner
    // match — an owner-minted PAT carries the owner's subject but must NEVER change
    // backup config (folder, cadences, retention). Defence in depth atop the
    // scope-gate, which already denies `PUT /api/backups` for any PAT.
    if (
      instance.ownerSubject &&
      !(principal.verifiedVia === 'jws' && principal.subject === instance.ownerSubject)
    ) {
      return c.json({error: 'only the instance owner can change backups'}, 403);
    }
    const patch = await c.req.json<Partial<BackupConfig>>();
    await store.updateBackupConfig(patch);
    logEdit(c, null, 'backups.config');
    if (!opts.backups) return c.json({error: 'scheduled backups are not available on this server'}, 501);
    return c.json(await opts.backups.status());
  });

  // Run a snapshot immediately (the "Back up now" action). `{cadence}` selects the
  // tier (default daily); 409 when no backup directory is configured. Owner-gated
  // (like the policy routes) so a non-owner can't trigger snapshot work — no
  // unauthorized DoS.
  app.post(API.backupRun, async (c) => {
    await requireCreate(c, store);
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

  // The server-managed AI usage database (C1) is read-only over the API: reject
  // end-user create-row / update-row / patch / delete / reorder against it. Called
  // AFTER the access gate, so a non-reader still gets an existence-hiding 404 and
  // only someone who could otherwise write sees the managed 403. The server's own
  // attribution writes go straight through the store, bypassing these routes.
  const rejectManaged = (databaseId: string): void => {
    if (opts.aiUsage?.isManagedDatabase(databaseId)) {
      throw new HTTPException(403, {message: 'this database is server-managed and cannot be edited via the API'});
    }
  };

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
    rejectManaged(c.req.param('id'));
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
    rejectManaged(id);
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
    rejectManaged(id);
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
    rejectManaged(id);
    const {orderedIds} = await c.req.json<{orderedIds: string[]}>();
    await store.reorderRows(id, orderedIds ?? []);
    await broadcastRows(id);
    return c.json({ok: true});
  });

  app.patch(`${API.databases}/:id/rows/:rowId`, async (c) => {
    const id = c.req.param('id');
    // A row is a page; gate write on the row itself (it may carry its own ACL).
    await requireAccess(c, store, 'write', c.req.param('rowId'));
    rejectManaged(id);
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
    // Page names are not unique (migration 0015), so a unique violation here is
    // another constraint (e.g. a member email index) — surface it as a conflict.
    if (isUniqueViolation(err)) {
      return c.json({error: 'a conflicting record already exists'}, 409);
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
  return typeof e.message === 'string' && /duplicate key|unique constraint/i.test(e.message);
}
