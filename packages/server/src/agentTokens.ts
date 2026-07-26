/**
 * Agent Personal-Access-Token primitives (AGENT-6).
 *
 * A PAT is an app-local `Bearer obat_…` credential an instance admin mints to
 * authenticate an OUTWARD agent/MCP HTTP request. Blast radius is ONE instance:
 * revocation is an instant local row delete (no fail-open issuer TTL). The secret
 * is shown exactly once at mint; only its SHA-256 hash is stored.
 *
 * This module is the pure/isomorphic core — the token format, the `agentPrincipal`
 * builder, the request-time bearer extractor, the strict default-deny scope-gate
 * allowlist, the rate limiters, and the dark `agentApi` gate. The store owns the
 * durable rows (see {@link PageStore} CRUD); `app.ts` wires it into the request path.
 *
 * SECURITY posture (see the AGENT-6 security review):
 *  - the PAT is a NEW `verifiedVia` (`'pat'`) — it gets NOTHING by default and only
 *    the SUBJECT-keyed authorize rungs its bound user has (never a roster role, never
 *    an email/persona ACL, never verified block authorship);
 *  - it is header-only (never `?token=`) so it can't leak in URLs / logs / referrers;
 *  - an invalid / revoked / expired token HARD-401s at bearer-routing (never a silent
 *    downgrade to guest);
 *  - the scope-gate is a strict explicit default-deny PATH allowlist (NOT method-
 *    shaped) so the many privileged GETs (export/members/backups/instance/…) stay
 *    denied, with the privileged owner-checks independently jws-gated as defence in
 *    depth;
 *  - PAT auth is DARK by default: it only resolves once an admin enables the
 *    `agentApi` setting AND the `OPENBOOK_AGENT_API=0` kill-switch env is unset.
 */

import {createHash, randomBytes} from 'node:crypto';
import type {Context} from 'hono';
import {API, type AgentTokenScope, type Principal} from '@book.dev/sdk';

/** The token wire prefix — distinct from the account `obk_` DeviceToken so the two
 *  credential classes are never confused at a glance or in a bearer-routing check. */
export const AGENT_TOKEN_PREFIX = 'obat_';

/** The settings key holding the dark on/off flag (default absent ⇒ OFF). */
export const AGENT_API_SETTING_KEY = 'agentApi';

/** Max live (non-revoked) tokens per instance (mirrors the account DeviceToken cap). */
export const AGENT_TOKEN_CAP = 25;

/** Default token lifetime, in days. `null` mints a no-expiry token (with a UI warning). */
export const DEFAULT_AGENT_TOKEN_EXPIRY_DAYS = 90;

/** Default lifetime for a REMOTE-flagged token (AGENT-7, Q-a). Shorter than a local
 *  token: an internet-valid bearer credential must be self-limiting. */
export const DEFAULT_REMOTE_AGENT_TOKEN_EXPIRY_DAYS = 30;
/** Hard maximum lifetime for a REMOTE-flagged token (Q-a). No-expiry is REJECTED. */
export const MAX_REMOTE_AGENT_TOKEN_EXPIRY_DAYS = 90;

/** Per-token request budget (fixed window) before a 429. */
export const AGENT_TOKEN_RATE_LIMIT = 120;
/** Per-IP FAILED-PAT budget (fixed window) so the hash space can't be brute-forced. */
export const AGENT_FAILED_RATE_LIMIT = 10;
/** The fixed rate-limit window, in ms. */
export const AGENT_RATE_WINDOW_MS = 60_000;

/** The persisted shape of the dark `agentApi` setting. */
export interface AgentApiSetting {
  enabled?: boolean;
  /** Whether REMOTE MCP (a forwarded `/api/mcp` over the public edge) is admitted on
   *  this instance (AGENT-7, L6). Default absent ⇒ OFF. Independent second opt-in on
   *  top of {@link enabled} — remote is DARK unless BOTH are on (and the remote
   *  kill-switch env is unset). */
  remote?: boolean;
}

/** The minimal store surface these helpers read (keeps the module store-agnostic). */
interface SettingReader {
  getSetting<T>(key: string): Promise<T | null>;
}

/** The resolved (valid, non-revoked, unexpired) token row `agentPrincipal` needs. */
export interface AgentTokenRow {
  id: string;
  name: string;
  subject: string;
  issuer: string;
  scope: AgentTokenScope;
  /** L7: whether this token may authenticate a FORWARDED `/api/mcp` request. Every
   *  pre-0017 token resolves to `false` (the column defaults false). */
  remoteOk: boolean;
}

/** True when the hard kill-switch env is set — a fleet-wide off switch that wins
 *  over any per-instance setting, so PAT auth can be killed without a DB write. */
export function agentApiKillSwitchOn(): boolean {
  return process.env.OPENBOOK_AGENT_API === '0';
}

/**
 * Whether PAT auth (resolution + minting) is live on this instance: the admin must
 * have enabled the `agentApi` setting AND the kill-switch env must be unset. Default
 * (setting absent) ⇒ OFF — nothing usable until an admin turns it on.
 */
export async function isAgentApiEnabled(store: SettingReader): Promise<boolean> {
  if (agentApiKillSwitchOn()) return false;
  const setting = await store.getSetting<AgentApiSetting>(AGENT_API_SETTING_KEY);
  return setting?.enabled === true;
}

/** True when the DEDICATED remote kill-switch env is set — an off-switch for REMOTE
 *  MCP only (`OPENBOOK_AGENT_MCP_REMOTE=0`) that needs no DB write. The existing
 *  `OPENBOOK_AGENT_API=0` still kills ALL PAT auth (including remote) via
 *  {@link agentApiKillSwitchOn}; this one leaves local PAT auth intact. */
export function agentMcpRemoteKillSwitchOn(): boolean {
  return process.env.OPENBOOK_AGENT_MCP_REMOTE === '0';
}

/**
 * Whether REMOTE MCP (a forwarded `/api/mcp` over the public edge) is live on this
 * instance (AGENT-7, L5 + L6). Requires the WHOLE local PAT stack to be on
 * ({@link isAgentApiEnabled}) AND the `agentApi.remote` setting AND the remote
 * kill-switch env unset. Default (setting absent) ⇒ OFF — remote is dark on top of an
 * already-dark local feature. This is the ONLY setting read for the remote decision;
 * the per-token `remote_ok` flag (L7) is the other conjunct, checked at resolution.
 */
export async function isAgentRemoteEnabled(store: SettingReader): Promise<boolean> {
  if (agentMcpRemoteKillSwitchOn()) return false;
  if (!(await isAgentApiEnabled(store))) return false;
  const setting = await store.getSetting<AgentApiSetting>(AGENT_API_SETTING_KEY);
  return setting?.remote === true;
}

/** True when the self-host direct-dial hardening env is set (`OPENBOOK_REQUIRE_REMOTE_FLAG`).
 *  When set, the origin requires the remote conjunction (remote-enabled + `remote_ok`)
 *  for a PAT EVEN IF the forwarded marker is absent — closing the residual where a PAT
 *  is dialed straight at an internet-exposed self-host origin that never crosses the
 *  edge (T2). Default off (back-compatible): a self-hoster opts in. Does NOT narrow the
 *  path (unlike a forwarded request), so an admitted remote token's in-process
 *  loop-back calls to `/api/pages` etc. still resolve. */
export function agentRequireRemoteFlagOn(): boolean {
  const v = process.env.OPENBOOK_REQUIRE_REMOTE_FLAG;
  return v !== undefined && v !== '' && v !== '0';
}

/**
 * The REMOTE-MCP admission predicate, shared by the principal middleware and the
 * `/api/mcp` handler so the two enforcement points can NEVER drift (design §3.4.5).
 * A forwarded PAT is admitted ONLY on the exact `/api/mcp` path (never a sub-path or
 * a prefix sibling), ONLY when remote MCP is enabled on the instance, and ONLY for a
 * token whose row carries `remote_ok`. Any leg false ⇒ not admitted.
 */
export async function remoteMcpAdmitted(c: Context, store: SettingReader, remoteOk: boolean): Promise<boolean> {
  if (c.req.path !== API.mcp) return false;
  if (!remoteOk) return false;
  return isAgentRemoteEnabled(store);
}

/** SHA-256 hex of a presented token — the at-rest lookup key. The token is the
 *  preimage, so an attacker can't reverse a stolen hash into a usable credential. */
export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A freshly minted token: the plaintext (shown ONCE), its at-rest hash, and a short
 *  non-secret preview for later recognition in the management UI. */
export interface GeneratedAgentToken {
  token: string;
  hash: string;
  preview: string;
}

/** Mint a new `obat_`-prefixed token: 32 bytes of CSPRNG entropy, base64url. */
export function generateAgentToken(): GeneratedAgentToken {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {token, hash: hashAgentToken(token), preview: agentTokenPreview(token)};
}

/** A short, non-secret prefix used for recognition (`obat_` + first 6 chars + `…`). */
export function agentTokenPreview(token: string): string {
  return `${token.slice(0, AGENT_TOKEN_PREFIX.length + 6)}…`;
}

/**
 * Build the request-time principal for a resolved token row. NO email (so it can
 * never match an email/persona ACL, by construction), `verifiedVia: 'pat'`, and the
 * token id in `assertion.kid` so the edit log records WHICH token authored a change.
 * The subject/issuer are the ones bound AT MINT (the minter's own verified identity),
 * never anything the presenter can influence.
 */
export function agentPrincipal(row: AgentTokenRow): Principal {
  return {
    kind: 'user',
    subject: row.subject,
    issuer: row.issuer,
    name: row.name ? `${row.name} (agent)` : 'Agent token',
    verifiedVia: 'pat',
    assertion: {kid: row.id},
  };
}

/**
 * Extract a `Bearer obat_…` agent token from the request — HEADER ONLY. A PAT is
 * NEVER accepted via `?token=`/query (requirement: no PAT in URLs/logs/referrers,
 * and the SSE query-token seam must not become a PAT leak). Returns the raw token or
 * `null` when the request carries no agent bearer.
 */
export function bearerAgentToken(c: Context): string | null {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.startsWith(AGENT_TOKEN_PREFIX) && token.length > AGENT_TOKEN_PREFIX.length ? token : null;
}

// ── The scope-gate: a strict explicit default-deny PATH allowlist ─────────────────
//
// Deliberately PATH-shaped, NOT method-shaped: "any GET is a read" is WRONG here —
// export/members/backups/instance/library-sync/plugins/ai-status are all privileged
// GETs. Everything not explicitly listed is DENIED. A `read` token additionally
// physically cannot issue an unsafe method (they're absent from its allowlist), so
// `authorize()` needs no scope plumbing — the HTTP scope-gate is the write ceiling.

/** Read allowlist: content GETs the bound user could read (all still re-gated per
 *  page by `requireAccess`), plus the two live SSE channels. */
const READ_PREFIXES = ['/api/pages', '/api/databases', '/api/trash', '/api/assets'];
const READ_EXACT = ['/api/live', '/api/stream'];
/** Write allowlist adds unsafe methods on these content collections. Database schema
 *  create/edit/delete is intentionally EXCLUDED (only ROWS — see the regex below). */
const WRITE_PREFIXES = ['/api/pages', '/api/suggestions', '/api/comments', '/api/assets'];
/** Database ROW routes (`/api/databases/:id/rows[...]`) — write-allowed, unlike the
 *  database's own schema routes. */
const DB_ROWS_RE = /^\/api\/databases\/[^/]+\/rows(\/.*)?$/;

/**
 * Page SHARING / EXPOSURE sub-paths (`…/acl`, `…/visibility`). DENIED for ANY PAT of
 * ANY scope, even though they sit under the `/api/pages` prefix: they gate only on
 * page-write, so a write-PAT would otherwise re-share a page (a durable grant that
 * SURVIVES the token's revocation — a permanent backdoor) or flip a restricted page
 * to `public` (a confidentiality break). Carved out here AND independently refused at
 * the two handlers (`denyPatPolicy`). */
const SHARING_CONTROL_RE = /\/(acl|visibility)$/;

/**
 * Page AGENT-EDITS policy sub-path (`…/agent-edits`, AGED-1). The WRITE is jws-only —
 * a PAT setting `agentEdits='direct'` would be self-authorization (the token relaxing
 * the policy that governs whether agents may edit that page directly). Unlike the
 * sharing controls, the GET is a normal read (any principal that can read the page,
 * so a read-PAT may observe the policy), so only UNSAFE methods are carved out here.
 * Also independently refused at the PUT handler (`denyPatPolicy`). */
const AGENT_EDITS_CONTROL_RE = /\/agent-edits$/;

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** `path === base` or a child under `base/…` — never a `base`-prefixed sibling. */
function pathUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

function readAllowed(method: string, path: string): boolean {
  // ALL of `/api/mcp` (AGENT-5's transport, which re-gates read/write internally).
  if (pathUnder(path, API.mcp)) return true;
  if (isSafeMethod(method)) {
    if (READ_EXACT.includes(path)) return true;
    return READ_PREFIXES.some((base) => pathUnder(path, base));
  }
  // The sole non-safe READ: lexical note search.
  return method === 'POST' && path === API.aiSearch;
}

function writeAllowed(method: string, path: string): boolean {
  if (readAllowed(method, path)) return true; // write ⊇ read
  if (isSafeMethod(method)) return false; // any other GET stays denied
  if (WRITE_PREFIXES.some((base) => pathUnder(path, base))) return true;
  return DB_ROWS_RE.test(path);
}

/**
 * The scope-gate decision for a `pat` request: may `scope` reach `method path`?
 * Default-deny — an unlisted route is refused. `OPTIONS` (CORS preflight) always
 * passes (it carries no credentials/effects).
 */
export function agentScopeAllows(scope: AgentTokenScope, method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  // Sharing/exposure controls are NEVER a PAT surface — deny for any scope/method.
  if (SHARING_CONTROL_RE.test(path)) return false;
  // Agent-edits POLICY: the WRITE is jws-only (self-authorization guard); the GET is
  // a normal page read, so only deny the unsafe methods here.
  if (AGENT_EDITS_CONTROL_RE.test(path) && !isSafeMethod(method)) return false;
  return scope === 'write' ? writeAllowed(method, path) : readAllowed(method, path);
}

/**
 * A tiny in-process fixed-window rate limiter. The native server is single-process
 * (desktop sidecar / a single node), so an in-memory window is sufficient and needs
 * no external store. Keyed by token id (per-token budget) or client IP (failed-PAT
 * budget). Not shared across a horizontally-scaled deployment — acceptable for the
 * loopback/LAN Wave-2 posture (a forwarded `/api/mcp` is refused separately).
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, {count: number; resetAt: number}>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /**
   * Read-only: is `key` ALREADY over the limit in the current window, WITHOUT
   * recording a hit? Used for the remote-MCP early-429 (design §3.4.7) so a
   * garbage-PAT flood is shed BEFORE the expensive SHA-256 + DB lookup, while a
   * VALID token's traffic never touches (increments) the failed-PAT bucket.
   */
  peek(key: string, now: number = Date.now()): boolean {
    const cur = this.hits.get(key);
    return !!cur && now < cur.resetAt && cur.count > this.limit;
  }

  /** Record one hit for `key`; returns true when it is now OVER the limit. */
  exceeded(key: string, now: number = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || now >= cur.resetAt) {
      this.hits.set(key, {count: 1, resetAt: now + this.windowMs});
      if (this.hits.size > 4096) this.prune(now);
      return false;
    }
    cur.count += 1;
    return cur.count > this.limit;
  }

  private prune(now: number): void {
    for (const [key, value] of this.hits) if (now >= value.resetAt) this.hits.delete(key);
  }
}

/**
 * Best-effort peer key for the per-IP FAILED-PAT limiter — a coarse DoS backstop.
 *
 * The REAL brute-force control is the token's 256-bit entropy: an attacker cannot
 * enumerate `obat_` values, so this limiter only exists to stop a flood from churning
 * the hash lookup. It is therefore keyed on the SOCKET PEER address where the runtime
 * exposes it (the Node adapter's `c.env.incoming.socket.remoteAddress`), NEVER the
 * client-supplied `x-forwarded-for` (trivially spoofable to spread across buckets and
 * defeat the limit). Forwarded PAT requests are rejected outright at resolution, so no
 * legitimate PAT traffic carries a proxy hop anyway. When the peer is unavailable
 * (in-process `app.request`, some adapters) failures collapse into one bucket.
 */
export function clientIpKey(c: Context): string {
  try {
    const env = c.env as {incoming?: {socket?: {remoteAddress?: string}}} | undefined;
    const peer = env?.incoming?.socket?.remoteAddress;
    if (peer) return peer;
  } catch {
    // Adapter without a Node-style socket — fall through to the shared bucket.
  }
  return 'peer';
}
