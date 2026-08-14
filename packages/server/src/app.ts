import {createHash, randomUUID} from 'node:crypto';
import {Hono, type Context} from 'hono';
import {cors} from 'hono/cors';
import {bodyLimit} from 'hono/body-limit';
import {HTTPException} from 'hono/http-exception';
import {streamSSE} from 'hono/streaming';
import type {StatusCode} from 'hono/utils/http-status';
import {
  API,
  AGENT_EDITS_MODES,
  AGENT_EDITS_POLICIES,
  ASSET_IMAGE_MIMES,
  CLIENT_HEADER,
  FORWARDED_HEADER,
  FORM_SUBMISSION_PROPERTY_ID,
  FORM_UPLOAD_MAX_FILE_BYTES,
  FORM_UPLOAD_MAX_FILES,
  FORM_UPLOAD_MAX_FORM_BYTES,
  FORM_UPLOAD_MAX_FORM_STAGED_BYTES,
  FORM_UPLOAD_ORPHAN_TTL_MS,
  formPatternIsUnsafe,
  isFormWritablePropertyType,
  generateSubmissionKey,
  projectDatabaseFormDescriptor,
  safeFormRedirectUrl,
  submissionToRowInput,
  validateRowAgainstForm,
  validateSubmission,
  PAGE_VISIBILITIES,
  TITLE_PROPERTY_ID,
  type AclLevel,
  type AgentEditsPolicy,
  type BackupCadence,
  type BackupConfig,
  type CommentInput,
  type DatabaseInput,
  type DatabaseFormSubmissionMarker,
  type DatabaseSchema,
  type DatabaseUpdate,
  type FormSubmissionResult,
  type FormSchema,
  type FormUploadResult,
  type ImportRequest,
  type InstanceConfig,
  type InstanceInfo,
  type MemberRole,
  type MemberStatus,
  type PageInput,
  type PageVisibility,
  type PageVisibilityUpdate,
  type Principal,
  type RowInput,
  type SuggestionInput,
  type SuggestionStatus,
  type SuggestionUpdate,
  type WriteConflictEnvelope,
  type WriteErrorEnvelope,
  type WriteServerErrorCode,
  LEDGER_RECONCILIATION_STATUSES,
  LedgerError,
  MoneyError,
  ledgerErrorStatus,
  type LedgerAccountInput,
  type LedgerAccountPatch,
  type LedgerClearedState,
  type LedgerDraftInput,
  type LedgerDraftPatch,
  type LedgerExportSection,
  type LedgerPeriodCloseInput,
  type LedgerReconciliationInput,
  type LedgerReconciliationPatch,
  type LedgerReconciliationStatus,
  type LedgerReverseOptions,
  type LedgerTransactionState,
  localPrincipal,
} from '@book.dev/sdk';
import {
  PageStore,
  AssetBudgetError,
  BackupFormatError,
  DatabaseFormAccessLostError,
  DatabaseFormResponseLimitError,
  FormAssetBudgetError,
  IdempotencyKeyReuseError,
  type IdempotencyOutcome,
  type IdempotencyRequest,
  type IdempotencyResponse,
} from './store';
import {PageHub} from './hub';
import {CollabRelay} from './collab';
import {ServerAuthoritativePersister} from './collabPersist';
import {AwarenessRelay, awarenessUser, stampAwarenessIdentity} from './collabAwareness';
import {mountAiRoutes} from './ai/routes';
import {mountPluginRoutes} from './pluginRoutes';
import {guestGate, isLocalOwnerRequest, recoverAudienceLockedPrincipal, resolvePrincipal, type IdentityProvider} from './principal';
import {isAuthenticatedPrincipal, isRealInstanceOwner, requireAccess, requireCreate, requireDbAccess, requireInstanceAdmin, streamGates} from './access';
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
import {agentMayEditDirectly, authoredSubject, resolveAgentEditsForPage} from './agentWriteGate';
import {mountUi} from './ui';
import {hostAllowlistGuard} from './hostGuard';
import {InviteResolutionError, resolveInvitee, type HandleResolver} from './invites';
import type {BackupController} from './backups';
import type {RosterController} from './rosterSync';
import type {AppEnv} from './appEnv';
import type {AiService} from './ai/service';
import type {McpClientManager} from './ai/mcpClients';
import type {AiUsageLog} from './ai/usage';
import {
  FORM_SUBMISSION_MAX_BODY_BYTES,
  FORM_REQUEST_RATE_LIMIT,
  FORM_REQUEST_RATE_WINDOW_MS,
  FORM_SHARED_RATE_LIMIT,
  FORM_UPLOAD_MAX_BODY_BYTES,
  currentDatabaseFormView,
  databaseFormCapability,
  databaseFormResponseCap,
  databaseFormUploadId,
  formSubmissionKey,
  hashDatabaseFormCapability,
  isDatabaseFormFilesField,
  isFormFilesField,
  requireDatabaseFormSubmissionAccess,
  requireFormUploadAccess,
  requireFormSubmissionAccess,
  validateDatabaseFormDescriptorRequest,
  validateDatabaseFormSubmissionRequest,
  validateDatabaseFormUploadRequest,
  validateFormUploadRequest,
  validateFormSubmissionRequest,
} from './formAccess';

/** Server-side name for the shared durable-write error response contract. */
export type ServerWriteErrorEnvelope<Code extends string = WriteServerErrorCode> = WriteErrorEnvelope<Code>;

/** Server-side name for the shared discriminated HTTP 409 CAS response contract. */
export type ServerWriteConflictEnvelope = WriteConflictEnvelope;

const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const JSON_CONTENT_TYPE = 'application/json; charset=UTF-8';
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class InvalidIdempotencyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdempotencyInputError';
  }
}

/** Exact method/path allowlist from write-contract §4.1. */
const IDEMPOTENCY_ROUTE_PARAM = '__openbook_idempotency_route_param__';
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idempotencyRoutePattern = (path: string): RegExp => new RegExp(
  `^${path.split(IDEMPOTENCY_ROUTE_PARAM).map(escapeRegex).join('[^/]+')}$`,
);
const WAVE_ONE_IDEMPOTENCY_ROUTES: ReadonlyArray<{
  methods: readonly string[];
  pattern: RegExp;
}> = [
  {methods: ['POST'], pattern: idempotencyRoutePattern(API.pages)},
  {methods: ['PUT', 'PATCH', 'DELETE'], pattern: idempotencyRoutePattern(API.page(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['PATCH'], pattern: idempotencyRoutePattern(API.pageProperties(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['PUT'], pattern: idempotencyRoutePattern(API.pageMove(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['POST'], pattern: idempotencyRoutePattern(API.pageRestore(IDEMPOTENCY_ROUTE_PARAM))},
  {
    methods: ['POST'],
    pattern: idempotencyRoutePattern(API.pageVersionRestore(
      IDEMPOTENCY_ROUTE_PARAM,
      IDEMPOTENCY_ROUTE_PARAM,
    )),
  },
  {methods: ['PUT'], pattern: idempotencyRoutePattern(API.pageVisibility(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['PUT'], pattern: idempotencyRoutePattern(API.pageAgentEdits(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['POST'], pattern: idempotencyRoutePattern(API.databases)},
  {methods: ['PATCH', 'DELETE'], pattern: idempotencyRoutePattern(API.database(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['POST'], pattern: idempotencyRoutePattern(API.databaseRows(IDEMPOTENCY_ROUTE_PARAM))},
  {methods: ['PUT'], pattern: idempotencyRoutePattern(API.databaseRowsOrder(IDEMPOTENCY_ROUTE_PARAM))},
  {
    methods: ['PATCH'],
    pattern: idempotencyRoutePattern(API.databaseRow(IDEMPOTENCY_ROUTE_PARAM, IDEMPOTENCY_ROUTE_PARAM)),
  },
  {methods: ['PUT'], pattern: idempotencyRoutePattern(API.instance)},
];

function isWaveOneIdempotencyRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return WAVE_ONE_IDEMPOTENCY_ROUTES.some(({methods, pattern}) =>
    methods.includes(upper) && pattern.test(path),
  );
}

function idempotencyActorScope(principal: Principal): string {
  if (principal.verifiedVia === 'jws' || principal.verifiedVia === 'pat' || principal.verifiedVia === 'local') {
    return principal.subject;
  }
  return `guest:${principal.subject.replace(/^guest:/, '')}`;
}

/** SHA-256 over four-byte-big-endian-length-prefixed tuple members (§4.2). */
function idempotencyFingerprint(
  method: string,
  normalizedPath: string,
  mediaType: string,
  body: Uint8Array,
): string {
  const hash = createHash('sha256');
  for (const part of [
    Buffer.from(method),
    Buffer.from(normalizedPath),
    Buffer.from(mediaType),
    Buffer.from(body),
  ]) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.byteLength);
    hash.update(length);
    hash.update(part);
  }
  return hash.digest('hex');
}

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
 * The set of browser origins that are the APP ITSELF (STAB-8). The sidecar serves the
 * library over loopback while any TCP listener is bound (LAN publish, `pnpm dev`
 * :4319, the STAB-5 MCP-loopback toggle, and unconditionally on Windows where a Unix
 * socket isn't available), so — before this gate — a wildcard `cors()` let ANY web
 * page the browser visited read the response of a cross-origin request to it. We now
 * reflect `Access-Control-Allow-Origin` ONLY for the app's own webview / dev origins;
 * every foreign origin gets no ACAO, so the browser refuses to expose the response
 * cross-origin. Requests with NO `Origin` header (same-origin browser fetches, curl,
 * the desktop IPC transport, the MCP connector, the forwarded-tunnel local hop) are
 * not CORS-relevant and are untouched — `cors()` sets nothing for them.
 *
 *  - `tauri://localhost` — the desktop WKWebView origin (macOS / Linux).
 *  - `http(s)://tauri.localhost` — the Windows WebView2 origin.
 *  - `http(s)://localhost[:port]`, `http(s)://127.0.0.1[:port]`, `http(s)://[::1][:port]`
 *    — the web dev server (`pnpm dev` on :3000) reaching the data server on :4319, and
 *    the STAB-7 same-origin served UI. Loopback hosts only; a real LAN IP is never
 *    reflected, so a published instance stays browser-unreadable from a foreign page.
 */
const APP_ORIGIN_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const FORM_PUBLIC_WRITE_PATH = /^\/api\/pages\/[^/]+\/forms\/[^/]+\/(?:submissions|uploads)$/;
const DATABASE_FORM_PUBLIC_PATH = /^\/api\/databases\/[^/]+\/views\/[^/]+\/(?:form|submissions|uploads)$/;
const isDatabaseFormPublicRequest = (method: string, path: string): boolean => {
  return method === 'POST' && DATABASE_FORM_PUBLIC_PATH.test(path);
};
export function isAppOrigin(origin: string): boolean {
  if (!origin) return false;
  // Scheme and host are case-insensitive (RFC 3986 §3.1/§6.2.2.1), so a browser MAY send
  // `TAURI://localhost` / `HTTP://LocalHost:3000` (STAB-8 LOW nit). An origin carries no
  // path/query/userinfo, so lowercasing the whole string is a safe canonicalization.
  const o = origin.toLowerCase();
  if (o === 'tauri://localhost') return true;
  if (o === 'http://tauri.localhost' || o === 'https://tauri.localhost') return true;
  return APP_ORIGIN_LOOPBACK.test(o);
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
    throw new HTTPException(403, {
      message: 'agent tokens cannot change page sharing, visibility, public form capabilities, or agent-edits policy',
    });
  }
}

// The served-asset image-mime allowlist (`ASSET_IMAGE_MIMES`) is single-sourced
// in the sdk since LGR-15: the backup-restore door (`store.ts`) sanitizes
// bundle-carried asset mimes against the SAME list, and an allowlist that
// exists twice will eventually disagree. `image/svg+xml` stays excluded there
// for the same stored-XSS reason documented on the sdk constant.

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

/** Strict base64 decoder for the public form-upload envelope. */
function decodeFormUploadBase64(raw: string): Uint8Array | null {
  if (raw.length % 4 !== 0) return null;
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  for (let i = 0; i < raw.length - padding; i += 1) {
    const code = raw.charCodeAt(i);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return null;
  }
  const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
  return Buffer.from(bytes).toString('base64') === raw ? bytes : null;
}

function formFileEntries(
  schema: FormSchema,
  values: Record<string, unknown>,
): Array<{fieldId: string; tokens: string[]}> {
  const entries: Array<{fieldId: string; tokens: string[]}> = [];
  for (const field of schema.fields) {
    if (field.kind !== 'files') continue;
    const value = values[field.id];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      entries.push({fieldId: field.id, tokens: value as string[]});
    }
  }
  return entries;
}

function databaseFormFileEntries(
  schema: DatabaseSchema,
  fields: Record<string, unknown>,
): Array<{fieldId: string; tokens: string[]}> {
  const entries: Array<{fieldId: string; tokens: string[]}> = [];
  for (const property of schema.properties) {
    if (property.type !== 'files') continue;
    const value = fields[property.id];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      entries.push({fieldId: property.id, tokens: value as string[]});
    }
  }
  return entries;
}

/** Synthetic attribution for exactly one public row create. It is deliberately
 * non-verified, so snapshot authorship stays empty rather than faking a person. */
function databaseFormPrincipal(viewId: string): Principal {
  return {
    kind: 'guest',
    subject: `form:${viewId}`,
    issuer: '',
    name: 'Public form',
    verifiedVia: 'guest',
  };
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
   * routes expose the owner-only `/api/ai/mcp` surface and the agent run merges
   * its namespaced `mcp__*` tools (for writer-gated principals, with stdio further
   * restricted to trusted local-owner requests). Owned by the caller
   * (`startServer`); omitted in tests / the in-webview store, where external tools
   * are simply unavailable.
   */
  mcp?: McpClientManager;
  /**
   * STAB-7 (LAN-hosted web UI): absolute path to a pre-built, client-only
   * OpenBook web bundle (an `index.html` + hashed assets). When set, the sidecar
   * also serves that UI from a `GET *` catch-all (see {@link mountUi}) so a LAN
   * browser can open `http://<host>:<port>/` directly. Registered LAST, after
   * every API/SSE/plugin route, so it never shadows `/api/*`. Unset (the default)
   * ⇒ the sidecar serves only the API and a UI request 404s, exactly as before.
   * The desktop wires this to its publish/LAN toggle (serve the UI only while
   * sharing is on); a headless run can set it from `--ui-dir`.
   */
  uiDir?: string;
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
  // STAB-7 invariant: serving the LAN web UI and the shared-secret gate are
  // MUTUALLY EXCLUSIVE. The `accessToken` gate runs before `guestAccess` and would
  // 401 every `/api` call the served (tokenless) shell makes — the shipped-empty-
  // shell bug. Fail closed at construction so that state can never boot: a LAN
  // publish is tokenless (guest-gated); a token-gated bind must not also serve a UI.
  if (opts.uiDir && opts.accessToken) {
    throw new Error(
      'createApp: `uiDir` and `accessToken` are mutually exclusive — the served LAN web UI is ' +
        'tokenless (guest-gated), and a shared-secret gate would 401 every /api call the shell ' +
        'makes, leaving an empty page. Drop one (STAB-7).',
    );
  }

  const app = new Hono<AppEnv>();

  const durableWriteRequest = (c: Context<AppEnv>): IdempotencyRequest | null => {
    if (!c.req.raw.headers.has(IDEMPOTENCY_HEADER)) return null;
    const rawKey = c.req.raw.headers.get(IDEMPOTENCY_HEADER) ?? '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
      throw new InvalidIdempotencyInputError(
        'Idempotency-Key must be a canonical UUID v4 or v7',
      );
    }
    const url = new URL(c.req.url);
    if (url.search !== '') {
      throw new InvalidIdempotencyInputError(
        'idempotent write routes do not accept query parameters',
      );
    }
    const body = c.get('idempotencyBody');
    if (!body) throw new Error('idempotent request body was not captured');
    const method = c.req.method.toUpperCase();
    const mediaType = (c.req.header('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
    return {
      actorScope: idempotencyActorScope(c.get('principal')),
      key: rawKey.toLowerCase(),
      fingerprint: idempotencyFingerprint(method, url.pathname, mediaType, body),
      method,
      normalizedTarget: url.pathname,
    };
  };

  const executeDurableWriteBase = async <R extends IdempotencyResponse>(
    c: Context<AppEnv>,
    execute: (activeStore: PageStore) => Promise<R>,
  ): Promise<IdempotencyOutcome<R['body']>> => {
    const normalizeResponse = async (activeStore: PageStore): Promise<IdempotencyResponse<R['body']>> => {
      const response = await execute(activeStore);
      return {
        ...response,
        headers: {
          ...(response.status === 204 ? {} : {contentType: JSON_CONTENT_TYPE}),
          ...response.headers,
        },
      };
    };
    const request = durableWriteRequest(c);
    if (!request) {
      return {...await normalizeResponse(store), replayed: false};
    }
    return store.idempotentWrite(request, normalizeResponse);
  };
  const executeDurableWrite = Object.assign(executeDurableWriteBase, {
    probe: async <T = unknown>(c: Context<AppEnv>): Promise<IdempotencyOutcome<T> | null> => {
      const request = durableWriteRequest(c);
      return request ? store.probeIdempotentWrite<T>(request) : null;
    },
  });

  const durableWriteResponse = <T>(c: Context<AppEnv>, response: IdempotencyOutcome<T>): Response => {
    const headers: Record<string, string> = {};
    if (response.headers?.contentType) headers['Content-Type'] = response.headers.contentType;
    if (response.headers?.location) headers.Location = response.headers.location;
    return c.newResponse(
      response.status === 204 ? null : response.serializedBody ?? JSON.stringify(response.body),
      response.status as StatusCode,
      headers,
    );
  };

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
  // FORM-6: uploads and submissions share a per-socket-peer/form budget. The
  // client-settable forwarded marker never selects the bucket. Adapters without a
  // trustworthy socket peer use a much larger shared floor sized for honest tunnel
  // concurrency, rather than collapsing all public traffic into the 30-request cap.
  const formRequestLimiter = new FixedWindowLimiter(FORM_REQUEST_RATE_LIMIT, FORM_REQUEST_RATE_WINDOW_MS);
  const formSharedLimiter = new FixedWindowLimiter(FORM_SHARED_RATE_LIMIT, FORM_REQUEST_RATE_WINDOW_MS);
  // F-4 has two independent abuse ceilings: one shared by every holder of a
  // capability and one shared by every public-form request from a socket peer.
  // Keys use the stored digest / trusted peer address, never the raw capability or
  // spoofable forwarding headers. Like legacy forms, adapters without a trustworthy
  // peer use the larger shared floor and isolate that floor per database form.
  const databaseFormCapabilityLimiter = new FixedWindowLimiter(
    FORM_REQUEST_RATE_LIMIT,
    FORM_REQUEST_RATE_WINDOW_MS,
  );
  const databaseFormIpLimiter = new FixedWindowLimiter(
    FORM_REQUEST_RATE_LIMIT,
    FORM_REQUEST_RATE_WINDOW_MS,
  );
  const formRateBucket = (c: Context<AppEnv>, pageId: string, formId: string) => {
    const peer = clientIpKey(c);
    return peer === 'peer'
      ? {limiter: formSharedLimiter, key: `form:${pageId}:${formId}`}
      : {limiter: formRequestLimiter, key: `ip:${peer}:form:${pageId}:${formId}`};
  };
  const formRateLimited = (c: Context<AppEnv>, pageId: string, formId: string): boolean => {
    const {limiter, key} = formRateBucket(c, pageId, formId);
    if (!limiter.exceeded(key)) return false;
    c.header('Retry-After', String(Math.ceil(FORM_REQUEST_RATE_WINDOW_MS / 1000)));
    return true;
  };
  const databaseFormRateBucket = (c: Context<AppEnv>, databaseId: string, viewId: string) => {
    const peer = clientIpKey(c);
    return peer === 'peer'
      ? {limiter: formSharedLimiter, key: `db-form:${databaseId}:${viewId}`}
      : {limiter: databaseFormIpLimiter, key: `ip:${peer}:db-form:${databaseId}:${viewId}`};
  };
  const databaseFormPeerRateLimited = (
    c: Context<AppEnv>,
    databaseId: string,
    viewId: string,
    record: boolean,
  ): boolean => {
    const {limiter, key} = databaseFormRateBucket(c, databaseId, viewId);
    const over = record ? limiter.exceeded(key) : limiter.peek(key);
    if (over) c.header('Retry-After', String(Math.ceil(FORM_REQUEST_RATE_WINDOW_MS / 1000)));
    return over;
  };
  const databaseFormRateLimited = (
    c: Context<AppEnv>,
    databaseId: string,
    viewId: string,
    capabilityHash: string,
  ): boolean => {
    const capabilityExceeded = databaseFormCapabilityLimiter.exceeded(`capability:${capabilityHash}`);
    const peerExceeded = databaseFormPeerRateLimited(c, databaseId, viewId, true);
    if (!capabilityExceeded && !peerExceeded) return false;
    c.header('Retry-After', String(Math.ceil(FORM_REQUEST_RATE_WINDOW_MS / 1000)));
    return true;
  };
  const requireMeteredDatabaseFormAccess = async (
    c: Context<AppEnv>,
    databaseId: string,
    viewId: string,
    capability: string,
  ) => {
    try {
      return await requireDatabaseFormSubmissionAccess(store, databaseId, viewId, capability);
    } catch (err) {
      // Mirror the failed-PAT limiter: only a failed hidden-state/capability gate
      // records a pre-auth hit. Once the bucket is over budget, the failing request
      // and subsequent requests are shed with 429 before another database lookup.
      if (
        err instanceof HTTPException
        && err.status === 404
        && databaseFormPeerRateLimited(c, databaseId, viewId, true)
      ) {
        throw new HTTPException(429, {message: 'rate limit exceeded'});
      }
      throw err;
    }
  };
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
  const persister = opts.serverPersist
    ? new ServerAuthoritativePersister({
      loadBase: loadRelayBase,
      saveDoc: (id, blockdoc, authorsByBlock) => store.saveServerDoc(id, blockdoc, authorsByBlock),
      onPersisted: (page) => {
        hub.publishPage(page); // → live peers + OB-241 disk mirror (server.ts subscription)
        void broadcastList();
        if (page.databaseId) void broadcastRows(page.databaseId);
      },
    })
    : null;
  // One boundary for client-originated route-level whole-snapshot writes. The persister
  // owns quiesce→write→merge (including same-page writer serialization), while the store's
  // internal `saveServerDoc` checkpoint bypasses it — no feedback loop. A stale PUT/POST
  // is therefore only a transient durable replacement: its blockdoc update is folded into
  // the retained canonical doc and the next checkpoint writes the CRDT union back.
  //
  // Coverage assumption (F3): localClient.ts calls store.upsertPage directly, but that
  // in-webview transport does not construct a persister today. If it gains one, its save
  // and restore methods must cross this same intent-discriminating boundary.
  const upsertSnapshotPage = (
    activeStore: PageStore,
    ...args: Parameters<PageStore['upsertPage']>
  ): ReturnType<PageStore['upsertPage']> => {
    const [input, author, upsertOpts] = args;
    const write = () => activeStore.upsertPage(input, author, upsertOpts);
    if (persister && input.id) {
      const rawUpdate = (input.data?.blockdoc as {update?: unknown} | undefined)?.update;
      const snapshotUpdate = typeof rawUpdate === 'string' && rawUpdate.length > 0
        ? new Uint8Array(Buffer.from(rawUpdate, 'base64'))
        : null;
      return persister.withSnapshotWriteFence(input.id, write, {
        intent: 'merge',
        snapshotUpdate,
        subject: authoredSubject(author),
      });
    }
    return write();
  };
  // Expose the persister so the host (server.ts) can flush every dirty canonical doc
  // on shutdown BEFORE the store closes — the no-lost-edit-on-shutdown guarantee.
  (app as AppWithCollab).collabPersist = persister;

  // DNS-rebinding guard (STAB-10). MUST run first, ahead of CORS and the served UI, so a
  // rebound foreign `Host` on a loopback/LAN TCP bind is refused before any handler sees it
  // (closes the STAB-8 same-origin-via-rebinding bypass). Inert off the TCP transport (UDS /
  // in-webview / `app.request`), so it never touches the desktop IPC path — see hostGuard.ts.
  app.use('*', hostAllowlistGuard());

  // App-origin CORS allowlist (STAB-8, replaces the old wildcard `cors()`). Reflect
  // ACAO only for the app's own origins (see {@link isAppOrigin}); a foreign origin
  // gets no ACAO (its response is unreadable cross-origin) and, on a preflight, no
  // allowed methods/headers either. `allowHeaders` enumerates every header a
  // first-party client sends so the app's OWN cross-origin preflight (dev :3000 → the
  // data server, or the STAB-7 served UI) succeeds — including `X-OpenBook-Client`,
  // the marker the guest-write gate below requires.
  app.use(
    '*',
    cors({
      origin: (origin) => (isAppOrigin(origin) ? origin : null),
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-OpenBook-Identity',
        'X-OpenBook-Guest-Name',
        'X-OpenBook-Local',
        CLIENT_HEADER,
        IDEMPOTENCY_HEADER,
      ],
    }),
  );

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
      // F-4 public database forms are authenticated only by their per-view fill
      // capability (or publication binding for the descriptor), never by the
      // instance-wide LAN bearer. Keeping them outside this broad gate is what
      // makes a published fill link usable by anyone who holds it.
      if (isDatabaseFormPublicRequest(c.req.method, c.req.path)) return next();
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
      // A form capability is a narrow exception to the ordinary guest MUTATION
      // floor: `guestAccess:'read'` may submit to a readable public page. Let the
      // form gate reuse the page READ decision itself, including the stricter
      // `guestAccess:'off'` floor, so every form denial has one oracle-safe body.
      // The separate X-OpenBook-Client CSRF middleware below still applies.
      const isFormPublicWrite = c.req.method === 'POST' && FORM_PUBLIC_WRITE_PATH.test(c.req.path);
      const isPublicDatabaseForm = isDatabaseFormPublicRequest(c.req.method, c.req.path);
      const gate = isFormPublicWrite || isPublicDatabaseForm
        ? null
        : guestGate(principal, guestAccess, c.req.method);
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

  // Guest-write origin hardening (STAB-8). Runs AFTER principal resolution above, so
  // `c.principal` is always set, and independently of whether an identity provider is
  // configured — so it closes the default `guestAccess:'write'` cross-origin write on
  // a legacy instance too.
  //
  // A `guest` is the ONLY principal a browser can reach by a CORS SIMPLE request:
  // every credentialed principal already rides a non-simple header of its own
  // (`X-OpenBook-Identity` JWS and `Authorization: Bearer` PAT resolve to a NON-guest
  // kind; `X-OpenBook-Local` owner secret re-maps to the local principal — OpenBook
  // auth is header-based, never cookie-based, so an authenticated request is
  // inherently non-simple and cannot be forged cross-origin as a plain form/`fetch`).
  // So an UNAUTHENTICATED mutating request must carry the first-party
  // `X-OpenBook-Client` header, which a cross-origin simple request cannot attach
  // without a preflight the app-origin allowlist denies for a foreign origin.
  // (Requiring it unconditionally — not only when a foreign `Origin` is present — also
  // closes the `Origin: null` / origin-stripped-by-a-privacy-extension edge.)
  //
  // An `Authorization` header ALSO exempts: the legacy instance `accessToken` (a LAN
  // reachability shared secret) authenticates a request but leaves its principal
  // `guest`, yet `Authorization` is itself a forbidden/non-simple header a foreign
  // simple request can never set — so a bearer-authed API write (curl / a headless
  // integration that isn't the sdk) is provably not a browser forgery and stays
  // reachable without the client marker.
  //
  // Reads are never gated: a foreign page can't read the cross-origin response
  // regardless (no ACAO), and `EventSource` can't set headers, so `/api/live` SSE
  // stays reachable. Every first-party transport sends the header via the sdk
  // `HttpDataClient`; the forwarding tunnel relays it verbatim (it is not in the
  // tunnel's strip-list).
  app.use('/api/*', async (c, next) => {
    const method = c.req.method;
    const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const nonSimpleAuth = c.req.header(CLIENT_HEADER) || c.req.header('Authorization');
    if (mutating && c.get('principal')?.kind === 'guest' && !nonSimpleAuth) {
      return c.json(
        {error: 'this write must originate from an OpenBook client (missing X-OpenBook-Client header)'},
        403,
      );
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

  // Authentication, forwarding, principal, guest-write, and PAT-scope gates are
  // all header-only and have already passed. Validate the key before cloning, then
  // capture exact bytes before any route body limit or JSON parser consumes them.
  app.use('/api/*', async (c, next) => {
    if (
      c.req.raw.headers.has(IDEMPOTENCY_HEADER)
      && isWaveOneIdempotencyRoute(c.req.method, c.req.path)
    ) {
      const rawKey = c.req.raw.headers.get(IDEMPOTENCY_HEADER) ?? '';
      if (!IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
        throw new InvalidIdempotencyInputError(
          'Idempotency-Key must be a canonical UUID v4 or v7',
        );
      }
      c.set('idempotencyBody', new Uint8Array(await c.req.raw.clone().arrayBuffer()));
    }
    await next();
  });

  // Reads ignore the header. Mutations outside the contract's wave-1 table reject
  // it after the broad authentication/guest/PAT gates, before any route mutation.
  app.use('/api/*', async (c, next) => {
    const mutating = c.req.method === 'POST'
      || c.req.method === 'PUT'
      || c.req.method === 'PATCH'
      || c.req.method === 'DELETE';
    if (
      mutating
      && c.req.raw.headers.has(IDEMPOTENCY_HEADER)
      && !isWaveOneIdempotencyRoute(c.req.method, c.req.path)
    ) {
      const error: ServerWriteErrorEnvelope<'invalid-input'> = {
        error: 'Idempotency-Key is not supported on this mutation route',
        code: 'invalid-input',
        retryable: false,
      };
      return c.json(error, 400);
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

  // AGED-2 agent-PAT write gate. Server-side teeth for the agent-edits policy: an
  // agent PAT (`verifiedVia === 'pat'`) may write a page's CONTENT directly only when
  // the resolved mode for that page is exactly `'direct'` (the fail-safe lives in
  // `agentMayEditDirectly` — any non-`direct` value denies). Otherwise it 403s with an
  // actionable steer the MCP client surfaces verbatim to the agent, pointing at the
  // suggestion route (which stays PAT-writable in BOTH modes). NEVER gates a jws /
  // guest / local / bearer principal — human and loopback-owner writes are untouched
  // (this returns immediately for any non-PAT). Call AFTER the access gate so a PAT
  // that can't even write the page still gets the access 404/403 first (no extra
  // existence oracle), and only a would-be direct writer on a suggest-mode page sees
  // this 403. Creating a NEW page/row is out of scope: there is no prior page policy
  // and no suggestion target for content that does not yet exist — those stay governed
  // by the write-PAT scope-gate alone.
  const requireAgentDirectWrite = async (c: Context<AppEnv>, pageId: string): Promise<void> => {
    if (c.get('principal').verifiedVia !== 'pat') return;
    if (await agentMayEditDirectly(store, pageId)) return;
    throw new HTTPException(403, {
      message: `Direct edits are disabled for this page; submit a suggestion via POST /api/pages/${pageId}/suggestions`,
    });
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
      // An upsert ONTO an existing page is a direct content edit — gate an agent PAT
      // on that page's resolved agent-edits mode (the create branch below is exempt:
      // a not-yet-existing page has no policy and no suggestion target).
      await requireAgentDirectWrite(c, input.id);
    } else {
      await requireCreate(c, store);
    }
    // A POST carrying a managed usage page's id is an upsert onto it (ON CONFLICT →
    // name+data overwrite), so gate it like the other page routes. Placed after the
    // access gate: a would-be mutator (reader, or a create-capable guest whose upsert
    // would otherwise clobber the managed host/row) sees the managed 403; a normal
    // create/update is untouched (isManagedPage is false for any other id).
    if (input.id) await rejectManagedPage(input.id);
    const headerKey = c.req.raw.headers.get(IDEMPOTENCY_HEADER);
    if (
      headerKey !== null
      && input.idempotencyKey !== undefined
      && input.idempotencyKey !== headerKey
    ) {
      throw new InvalidIdempotencyInputError(
        'header and body idempotency keys must be byte-for-byte equal',
      );
    }
    // ER-7: a keyless create carrying an `input.idempotencyKey` is deduped
    // per-principal inside `upsertPage` — a retried/replayed POST returns the page
    // the first call minted instead of a duplicate. The key is scoped to this
    // request's resolved principal, so it can never dedupe against another user's
    // write. (The SDK also pre-mints the page id for keyless creates, so a replay
    // hits the store's `ON CONFLICT` no-op even without a key.)
    const response = await executeDurableWrite(c, async (activeStore) => ({
      status: 201,
      body: await upsertSnapshotPage(activeStore, input, c.get('principal')),
    }));
    if (!response.replayed) {
      const page = response.body;
      hub.publishPage(page);
      await broadcastList();
      // A row page's content changed — refresh its database's expr columns.
      if (page.databaseId) await broadcastRows(page.databaseId);
      logEdit(c, page.id, 'page.create', page.name ?? '');
    }
    return durableWriteResponse(c, response);
  });

  // Page-scoped lookup avoids a full-store formId scan. The form capability is
  // necessary but not sufficient: requireFormSubmissionAccess also reuses the
  // caller's existing page READ decision and binds the target database to this
  // host page. Every missing/disabled/unreadable/wrong-key state 404s alike.
  app.post(
    `${API.pages}/:pageId/forms/:formId/submissions`,
    bodyLimit({
      maxSize: FORM_SUBMISSION_MAX_BODY_BYTES,
      onError: (c) => c.json({error: 'request body too large'}, 413),
    }),
    async (c) => {
      const body = await c.req.json<unknown>().catch(() => null);
      const pageId = c.req.param('pageId');
      const formId = c.req.param('formId');
      const {page, form} = await requireFormSubmissionAccess(
        c,
        store,
        pageId,
        formId,
        formSubmissionKey(body),
      );
      if (formRateLimited(c, pageId, formId)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      await store.gcExpiredFormUploads(FORM_UPLOAD_ORPHAN_TTL_MS);
      const input = validateFormSubmissionRequest(body);
      const submittedAt = new Date().toISOString();
      if (
        typeof form.schema !== 'object' ||
        form.schema === null ||
        Array.isArray(form.schema) ||
        !Array.isArray((form.schema as {fields?: unknown}).fields)
      ) {
        throw new HTTPException(404, {message: 'form not found'});
      }
      const schema = form.schema as FormSchema;
      const validation = validateSubmission(schema, input.values);
      if ('honeypot' in validation) {
        const tokens = formFileEntries(schema, input.values).flatMap((entry) => entry.tokens);
        await store.discardFormUploads(page.id, form.formId, tokens);
        const result: FormSubmissionResult = {rowId: randomUUID(), submittedAt};
        return c.json(result, 201);
      }
      if (!validation.ok) return c.json({errors: validation.errors}, 400);
      const uploadEntries = formFileEntries(schema, validation.coerced);
      const uploadCount = uploadEntries.reduce((count, entry) => count + entry.tokens.length, 0);
      if (uploadCount > FORM_UPLOAD_MAX_FILES) return c.json({error: 'too many files'}, 400);
      const claimed = await store.claimFormUploads(
        page.id,
        form.formId,
        uploadEntries,
        input.idempotencyKey,
        FORM_UPLOAD_ORPHAN_TTL_MS,
      );
      if (!claimed) return c.json({error: 'invalid or expired form upload'}, 400);
      const uploadByToken = new Map(claimed.map((upload) => [upload.token, upload]));
      const storedValues = {...validation.coerced};
      for (const entry of uploadEntries) {
        storedValues[entry.fieldId] = entry.tokens.map((token) => {
          const upload = uploadByToken.get(token)!;
          return `${API.asset(upload.assetId)}?filename=${encodeURIComponent(upload.name)}`;
        });
      }
      const database = await store.getDatabase(form.databaseId);
      if (!database) throw new HTTPException(404, {message: 'form not found'});
      const {rowInput, warnings} = submissionToRowInput(schema, storedValues, database.schema);
      if (warnings.length > 0) {
        console.warn('OpenBook form submission projection discarded fields:', {
          pageId: page.id,
          formId: form.formId,
          warnings,
        });
      }
      const {page: pageRow, created} = await store.createRow(
        form.databaseId,
        {
          properties: {
            ...rowInput.properties,
            [FORM_SUBMISSION_PROPERTY_ID]: {formId: form.formId, submittedAt},
          },
        },
        c.get('principal'),
        {
          idempotency: {
            scope: `form:${page.id}:${form.formId}`,
            key: input.idempotencyKey,
          },
        },
      );
      const replayTokens = claimed
        .filter((upload) => upload.consumedBy === pageRow.id)
        .map((upload) => upload.token);
      const freshTokens = claimed
        .filter((upload) => upload.consumedBy !== pageRow.id)
        .map((upload) => upload.token);
      if (created) {
        await store.consumeFormUploads(claimed.map((upload) => upload.token), input.idempotencyKey, pageRow.id);
      } else {
        await store.consumeFormUploads(replayTokens, input.idempotencyKey, pageRow.id);
        await store.discardFormUploads(page.id, form.formId, freshTokens);
      }
      const marker = pageRow.properties[FORM_SUBMISSION_PROPERTY_ID];
      const originalSubmittedAt =
        typeof marker === 'object' &&
        marker !== null &&
        'submittedAt' in marker &&
        typeof marker.submittedAt === 'string'
          ? marker.submittedAt
          : submittedAt;

      // A replay returns the original row/result and emits no duplicate durable
      // or live side effects. The atomic write-key claim is the source of truth;
      // wall-clock equality is not a reliable create/replay discriminator.
      if (created) {
        hub.publishPage(pageRow);
        await broadcastRows(form.databaseId);
        logEdit(c, pageRow.id, 'form.submit', form.formId);
      }
      const result: FormSubmissionResult = {rowId: pageRow.id, submittedAt: originalSubmittedAt};
      return c.json(result, 201);
    },
  );

  app.get(`${API.pages}/:id`, async (c) => {
    const page = await store.getPageFor(c.get('principal'), c.req.param('id'));
    return page ? c.json(page) : c.json({error: 'page not found'}, 404);
  });

  app.put(`${API.pages}/:id`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    // A managed usage page (host or attribution row) can't be renamed/body-overwritten
    // via upsert either — after the access gate so a non-reader stays 404 (see PATCH).
    await rejectManagedPage(c.req.param('id'));
    await requireAgentDirectWrite(c, c.req.param('id'));
    const input = await c.req.json<PageInput>();
    input.id = c.req.param('id');
    const response = await executeDurableWrite(c, async (activeStore) => ({
      status: 200,
      body: await upsertSnapshotPage(activeStore, input, c.get('principal')),
    }));
    if (!response.replayed) {
      const page = response.body;
      hub.publishPage(page);
      await broadcastList();
      if (page.databaseId) await broadcastRows(page.databaseId);
      logEdit(c, page.id, 'page.save', page.name ?? '');
    }
    return durableWriteResponse(c, response);
  });

  app.patch(`${API.pages}/:id`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    await rejectManagedPage(c.req.param('id'));
    await requireAgentDirectWrite(c, c.req.param('id'));
    const body = await c.req.json<{name?: string | null}>();
    const response = await executeDurableWrite(c, async (activeStore) => {
      const page = await activeStore.renamePage(c.req.param('id'), body.name ?? null);
      return page
        ? {status: 200, body: page}
        : {status: 404, body: {error: 'page not found'}};
    });
    if (!response.replayed && response.status === 200) {
      const page = response.body as Awaited<ReturnType<typeof store.renamePage>> & {};
      hub.publishPage(page);
      await broadcastList();
      logEdit(c, page.id, 'page.rename', page.name ?? '');
    }
    return durableWriteResponse(c, response);
  });

  // Shallow-merge structured property values (owner, verification, …) onto a
  // page. Publishes the page so an open editor reflects it live, and refreshes
  // the owning database's rows when the page is a row.
  app.patch(`${API.pages}/:id/properties`, async (c) => {
    await requireAccess(c, store, 'write', c.req.param('id'));
    await rejectManagedPage(c.req.param('id'));
    await requireAgentDirectWrite(c, c.req.param('id'));
    const body = await c.req.json<{properties?: Record<string, unknown>}>();
    const response = await executeDurableWrite(c, async (activeStore) => {
      const page = await activeStore.setPageProperties(c.req.param('id'), body.properties ?? {});
      return page
        ? {status: 200, body: page}
        : {status: 404, body: {error: 'page not found'}};
    });
    if (!response.replayed && response.status === 200) {
      const page = response.body as Awaited<ReturnType<typeof store.setPageProperties>> & {};
      hub.publishPage(page);
      // The icon shows in the sidebar (it's part of PageMeta), so re-stream the
      // page list when it changes; other properties don't affect the list.
      if (body.properties && 'sys_icon' in body.properties) await broadcastList();
      if (page.databaseId) await broadcastRows(page.databaseId);
      logEdit(c, page.id, 'page.properties');
    }
    return durableWriteResponse(c, response);
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

  // FORM-6 anonymous asset carve-out. This route deliberately reuses the exact
  // submission capability/read/same-host/ceiling gate and only then admits forms
  // with a files field. Bytes are staged without an `asset_refs` edge, so they are
  // neither readable nor durable until a valid submission consumes the opaque
  // token. Activity on either form route sweeps unconsumed stages after 30 minutes.
  app.post(
    `${API.pages}/:pageId/forms/:formId/uploads`,
    bodyLimit({
      maxSize: FORM_UPLOAD_MAX_BODY_BYTES,
      onError: (c) => c.json({error: 'request body too large'}, 413),
    }),
    async (c) => {
      const pageId = c.req.param('pageId');
      const formId = c.req.param('formId');
      // Shed a peer that is already over budget before parsing its multi-megabyte
      // envelope. Preserve the form gate's byte-identical denial contract.
      const preGateBucket = formRateBucket(c, pageId, formId);
      if (preGateBucket.limiter.peek(preGateBucket.key)) {
        return c.json({error: 'form not found'}, 404);
      }
      const body = await c.req.json<unknown>().catch(() => null);
      const {page, form} = await requireFormUploadAccess(
        c,
        store,
        pageId,
        formId,
        formSubmissionKey(body),
      );
      if (formRateLimited(c, pageId, formId)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      await store.gcExpiredFormUploads(FORM_UPLOAD_ORPHAN_TTL_MS);
      const input = validateFormUploadRequest(body);
      if (!isFormFilesField(form.schema, input.fieldId)) {
        return c.json({error: 'invalid form upload field'}, 400);
      }
      const bytes = decodeFormUploadBase64(input.data);
      if (!bytes || bytes.byteLength === 0) return c.json({error: 'invalid form upload'}, 400);
      if (bytes.byteLength > FORM_UPLOAD_MAX_FILE_BYTES) {
        return c.json({error: 'request body too large'}, 413);
      }
      const mime = safeAssetMime(input.mime);
      if (mime === null) return c.json({error: 'invalid content type'}, 400);

      try {
        const staged = await store.stageFormUpload(
          bytes,
          mime,
          {
            token: randomUUID(),
            pageId: page.id,
            formId: form.formId,
            fieldId: input.fieldId,
            name: input.name.trim(),
          },
          {
            // TODO(FORM-4/owner-config): make the durable per-form ceiling
            // operator-configurable and notify the owner when either form budget
            // is exhausted once an owner-facing notification channel exists.
            maxFormBytes: FORM_UPLOAD_MAX_FORM_BYTES,
            maxFormStagedBytes: FORM_UPLOAD_MAX_FORM_STAGED_BYTES,
            maxTotalBytes: ASSET_STORAGE_BUDGET_BYTES > 0 ? ASSET_STORAGE_BUDGET_BYTES : undefined,
          },
        );
        const result: FormUploadResult = {token: staged.token, name: staged.name, size: staged.size};
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof AssetBudgetError || err instanceof FormAssetBudgetError) {
          return c.json({error: 'asset storage is full'}, 507);
        }
        throw err;
      }
    },
  );

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
        ({id} = await store.putAssetAndRef(bytes, safeMime, pageId, {
          maxTotalBytes: ASSET_STORAGE_BUDGET_BYTES > 0 ? ASSET_STORAGE_BUDGET_BYTES : undefined,
        }));
      } catch (err) {
        if (err instanceof AssetBudgetError) return c.json({error: 'asset storage is full'}, 507);
        throw err;
      }
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
      // Block-level CRDT save: this folds an agent's edit into the server's canonical
      // doc (the persister below attributes changed blocks to the principal), so it is
      // a DIRECT content edit and must obey the same agent-edits gate as the PUT
      // snapshot path — otherwise a suggest-mode PAT could stream block edits here to
      // bypass the review layer.
      await requireAgentDirectWrite(c, id);
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
          .ingest(id, updateBytes, authoredSubject(c.get('principal')))
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

  // The whole-library page-link graph. Gated exactly like GET /api/pages: the
  // per-principal read filter IS the access control (no requireAccess on a single
  // page — this is a library-wide read), so a guest passes the same read gate as
  // the page list. A blanket fast path (mirroring filterReadablePages) resolves
  // the page-independent decision once — uniformly-readable ⇒ unfiltered build,
  // uniformly-denied ⇒ empty graph — else the graph builder is threaded the
  // principal's `canReadPage` predicate (access base resolved once, amortised
  // across pages, mirroring /api/ai/search) so a restricted page is dropped as a
  // node AND its edges are dropped from both directions. Sasha: read-gate seam.
  app.get(API.pageGraph, async (c) => {
    const principal = c.get('principal');
    const base = await store.accessBase(principal);
    // Blanket fast path (mirrors filterReadablePages): only an owner/admin may
    // bypass the discovery predicate. A blanket-read guest can open every page
    // directly but still needs the per-page listed check here.
    const blanket = await store.blanketReadDecision(principal, base);
    if (blanket === false) return c.json({nodes: [], edges: []});
    if (blanket === true && (await store.canListUnlisted(principal, base))) return c.json(await store.pageGraph());
    if (blanket === true) {
      // A blanket-readable but non-listing-privileged caller can open every page
      // directly. Avoid N per-page authorization queries: discovery differs only
      // by the stored flag, so fetch the live unlisted ids once and use set lookups
      // while the graph is assembled.
      const unlistedSet = new Set(await store.listUnlistedPageIds());
      return c.json(await store.pageGraph((pageId) => !unlistedSet.has(pageId)));
    }
    return c.json(await store.pageGraph((pageId) => store.canListPage(principal, pageId, base)));
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
    // A restore is a direct content mutation (it overwrites pages.data with a prior
    // snapshot), so a suggest-mode agent PAT must be steered to the review path rather
    // than rolling the page back straight through — same gate as save/PATCH (AGED-2).
    await requireAgentDirectWrite(c, id);
    const version = await store.getPageVersion(id, c.req.param('vid'));
    if (!version) return c.json({error: 'version not found'}, 404);
    // Preserve the page's current name — only the document content rolls back.
    const existing = await store.getPage(id);
    if (!existing) return c.json({error: 'page not found'}, 404);
    // Restore is the overwrite arm of `withSnapshotWriteFence` (PVH-8), not the client
    // snapshot merge arm above. The fence owns this full ordered interval:
    //  • quiesce drains every pre-restore checkpoint before the durable restore write;
    //  • afterWrite forgets the relay while the canonical doc is still frozen;
    //  • reseed then drops the canonical doc and releases the freeze.
    // Keeping relay invalidation inside the fence closes the window where an unfrozen
    // restored canonical doc could coexist with the relay's pre-restore state.
    const response = await executeDurableWrite(c, async (activeStore) => {
      const writeRestore = () => activeStore.upsertPage(
        {id, name: existing.name, data: version.data},
        c.get('principal'),
        {captureMode: 'force'},
      );
      const page = persister
        ? await persister.withSnapshotWriteFence(id, writeRestore, {
          intent: 'overwrite',
          afterWrite: () => relay.forget(id),
        })
        : await (async () => {
          try {
            return await writeRestore();
          } finally {
            relay.forget(id);
          }
        })();
      return {status: 200, body: page};
    });
    if (!response.replayed) {
      const page = response.body;
      hub.publishPage(page);
      await broadcastList();
      if (page.databaseId) await broadcastRows(page.databaseId);
      logEdit(c, page.id, 'page.version.restore', c.req.param('vid'));
    }
    return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => {
      const page = await activeStore.movePage(id, body.parentId ?? null, body.orderedIds ?? []);
      return page
        ? {status: 200, body: page}
        : {status: 409, body: {error: 'invalid move (would create a cycle)'}};
    });
    if (!response.replayed && response.status === 200) {
      const page = response.body as NonNullable<Awaited<ReturnType<typeof store.movePage>>>;
      hub.publishPage(page);
      await broadcastList();
      logEdit(c, page.id, 'page.move');
    }
    return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => (await activeStore.deletePage(id))
      ? {status: 204, body: null}
      : {status: 404, body: {error: 'page not found'}});
    if (!response.replayed && response.status === 204) {
      hub.publishDeleted(id);
      relay.forget(id); // free the page's relay doc (Collab T1); reseeds if restored
      persister?.forget(id); // drop the canonical doc WITHOUT persisting (Collab T9)
      awarenessRelay.forget(id); // drop any lingering presence (Collab T4)
      await broadcastList();
      if (existing?.databaseId) await broadcastRows(existing.databaseId);
      logEdit(c, id, 'page.delete', existing?.name ?? '');
    }
    return durableWriteResponse(c, response);
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

  // A whole-library bundle (pages + databases + the ledger's base64 evidence)
  // is legitimately large but not unbounded: cap the body so a hostile or
  // runaway upload cannot balloon the process (the request IS materialized in
  // memory — admin-gated, availability-only, but the front door should still
  // have a jamb). Generous by design: a real library restore must never hit it.
  const IMPORT_MAX_BODY_BYTES = 512 * 1024 * 1024;
  app.post(
    API.importLibrary,
    bodyLimit({maxSize: IMPORT_MAX_BODY_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
    // Wholesale overwrite/inject of pages + databases — instance administration
    // only, same gate (and rationale) as the export above.
      await requireInstanceAdmin(c, store);
      const req = await c.req.json<ImportRequest>();
      // LGR-15: the actor is recorded on the `ledger.restore` provenance event a
      // ledger-carrying restore appends; the asset budget makes restored evidence
      // answer to the same storage cap as uploads.
      const result = await store.importBundle(req, {
        actor: c.get('principal'),
        assetBudgetBytes: ASSET_STORAGE_BUDGET_BYTES > 0 ? ASSET_STORAGE_BUDGET_BYTES : undefined,
      });
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
    // GATE-7: fence the identity-INFRASTRUCTURE block (owner subject, trusted issuers,
    // audience) off the anonymous surface a claimed, internet-exposable
    // (`published`-scope) instance presents. A guest still gets everything the client
    // needs to render (guestAccess, defaultVisibility, you, instanceId, youRole), but
    // not the recon-only identity metadata. An authenticated identity, the loopback /
    // local owner, and the legacy UNCLAIMED single-user path keep the full payload —
    // the owner claim/repair + forwarding-audience flows all run authenticated.
    const showIdentity = isAuthenticatedPrincipal(c) || config.ownerSubject === undefined;
    const info: InstanceInfo = {
      writeContract: 1,
      guestAccess: config.guestAccess,
      // The instance-wide agent-edits mode (AGED-1) — so a client can render the
      // policy and resolve a page's `inherit` without a second probe.
      agentEdits: config.agentEdits,
      // Stable, opaque per-library id (STAB-5) so an out-of-process MCP connector
      // can confirm it reached THIS library and refuse a foreign responder on the
      // same port. Not a secret — authorizes nothing.
      instanceId: config.instanceId ?? null,
      ownerSubject: showIdentity ? (config.ownerSubject ?? null) : null,
      // Whether the instance is owned at all, WITHOUT saying by whom (PUB-1). Sits
      // OUTSIDE the GATE-7 fence on purpose: `ownerSubject` above is nulled for an
      // anonymous caller on a claimed instance, which makes it useless as a claim
      // signal, and a client needs the claim state to warn honestly that an
      // UNCLAIMED library ignores `defaultVisibility` (authorize rule 0 judges
      // everyone by the guest gate alone). A bare boolean carries no identity.
      claimed: config.ownerSubject !== undefined,
      trustedIssuers: showIdentity ? config.trustedIssuers.map((i) => i.issuer) : [],
      audience: showIdentity ? (config.audience ?? null) : null,
      requireAudience: config.requireAudience ?? false,
      // What `visibility='inherit'` resolves to at the root once claimed — so a
      // client can show the TRUE effective default behind "Library default"
      // (SHR-6), not just the unclaimed-only guest gate. Never `inherit`.
      defaultVisibility: config.defaultVisibility ?? null,
      // LGR-7 (S4): where the ledger auto-export writes, so the owner can SEE
      // that copies of the book are leaving (an unreadable setting is an
      // invisible exfiltration channel). Behind the same identity fence as the
      // rest of the identity-infrastructure block.
      ledgerAutoExportPath: showIdentity ? (config.ledgerAutoExportPath ?? null) : null,
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

    // LGR-7 (S1): the ledger auto-export target is a server-side filesystem
    // WRITE target, so it needs a REAL owner — regardless of claim state. The
    // general policy gate further down only engages once `ownerSubject` is set,
    // which on an UNCLAIMED instance (the documented headless `--access-token`
    // LAN posture) let any caller — including an anonymous one — point the
    // export at a victim file. This check runs before the claim/repair branches
    // so no path can ride in on a claim request either.
    if (patch.ledgerAutoExportPath !== undefined) {
      if (patch.ledgerAutoExportPath !== null) {
        if (typeof patch.ledgerAutoExportPath !== 'string' || patch.ledgerAutoExportPath.trim() === '') {
          return c.json({error: 'ledgerAutoExportPath must be a non-empty file path or null'}, 400);
        }
      }
      if (!isRealInstanceOwner(c, current)) {
        return c.json({error: 'only the instance owner can set the ledger auto-export path'}, 403);
      }
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
      const response = await executeDurableWrite(c, async (activeStore) => {
        const {config, claimed} = await activeStore.claimOwnership(principal.subject);
        if (!claimed) return {status: 409, body: {error: 'this instance has already been claimed'}};
        // Apply any other policy fields the claim request carried (the CAS already
        // owns `ownerSubject` + the §2.6 bootstrap, so it's stripped here).
        const rest: Partial<InstanceConfig> = {...patch};
        delete rest.ownerSubject;
        const next = Object.keys(rest).length > 0 ? await activeStore.updateInstanceConfig(rest) : config;
        return {status: 200, body: next};
      });
      if (!response.replayed && response.status === 200) {
        logEdit(c, null, 'instance.claim', principal.subject);
      }
      return durableWriteResponse(c, response);
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
      const response = await executeDurableWrite(c, async (activeStore) => {
        const repaired = await activeStore.repairOwnership(principal.subject);
        const rest: Partial<InstanceConfig> = {...patch};
        delete rest.ownerSubject;
        return {
          status: 200,
          body: Object.keys(rest).length > 0
            ? await activeStore.updateInstanceConfig(rest)
            : repaired,
        };
      });
      if (!response.replayed) {
        logEdit(c, null, 'instance.repair', `${current.ownerSubject} -> ${principal.subject}`);
      }
      return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => ({
      status: 200,
      body: await activeStore.updateInstanceConfig(patch),
    }));
    const next = response.body;
    // LGR-7 (S4): a change to where the book gets written must be VISIBLE.
    // The edit-log detail previously recorded only `guestAccess`, so an
    // exfiltration destination could be set and later cleared without leaving
    // a trace the legitimate owner could find. The path itself stays out of the
    // detail string (it is on `GET /api/instance` for anyone who may see it);
    // the ledger's own append-only audit gets the full before/after.
    const exportPathChanged =
      patch.ledgerAutoExportPath !== undefined &&
      (current.ledgerAutoExportPath ?? null) !== (next.ledgerAutoExportPath ?? null);
    const detail = exportPathChanged
      ? `guestAccess=${next.guestAccess}, ledgerAutoExportPath=${next.ledgerAutoExportPath ? 'set' : 'cleared'}`
      : `guestAccess=${next.guestAccess}`;
    if (!response.replayed) logEdit(c, null, 'instance.policy', detail);
    if (!response.replayed && exportPathChanged) {
      // Best-effort: policy is already persisted, so a failure here must not
      // fail the request — but it is loud in the server log.
      await store.ledger
        .auditAutoExportPath(current.ledgerAutoExportPath ?? null, next.ledgerAutoExportPath ?? null, principal)
        .catch((err) => console.error('OpenBook: could not audit the ledger auto-export path change:', err));
    }
    return durableWriteResponse(c, response);
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
    return c.json((await store.getPageVisibility(id)) ?? {visibility: 'inherit', listed: true});
  });

  app.put(`${API.pages}/:id/visibility`, async (c) => {
    const id = c.req.param('id');
    denyPatPolicy(c);
    await requireAccess(c, store, 'write', id);
    await rejectManagedPage(id);
    const body = await c.req.json<{visibility?: PageVisibility; listed?: boolean}>();
    if (body.visibility === undefined && body.listed === undefined) {
      return c.json({error: 'visibility or listed is required'}, 400);
    }
    if (body.visibility !== undefined && !PAGE_VISIBILITIES.includes(body.visibility)) {
      return c.json({error: 'visibility must be a valid scope'}, 400);
    }
    if (body.listed !== undefined && typeof body.listed !== 'boolean') {
      return c.json({error: 'listed must be a boolean'}, 400);
    }
    const update: PageVisibilityUpdate = {
      ...(body.visibility !== undefined ? {visibility: body.visibility} : {}),
      ...(body.listed !== undefined ? {listed: body.listed} : {}),
    } as PageVisibilityUpdate;
    const response = await executeDurableWrite(c, async (activeStore) => {
      const ok = await activeStore.setPageVisibility(id, update);
      return ok
        ? {status: 200, body: (await activeStore.getPageVisibility(id))!}
        : {status: 404, body: {error: 'page not found'}};
    });
    if (!response.replayed && response.status === 200) {
      if (update.listed !== undefined) await broadcastList();
      logEdit(c, id, 'page.visibility', JSON.stringify(update));
    }
    return durableWriteResponse(c, response);
  });

  // A page's agent-edits policy (AGED-1). Read is gated on reading the page (a viewer
  // may see whether agents edit this page directly). Unlike visibility's write (gated
  // on page-write), the PUT is jws-only via `denyPatPolicy`: an agent PAT must NEVER
  // set the policy that governs whether agents may edit this page directly —
  // self-authorization. `requireAccess` 404s a page the caller can't even read.
  //
  // Alongside the raw stored `agentEdits` policy (which AGED-4/5's UI reads for the
  // tri-state), the response carries the SERVER-RESOLVED `effective` mode (AGED-6):
  // `resolveAgentEdits(rawPolicy, instanceMode)`, computed here because only the
  // server may read its own instance config. This lets a PAT-scoped MCP client learn
  // the effective mode for an `inherit` page WITHOUT the privileged `GET /api/instance`
  // read (which the AGENT-6 scope-gate denies to PATs) — one PAT-readable call. The
  // instance default is not confidential; exposing the resolved mode on a page the
  // caller can already read leaks nothing. The write-gate (AGED-2) remains the
  // authoritative backstop; this only lets the client avoid a needless suggestion.
  app.get(`${API.pages}/:id/agent-edits`, async (c) => {
    const id = c.req.param('id');
    await requireAccess(c, store, 'read', id);
    const agentEdits = (await store.getPageAgentEdits(id)) ?? 'inherit';
    const effective = await resolveAgentEditsForPage(store, id);
    return c.json({agentEdits, effective});
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
    const response = await executeDurableWrite(c, async (activeStore) => (await activeStore.setPageAgentEdits(id, agentEdits))
      ? {status: 200, body: {agentEdits}}
      : {status: 404, body: {error: 'page not found'}});
    if (!response.replayed && response.status === 200) {
      logEdit(c, id, 'page.agentEdits', agentEdits);
    }
    return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => {
      const page = await activeStore.restorePage(c.req.param('id'));
      return page
        ? {status: 200, body: page}
        : {status: 404, body: {error: 'page not found in trash'}};
    });
    if (!response.replayed && response.status === 200) {
      const page = response.body as NonNullable<Awaited<ReturnType<typeof store.restorePage>>>;
      hub.publishPage(page);
      await broadcastList();
      if (page.databaseId) await broadcastRows(page.databaseId);
      logEdit(c, page.id, 'page.restore', page.name ?? '');
    }
    return durableWriteResponse(c, response);
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

  const requireManageDatabaseForm = async (c: Context<AppEnv>) => {
    denyPatPolicy(c);
    const databaseId = c.req.param('databaseId');
    const viewId = c.req.param('viewId');
    if (!databaseId || !viewId) throw new HTTPException(404, {message: 'form not found'});
    await requireDbAccess(c, store, 'write', databaseId);
    const database = await store.getDatabase(databaseId);
    const view = database ? currentDatabaseFormView(database, viewId) : null;
    if (!database || !view) throw new HTTPException(404, {message: 'form not found'});
    if (await store.isManagedDatabase(databaseId)) {
      throw new HTTPException(403, {message: 'this database is server-managed and cannot publish a form'});
    }
    return {database, view};
  };

  const requireReadDatabaseForm = async (c: Context<AppEnv>) => {
    const databaseId = c.req.param('databaseId');
    const viewId = c.req.param('viewId');
    if (!databaseId || !viewId) throw new HTTPException(404, {message: 'form not found'});
    await requireDbAccess(c, store, 'read', databaseId);
    const database = await store.getDatabase(databaseId);
    const view = database ? currentDatabaseFormView(database, viewId) : null;
    if (!database || !view) throw new HTTPException(404, {message: 'form not found'});
    return {database, view};
  };

  const invalidDatabaseFormPatternIds = (
    database: Awaited<ReturnType<typeof requireManageDatabaseForm>>['database'],
    view: Awaited<ReturnType<typeof requireManageDatabaseForm>>['view'],
  ): string[] => {
    const mapped = new Set(view.visiblePropertyIds ?? []);
    const liveIds = new Set([
      ...(mapped.has(TITLE_PROPERTY_ID) ? [TITLE_PROPERTY_ID] : []),
      ...database.schema.properties
        .filter((property) =>
          mapped.has(property.id)
          && !property.id.startsWith('sys_')
          && isFormWritablePropertyType(property.type),
        )
        .map((property) => property.id),
    ]);
    return [...liveIds].filter((propertyId) => {
      const pattern = view.formFields?.[propertyId]?.validation?.pattern;
      if (pattern === undefined) return false;
      if (typeof pattern !== 'string' || pattern.length > 256 || formPatternIsUnsafe(pattern)) return true;
      try {
        void new RegExp(pattern);
        return false;
      } catch {
        return true;
      }
    });
  };
  app.post(API.databases, async (c) => {
    const input = await c.req.json<DatabaseInput>();
    // Hosting a database on a page is a write to that page.
    await requireAccess(c, store, 'write', input.pageId);
    const response = await executeDurableWrite(c, async (activeStore) => ({
      status: 201,
      body: await activeStore.createDatabase(input),
    }));
    if (!response.replayed) {
      const database = response.body;
      // The host page now hosts a database: refresh its page event + the list so
      // the document area renders the view and the sidebar marks it.
      const host = await store.getPage(database.pageId);
      if (host) hub.publishPage(host);
      await broadcastList();
      logEdit(c, database.pageId, 'database.create', database.name ?? '');
    }
    return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => {
      const database = await activeStore.updateDatabase(c.req.param('id'), patch);
      return database
        ? {status: 200, body: database}
        : {status: 404, body: {error: 'database not found'}};
    });
    if (!response.replayed && response.status === 200) {
      const database = response.body as NonNullable<Awaited<ReturnType<typeof store.updateDatabase>>>;
      // Schema changes (new/removed columns, filters) affect every row view.
      await broadcastRows(database.id);
    }
    return durableWriteResponse(c, response);
  });

  // F-4 publication lifecycle. POST is both first-publish and rotate: because the
  // plaintext is never stored, every successful call mints a fresh capability and
  // atomically replaces the digest. The response exposes it only inside the public
  // descriptor URL's fragment, so navigation/proxy logs never receive the secret.
  app.get(`${API.databases}/:databaseId/views/:viewId/capability`, async (c) => {
    const {database, view} = await requireReadDatabaseForm(c);
    const maxResponses = databaseFormResponseCap(view);
    if (maxResponses === null) return c.json({error: 'form not found'}, 404);
    const published = (await store.getDatabaseFormCapabilityHash(database.id, view.id)) !== null;
    const responseCount = await store.countDatabaseFormResponses(database.id, view.id);
    return c.json({published, responseCount, maxResponses});
  });

  app.post(`${API.databases}/:databaseId/views/:viewId/capability`, async (c) => {
    const {database, view} = await requireManageDatabaseForm(c);
    const invalidPatternIds = invalidDatabaseFormPatternIds(database, view);
    if (invalidPatternIds.length > 0) {
      return c.json({error: 'invalid form validation pattern', propertyIds: invalidPatternIds}, 400);
    }
    const capability = generateSubmissionKey();
    const published = await store.setDatabaseFormCapabilityHash(
      database.id,
      view.id,
      hashDatabaseFormCapability(capability),
    );
    if (!published) return c.json({error: 'form not found'}, 404);
    const url = new URL('/', c.req.url);
    url.searchParams.set('form', database.id);
    url.searchParams.set('view', view.id);
    url.hash = `capability=${capability}`;
    logEdit(c, database.pageId, 'database.form.publish', view.id);
    return c.json({url: `${url.pathname}${url.search}${url.hash}`}, 201);
  });

  app.delete(`${API.databases}/:databaseId/views/:viewId/capability`, async (c) => {
    const {database, view} = await requireManageDatabaseForm(c);
    const revoked = await store.revokeDatabaseFormCapability(database.id, view.id);
    if (!revoked) return c.json({error: 'form not found'}, 404);
    logEdit(c, database.pageId, 'database.form.revoke', view.id);
    return c.body(null, 204);
  });

  // The sole anonymous read opened by a published form. The raw fragment token
  // is copied into this POST body; it is never accepted from a query string.
  app.post(
    `${API.databases}/:databaseId/views/:viewId/form`,
    bodyLimit({
      maxSize: FORM_SUBMISSION_MAX_BODY_BYTES,
      onError: (c) => c.json({error: 'request body too large'}, 413),
    }),
    async (c) => {
      const databaseId = c.req.param('databaseId');
      const viewId = c.req.param('viewId');
      // Shed an already-over-budget peer before parsing or touching publication
      // state. Failed gates below record into this same form-specific bucket.
      if (databaseFormPeerRateLimited(c, databaseId, viewId, false)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      const body = await c.req.json<unknown>().catch(() => null);
      const {database, view, capabilityHash} = await requireMeteredDatabaseFormAccess(
        c,
        databaseId,
        viewId,
        databaseFormCapability(body),
      );
      if (databaseFormRateLimited(c, databaseId, viewId, capabilityHash)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      validateDatabaseFormDescriptorRequest(body);
      const descriptor = projectDatabaseFormDescriptor(database.schema, view);
      return descriptor
        ? c.json(descriptor)
        : c.json({error: 'form not found'}, 404);
    },
  );

  app.post(
    `${API.databases}/:databaseId/views/:viewId/uploads`,
    bodyLimit({
      maxSize: FORM_UPLOAD_MAX_BODY_BYTES,
      onError: (c) => c.json({error: 'request body too large'}, 413),
    }),
    async (c) => {
      const body = await c.req.json<unknown>().catch(() => null);
      const databaseId = c.req.param('databaseId');
      const viewId = c.req.param('viewId');
      const {database, view, capabilityHash} = await requireDatabaseFormSubmissionAccess(
        store,
        databaseId,
        viewId,
        databaseFormCapability(body),
      );
      if (view.formConfig?.acceptingResponses !== true) {
        return c.json({error: 'form_closed'}, 403);
      }
      const responseCap = databaseFormResponseCap(view);
      if (responseCap === null) return c.json({error: 'form not found'}, 404);
      if ((await store.countDatabaseFormResponses(database.id, view.id)) >= responseCap) {
        return c.json({error: 'response limit reached'}, 429);
      }
      if (databaseFormRateLimited(c, databaseId, viewId, capabilityHash)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      await store.gcExpiredFormUploads(FORM_UPLOAD_ORPHAN_TTL_MS);
      const input = validateDatabaseFormUploadRequest(body);
      if (!isDatabaseFormFilesField(database, view, input.fieldId)) {
        return c.json({error: 'invalid form upload field'}, 400);
      }
      const bytes = decodeFormUploadBase64(input.data);
      if (!bytes || bytes.byteLength === 0) return c.json({error: 'invalid form upload'}, 400);
      if (bytes.byteLength > FORM_UPLOAD_MAX_FILE_BYTES) {
        return c.json({error: 'request body too large'}, 413);
      }
      const mime = safeAssetMime(input.mime);
      if (mime === null) return c.json({error: 'invalid content type'}, 400);

      try {
        const staged = await store.stageFormUpload(
          bytes,
          mime,
          {
            token: randomUUID(),
            pageId: database.pageId,
            formId: databaseFormUploadId(view.id),
            fieldId: input.fieldId,
            name: input.name.trim(),
            capabilityHash,
          },
          {
            maxFormBytes: FORM_UPLOAD_MAX_FORM_BYTES,
            maxFormStagedBytes: FORM_UPLOAD_MAX_FORM_STAGED_BYTES,
            maxTotalBytes: ASSET_STORAGE_BUDGET_BYTES > 0 ? ASSET_STORAGE_BUDGET_BYTES : undefined,
          },
        );
        const result: FormUploadResult = {token: staged.token, name: staged.name, size: staged.size};
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof AssetBudgetError || err instanceof FormAssetBudgetError) {
          return c.json({error: 'asset storage is full'}, 507);
        }
        throw err;
      }
    },
  );

  // The public fill authorization rung. It bypasses ordinary database read/write
  // authority, but only after current publication, capability, response-state, and
  // managed-database checks. Validation uses freshly loaded SDK schema/view data.
  app.post(
    `${API.databases}/:databaseId/views/:viewId/submissions`,
    bodyLimit({
      maxSize: FORM_SUBMISSION_MAX_BODY_BYTES,
      onError: (c) => c.json({error: 'request body too large'}, 413),
    }),
    async (c) => {
      const databaseId = c.req.param('databaseId');
      const viewId = c.req.param('viewId');
      // Failed capabilities must consume a trusted-peer budget too; otherwise an
      // attacker can flood the constant-time digest/DB gate without touching either
      // post-auth limiter. `peek` preserves an early 429 once that budget is spent.
      if (databaseFormPeerRateLimited(c, databaseId, viewId, false)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      const body = await c.req.json<unknown>().catch(() => null);
      const {database, view, capabilityHash} = await requireMeteredDatabaseFormAccess(
        c,
        databaseId,
        viewId,
        databaseFormCapability(body),
      );
      if (view.formConfig?.acceptingResponses !== true) {
        return c.json({error: 'form_closed'}, 403);
      }
      const responseCap = databaseFormResponseCap(view);
      if (responseCap === null) return c.json({error: 'form not found'}, 404);
      if (databaseFormRateLimited(c, databaseId, viewId, capabilityHash)) {
        return c.json({error: 'rate limit exceeded'}, 429);
      }
      await store.gcExpiredFormUploads(FORM_UPLOAD_ORPHAN_TTL_MS);
      const input = validateDatabaseFormSubmissionRequest(body);
      const validation = validateRowAgainstForm(database.schema, view, input.fields);
      if (!validation.ok) return c.json({errors: validation.errors}, 400);

      const uploadEntries = databaseFormFileEntries(database.schema, validation.fields);
      const uploadCount = uploadEntries.reduce((count, entry) => count + entry.tokens.length, 0);
      if (uploadCount > FORM_UPLOAD_MAX_FILES) return c.json({error: 'too many files'}, 400);
      const uploadFormId = databaseFormUploadId(view.id);
      const claimed = await store.claimFormUploads(
        database.pageId,
        uploadFormId,
        uploadEntries,
        input.idempotencyKey,
        FORM_UPLOAD_ORPHAN_TTL_MS,
        capabilityHash,
      );
      if (!claimed) return c.json({error: 'invalid or expired form upload'}, 400);
      const uploadByToken = new Map(claimed.map((upload) => [upload.token, upload]));
      const storedFields = {...validation.fields};
      for (const entry of uploadEntries) {
        storedFields[entry.fieldId] = entry.tokens.map((token) => {
          const upload = uploadByToken.get(token)!;
          return `${API.asset(upload.assetId)}?filename=${encodeURIComponent(upload.name)}`;
        });
      }

      const author = databaseFormPrincipal(view.id);
      const submittedAt = new Date().toISOString();
      const marker: DatabaseFormSubmissionMarker = {submittedViaViewId: view.id, submittedAt};
      let pageRow;
      let created;
      try {
        ({page: pageRow, created} = await store.createRow(
          database.id,
          {
            name: validation.name ?? '',
            properties: {
              ...storedFields,
              [FORM_SUBMISSION_PROPERTY_ID]: marker,
            },
          },
          author,
          {
            idempotency: {
              scope: `database-form:${database.id}:${view.id}:${capabilityHash}`,
              key: input.idempotencyKey,
            },
            databaseForm: {
              viewId: view.id,
              capabilityHash,
              maxResponses: responseCap,
            },
          },
        ));
      } catch (err) {
        if (err instanceof DatabaseFormAccessLostError) {
          return c.json({error: 'form not found'}, 404);
        }
        if (err instanceof DatabaseFormResponseLimitError) {
          return c.json({error: 'response limit reached'}, 429);
        }
        throw err;
      }
      const replayTokens = claimed
        .filter((upload) => upload.consumedBy === pageRow.id)
        .map((upload) => upload.token);
      const freshTokens = claimed
        .filter((upload) => upload.consumedBy !== pageRow.id)
        .map((upload) => upload.token);
      if (created) {
        await store.consumeFormUploads(claimed.map((upload) => upload.token), input.idempotencyKey, pageRow.id);
      } else {
        await store.consumeFormUploads(replayTokens, input.idempotencyKey, pageRow.id);
        await store.discardFormUploads(database.pageId, uploadFormId, freshTokens);
      }

      if (created) {
        hub.publishPage(pageRow);
        await broadcastRows(database.id);
        void store.logEdit({
          pageId: pageRow.id,
          author,
          kind: 'database.form.submit',
          summary: view.id,
        }).catch((err) => {
          console.error('OpenBook database-form edit-log write failed:', err);
        });
      }
      const storedMarker = pageRow.properties[FORM_SUBMISSION_PROPERTY_ID];
      const originalSubmittedAt =
        typeof storedMarker === 'object'
        && storedMarker !== null
        && 'submittedAt' in storedMarker
        && typeof storedMarker.submittedAt === 'string'
          ? storedMarker.submittedAt
          : submittedAt;
      const result: FormSubmissionResult = {rowId: pageRow.id, submittedAt: originalSubmittedAt};
      const confirmation = view.formConfig?.confirmation;
      if (confirmation?.type === 'message' && typeof confirmation.message === 'string' && confirmation.message.trim()) {
        result.confirmation = {type: 'message', message: confirmation.message.trim()};
      } else if (confirmation?.type === 'redirect' && typeof confirmation.redirectUrl === 'string') {
        const redirectUrl = safeFormRedirectUrl(confirmation.redirectUrl);
        if (redirectUrl) result.confirmation = {type: 'redirect', redirectUrl};
      }
      return c.json(result, 201);
    },
  );

  app.delete(`${API.databases}/:id`, async (c) => {
    const id = c.req.param('id');
    // Authentication has passed, but a completed destroy leaves no target on
    // which to re-evaluate resource authorization. For this bodyless replay only,
    // the actor-scoped key is the proof; response-bearing routes must authorize first.
    const replay = await executeDurableWrite.probe<null>(c);
    if (replay) return durableWriteResponse(c, replay);
    await requireDbAccess(c, store, 'write', id);
    rejectManaged(id);
    const database = await store.getDatabase(id);
    const response = await executeDurableWrite(c, async (activeStore) => (await activeStore.deleteDatabase(id))
      ? {status: 204, body: null}
      : {status: 404, body: {error: 'database not found'}});
    if (!response.replayed && response.status === 204) {
      // The host page no longer hosts a database; its rows are gone too.
      if (database) {
        const host = await store.getPage(database.pageId);
        if (host) hub.publishPage(host);
      }
      await broadcastList();
    }
    return durableWriteResponse(c, response);
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
    const response = await executeDurableWrite(c, async (activeStore) => ({
      status: 201,
      body: await activeStore.createRow(id, input, c.get('principal')),
    }));
    if (!response.replayed) {
      const page = response.body;
      hub.publishPage(page);
      await broadcastRows(id);
      logEdit(c, page.id, 'row.create');
    }
    return durableWriteResponse(c, response);
  });

  app.put(`${API.databases}/:id/rows/order`, async (c) => {
    const id = c.req.param('id');
    await requireDbAccess(c, store, 'write', id);
    rejectManaged(id);
    const {orderedIds} = await c.req.json<{orderedIds: string[]}>();
    const response = await executeDurableWrite(c, async (activeStore) => {
      await activeStore.reorderRows(id, orderedIds ?? []);
      return {status: 200, body: {ok: true}};
    });
    if (!response.replayed) await broadcastRows(id);
    return durableWriteResponse(c, response);
  });

  app.patch(`${API.databases}/:id/rows/:rowId`, async (c) => {
    const id = c.req.param('id');
    // A row is a page; gate write on the row itself (it may carry its own ACL).
    await requireAccess(c, store, 'write', c.req.param('rowId'));
    rejectManaged(id);
    // Editing an existing row is a direct content edit — gate an agent PAT on the
    // row page's resolved mode (creating a NEW row, like a new page, is exempt).
    await requireAgentDirectWrite(c, c.req.param('rowId'));
    const body = await c.req.json<{name?: string | null; properties?: Record<string, unknown>}>();
    const response = await executeDurableWrite(c, async (activeStore) => {
      const row = await activeStore.updateRow(id, c.req.param('rowId'), body);
      return row
        ? {status: 200, body: row}
        : {status: 404, body: {error: 'row not found'}};
    });
    if (!response.replayed && response.status === 200) {
      const row = response.body as NonNullable<Awaited<ReturnType<typeof store.updateRow>>>;
      await broadcastRows(id);
      logEdit(c, row.id, 'row.update');
    }
    return durableWriteResponse(c, response);
  });

  // ── Ledger: server-enforced double-entry accounting (LGR-3) ─────────────────
  // Thin route skins over `store.ledger` (the LedgerStore — the ONLY writer of
  // ledger rows; the store layer itself rejects every other write path, so
  // browser-local mode is enforced identically). Access rides the restricted
  // host page's decision: readers list/read, writers mutate. Invariant
  // violations surface as typed `{error, code}` bodies via the LedgerError
  // branch in `onError` below. Note the generic page/row routes need NO extra
  // ledger gating here — the store guards throw, and onError maps them to 403.

  /**
   * Resolve the seeded ids + enforce access, or 404 when unseeded.
   *
   * The gate is evaluated on ALL FIVE ledger host pages, not just the root
   * (LGR-3 review nit 4). The generic row-read surface gates each database on
   * its OWN host page, so gating the ledger API on the root alone would make an
   * ACL grant on a single child host (say `Ledger postings`) mean two different
   * things depending on which door the caller used. Requiring the decision on
   * every host keeps one model: access to the ledger API is access to the whole
   * ledger, and a partial grant reads only through the generic row routes it
   * was scoped to.
   */
  const requireLedger = async (c: Context<AppEnv>, need: 'read' | 'write') => {
    const ids = await store.ledgerIds();
    if (!ids) throw new LedgerError('not-initialized', 'the ledger has not been initialized on this library');
    await requireAccess(c, store, need, ids.hostPageId);
    for (const hostPageId of Object.values(ids.hostPages)) {
      await requireAccess(c, store, need, hostPageId);
    }
    return ids;
  };

  /** The unseeded/unreadable ledger body — deliberately IDENTICAL for both, see
   *  the existence-oracle note on `GET /api/ledger`. */
  const NO_LEDGER = {exists: false, hostPageId: null, databases: null};

  app.get(API.ledger, async (c) => {
    const ids = await store.ledgerIds();
    if (!ids) return c.json(NO_LEDGER);
    // Existence-hiding (LGR-3 F7): a caller who cannot read the restricted host
    // gets the SAME `{exists:false}` body an unseeded library returns — not a
    // 404. Answering 200-vs-404 told an unauthorized caller whether this library
    // keeps books at all (and, on a shared instance, that there is something
    // worth attacking). `requireAccess` throws 404 for unreadable, which we
    // convert; any other error propagates.
    try {
      await requireAccess(c, store, 'read', ids.hostPageId);
    } catch (err) {
      if (err instanceof HTTPException && (err.status === 404 || err.status === 403)) return c.json(NO_LEDGER);
      throw err;
    }
    return c.json(await store.ledger.info());
  });

  // Seed (idempotent). Creating the restricted host page + databases is an
  // instance-writer action, like creating at the root.
  //
  // The status is always 200 — a 201-vs-200 split leaked whether books already
  // existed. On the ALREADY-SEEDED branch the response additionally mirrors the
  // GET handler's existence-hiding, so a caller who cannot READ the ledger gets
  // the no-ledger body rather than the host page id and all four database ids.
  //
  // That read gate is DEFENCE IN DEPTH, not a live hole: every role that clears
  // `requireCreate` today (owner / admin / loopback owner, or a guest on an
  // unclaimed write-open instance) also passes the read gate on a restricted
  // page, so no current principal receives the hidden body. It is here so a
  // future create-but-not-read role can't be handed a complete map of a
  // restricted ledger — and the ids grant nothing by themselves in any case, as
  // the store guards and host ACLs gate every actual read and write.
  app.post(API.ledger, async (c) => {
    await requireCreate(c, store);
    const before = await store.ledgerIds();
    const info = await store.ledger.ensureSetup(c.get('principal'));
    if (!before) {
      await broadcastList();
      logEdit(c, info.hostPageId, 'ledger.init');
      return c.json(info);
    }
    try {
      await requireAccess(c, store, 'read', (before as {hostPageId: string}).hostPageId);
    } catch (err) {
      if (err instanceof HTTPException && (err.status === 404 || err.status === 403)) return c.json(NO_LEDGER);
      throw err;
    }
    return c.json(info);
  });

  // LX-4: restore an export's embedded ledger-records section into an EMPTY
  // ledger by replaying it through the ledger writer. Instance-administration
  // gated, the same gate (and rationale) as `importLibrary`: it writes a whole
  // book, and the read-shaped refusal must never 403 the machine owner. A
  // non-empty target refuses with the typed `invalid-state` body (409) via the
  // LedgerError branch in `onError`.
  const LEDGER_SECTION_MAX_BODY_BYTES = 64 * 1024 * 1024;
  app.post(
    API.ledgerRestoreSection,
    bodyLimit({maxSize: LEDGER_SECTION_MAX_BODY_BYTES, onError: (c) => c.json({error: 'request body too large'}, 413)}),
    async (c) => {
      await requireInstanceAdmin(c, store);
      const section = await c.req.json<LedgerExportSection>();
      const before = await store.ledgerIds();
      const result = await store.ledger.restoreExportSection(section, c.get('principal'));
      if (!before) await broadcastList();
      logEdit(c, null, 'ledger.restore', `${result.restored.transactions} entries, ${result.restored.accounts} accounts`);
      return c.json(result);
    },
  );

  app.get(API.ledgerAccounts, async (c) => {
    await requireLedger(c, 'read');
    return c.json(await store.ledger.listAccounts());
  });

  app.post(API.ledgerAccounts, async (c) => {
    const ids = await requireLedger(c, 'write');
    const input = await c.req.json<LedgerAccountInput>();
    const account = await store.ledger.createAccount(input, c.get('principal'));
    await broadcastRows(ids.accounts);
    logEdit(c, account.id, 'ledger.account.create', account.name);
    return c.json(account, 201);
  });

  app.get(`${API.ledgerAccounts}/:id`, async (c) => {
    await requireLedger(c, 'read');
    const account = await store.ledger.getAccount(c.req.param('id'));
    if (!account) return c.json({error: 'account not found', code: 'not-found'}, 404);
    return c.json(account);
  });

  app.patch(`${API.ledgerAccounts}/:id`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const patch = await c.req.json<LedgerAccountPatch>();
    const account = await store.ledger.updateAccount(c.req.param('id'), patch, c.get('principal'));
    await broadcastRows(ids.accounts);
    logEdit(c, account.id, 'ledger.account.update', account.name);
    return c.json(account);
  });

  app.get(API.ledgerTransactions, async (c) => {
    await requireLedger(c, 'read');
    const state = c.req.query('state') as LedgerTransactionState | undefined;
    const limit = Number(c.req.query('limit') ?? NaN);
    return c.json(await store.ledger.listTransactions({state, limit: Number.isFinite(limit) ? limit : undefined}));
  });

  app.post(API.ledgerTransactions, async (c) => {
    const ids = await requireLedger(c, 'write');
    const input = await c.req.json<LedgerDraftInput>();
    const transaction = await store.ledger.createDraft(input, c.get('principal'));
    await broadcastRows(ids.transactions);
    await broadcastRows(ids.postings);
    logEdit(c, transaction.id, 'ledger.transaction.create', transaction.description);
    return c.json(transaction, 201);
  });

  app.get(`${API.ledgerTransactions}/:id`, async (c) => {
    await requireLedger(c, 'read');
    const transaction = await store.ledger.getTransaction(c.req.param('id'));
    if (!transaction) return c.json({error: 'transaction not found', code: 'not-found'}, 404);
    return c.json(transaction);
  });

  app.patch(`${API.ledgerTransactions}/:id`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const patch = await c.req.json<LedgerDraftPatch>();
    const transaction = await store.ledger.updateDraft(c.req.param('id'), patch, c.get('principal'));
    await broadcastRows(ids.transactions);
    await broadcastRows(ids.postings);
    logEdit(c, transaction.id, 'ledger.transaction.update', transaction.description);
    return c.json(transaction);
  });

  app.delete(`${API.ledgerTransactions}/:id`, async (c) => {
    const ids = await requireLedger(c, 'write');
    await store.ledger.deleteDraft(c.req.param('id'), c.get('principal'));
    await broadcastRows(ids.transactions);
    await broadcastRows(ids.postings);
    logEdit(c, c.req.param('id'), 'ledger.transaction.delete');
    return c.body(null, 204);
  });

  app.post(`${API.ledgerTransactions}/:id/post`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const transaction = await store.ledger.post(c.req.param('id'), c.get('principal'));
    await broadcastRows(ids.transactions);
    // The posting rows' projected state changes with the entry too (an open
    // postings view would otherwise keep showing the draft's rows).
    await broadcastRows(ids.postings);
    logEdit(c, transaction.id, 'ledger.transaction.post', `#${transaction.entryNo ?? ''}`);
    return c.json(transaction);
  });

  app.post(`${API.ledgerTransactions}/:id/reverse`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const opts = await c.req.json<LedgerReverseOptions>().catch(() => ({}) as LedgerReverseOptions);
    const transaction = await store.ledger.reverse(c.req.param('id'), opts, c.get('principal'));
    await broadcastRows(ids.transactions);
    await broadcastRows(ids.postings);
    logEdit(c, transaction.id, 'ledger.transaction.reverse', transaction.reverses ?? '');
    return c.json(transaction);
  });

  app.put('/api/ledger/postings/:id/cleared', async (c) => {
    const ids = await requireLedger(c, 'write');
    const {cleared} = await c.req.json<{cleared?: LedgerClearedState}>();
    if (!cleared) return c.json({error: 'a cleared state is required', code: 'invalid-input'}, 400);
    // `reconciled` is unreachable from here in either direction — it is reached
    // only by finishing a reconciliation and left only by reopening one (LGR-11).
    const posting = await store.ledger.setPostingCleared(c.req.param('id'), cleared, c.get('principal'));
    await broadcastRows(ids.postings);
    logEdit(c, posting.id, 'ledger.posting.cleared', cleared);
    return c.json(posting);
  });

  // ── Statement reconciliation (LGR-11) ─────────────────────────────────────
  // Every write goes through `LedgerStore`, which is where the zero-difference
  // gate lives: these routes add authentication and live-view broadcasts, never
  // a second copy of the rule.

  app.get(API.ledgerReconciliations, async (c) => {
    await requireLedger(c, 'read');
    // VALIDATED, not cast: an unrecognised `?status=` must be a 400, never a
    // silent filter that matches nothing and reads as "this account has never
    // been reconciled".
    const raw = c.req.query('status');
    if (raw !== undefined && !(LEDGER_RECONCILIATION_STATUSES as readonly string[]).includes(raw)) {
      return c.json({error: `invalid reconciliation status: ${JSON.stringify(raw)}`, code: 'invalid-input'}, 400);
    }
    const status = raw as LedgerReconciliationStatus | undefined;
    return c.json(await store.ledger.listReconciliations({accountId: c.req.query('accountId'), status}));
  });

  app.post(API.ledgerReconciliations, async (c) => {
    const ids = await requireLedger(c, 'write');
    const input = await c.req.json<LedgerReconciliationInput>();
    const reconciliation = await store.ledger.startReconciliation(input, c.get('principal'));
    await broadcastRows(ids.reconciliations);
    logEdit(c, reconciliation.id, 'ledger.reconciliation.start', reconciliation.statementDate);
    return c.json(reconciliation, 201);
  });

  app.get(`${API.ledgerReconciliations}/:id`, async (c) => {
    await requireLedger(c, 'read');
    const summary = await store.ledger.getReconciliation(c.req.param('id'));
    if (!summary) return c.json({error: 'reconciliation not found', code: 'not-found'}, 404);
    return c.json(summary);
  });

  // AMEND the statement an OPEN reconciliation is matched against (LGR-22).
  // The recovery path for a mistyped closing balance: without it a wrong target
  // can never reach a zero difference, so `finish` is unreachable, `reopen` does
  // not apply to an open record, and `start` refuses a second one — the account
  // is bricked. The "open only", the validation and the recomputation all live
  // in `LedgerStore.amendReconciliation`; this adds auth and broadcasts.
  app.patch(`${API.ledgerReconciliations}/:id`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const patch = await c.req.json<LedgerReconciliationPatch>();
    const summary = await store.ledger.amendReconciliation(c.req.param('id'), patch, c.get('principal'));
    await broadcastRows(ids.reconciliations);
    logEdit(c, summary.reconciliation.id, 'ledger.reconciliation.amend', summary.reconciliation.statementDate);
    return c.json(summary);
  });

  app.put(`${API.ledgerReconciliations}/:id/postings/:postingId`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const {cleared} = await c.req.json<{cleared?: 'pending' | 'cleared'}>();
    if (!cleared) return c.json({error: 'a cleared state is required', code: 'invalid-input'}, 400);
    const summary = await store.ledger.setReconciliationPostingCleared(
      c.req.param('id'),
      c.req.param('postingId'),
      cleared,
      c.get('principal'),
    );
    await broadcastRows(ids.postings);
    logEdit(c, c.req.param('postingId'), 'ledger.reconciliation.match', cleared);
    return c.json(summary);
  });

  app.post(`${API.ledgerReconciliations}/:id/finish`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const summary = await store.ledger.finishReconciliation(c.req.param('id'), c.get('principal'));
    await broadcastRows(ids.reconciliations);
    // The postings' projected cleared state changed too — an open register or
    // reconcile view would otherwise keep showing them as merely `cleared`.
    await broadcastRows(ids.postings);
    logEdit(c, summary.reconciliation.id, 'ledger.reconciliation.finish', summary.reconciliation.statementDate);
    return c.json(summary);
  });

  app.post(`${API.ledgerReconciliations}/:id/reopen`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const summary = await store.ledger.reopenReconciliation(c.req.param('id'), c.get('principal'));
    await broadcastRows(ids.reconciliations);
    await broadcastRows(ids.postings);
    logEdit(c, summary.reconciliation.id, 'ledger.reconciliation.reopen', summary.reconciliation.statementDate);
    return c.json(summary);
  });

  // ABANDON an OPEN reconciliation (LGR-22). No posting broadcast, and that is
  // not an oversight: abandoning writes no posting row, so a `postings`
  // broadcast here would advertise a change that did not happen.
  app.post(`${API.ledgerReconciliations}/:id/abandon`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const reconciliation = await store.ledger.abandonReconciliation(c.req.param('id'), c.get('principal'));
    await broadcastRows(ids.reconciliations);
    logEdit(c, reconciliation.id, 'ledger.reconciliation.abandon', reconciliation.statementDate);
    return c.json(reconciliation);
  });

  // ── Period close (LGR-12) ─────────────────────────────────────────────────
  // The date-range lock, the closing entry and the reopen reversal are all
  // enforced in `LedgerStore` — these routes add authentication and live-view
  // broadcasts, never a second copy of the rule (bypassing the UI changes
  // nothing; `period-closed` comes from the store either way).

  app.get(API.ledgerPeriods, async (c) => {
    await requireLedger(c, 'read');
    return c.json(await store.ledger.listPeriods());
  });

  app.post(API.ledgerPeriods, async (c) => {
    const ids = await requireLedger(c, 'write');
    const input = await c.req.json<LedgerPeriodCloseInput>();
    const result = await store.ledger.closePeriod(input, c.get('principal'));
    if (result.closingEntry) {
      // The closing entry is a real posted transaction — open registers and
      // reports must see it exactly as they see any other post.
      await broadcastRows(ids.transactions);
      await broadcastRows(ids.postings);
    }
    logEdit(c, result.period.id, 'ledger.period.close', `${result.period.start}..${result.period.end}`);
    return c.json(result, 201);
  });

  app.post(`${API.ledgerPeriods}/:id/reopen`, async (c) => {
    const ids = await requireLedger(c, 'write');
    const result = await store.ledger.reopenPeriod(c.req.param('id'), c.get('principal'));
    if (result.reversal) {
      await broadcastRows(ids.transactions);
      await broadcastRows(ids.postings);
    }
    logEdit(c, result.period.id, 'ledger.period.reopen', `${result.period.start}..${result.period.end}`);
    return c.json(result);
  });

  // Canonical postings CSV (LGR-7). Read-gated like every other ledger read;
  // built in-memory (a book is small — see LedgerStore.exportPostingsCsv).
  app.get(API.ledgerExportCsv, async (c) => {
    await requireLedger(c, 'read');
    const csv = await store.ledger.exportPostingsCsv();
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ledger-postings.csv"',
    });
  });

  // Beancount journal (LGR-13). Same gate and same read model as the CSV —
  // one read model, two serializers (see LedgerStore.exportBeancount).
  app.get(API.ledgerExportBeancount, async (c) => {
    await requireLedger(c, 'read');
    const journal = await store.ledger.exportBeancount();
    return c.body(journal, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ledger.beancount"',
    });
  });

  // Independent invariant verifier (LGR-7). Gated `requireInstanceAdmin`
  // (owner/admin/loopback): the report names entity ids across the whole book.
  // A 404 for an unseeded ledger would leak nothing, but the report shape keeps
  // it simple: `initialized:false` + empty findings = trivially clean.
  app.get(API.ledgerVerify, async (c) => {
    await requireInstanceAdmin(c, store);
    return c.json(await store.verifyLedger());
  });

  app.get(API.ledgerAudit, async (c) => {
    await requireLedger(c, 'read');
    const limit = Number(c.req.query('limit') ?? NaN);
    const before = Number(c.req.query('before') ?? NaN);
    return c.json(
      await store.ledger.listAudit({
        limit: Number.isFinite(limit) ? limit : undefined,
        before: Number.isFinite(before) ? before : undefined,
      }),
    );
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

  // STAB-7: the LAN-served web UI catch-all. Mounted LAST so every API/SSE/plugin
  // route above wins (they each return a Response, so Hono never falls through to
  // this handler for them); the handler itself also refuses the `/api` + `/health`
  // surface so an unmatched API path 404s as JSON, not the SPA shell. No-op unless
  // `uiDir` is set — the sidecar's default stays API-only (a UI request 404s).
  if (opts.uiDir) mountUi(app, opts.uiDir);

  app.onError((err, c) => {
    if (err instanceof InvalidIdempotencyInputError) {
      const body: ServerWriteErrorEnvelope<'invalid-input'> = {
        error: err.message,
        code: 'invalid-input',
        retryable: false,
      };
      return c.json(body, 400);
    }
    if (err instanceof IdempotencyKeyReuseError) {
      const body: ServerWriteErrorEnvelope<'idempotency-key-reused'> = {
        error: err.message,
        code: 'idempotency-key-reused',
        retryable: false,
      };
      return c.json(body, 409);
    }
    // Access-gate rejections (requireAccess/requireDbAccess/requireCreate) ride
    // HTTPException; surface them as the JSON `{error}` shape the API uses,
    // preserving the gate's 403/404 (never collapse them to a 500 below).
    if (err instanceof HTTPException) {
      return c.json({error: err.message}, err.status);
    }
    // Ledger rejections (LGR-3): the store-level guards + LedgerStore invariants
    // throw typed LedgerErrors from ANY route that touches a ledger row — the
    // generic page/row mutation routes included, which is exactly how a direct
    // `PATCH /api/databases/:id/rows/:rowId` on a ledger row answers 403 managed.
    // The `code` rides the body so clients re-materialize the typed error.
    if (err instanceof LedgerError) {
      return c.json({error: err.message, code: err.code}, ledgerErrorStatus(err.code));
    }
    // Money-core failures (LGR-2) are caller-input problems, not server faults:
    // a parse/range/currency violation that reaches here is a 400, never a 500.
    // The ledger wraps its own money errors into typed LedgerErrors above; this
    // is the belt-and-braces net for any other money-touching route.
    if (err instanceof MoneyError) {
      return c.json({error: err.message, code: err.code}, 400);
    }
    // Invite-resolution failures (bad email, unresolvable handle) carry their own
    // 400/422 status — surface them in the API `{error}` shape (OB-191).
    if (err instanceof InviteResolutionError) {
      return c.json({error: err.message}, err.status);
    }
    // Backup envelopes are untrusted input. Unsupported future versions,
    // incomplete manifests, and hash/size mismatches are clear 400s, never a
    // generic 500 that could be mistaken for transient restore corruption.
    if (err instanceof BackupFormatError) {
      return c.json({error: err.message}, 400);
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
