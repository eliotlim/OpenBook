/**
 * OpenBook domain types — the single source of truth shared by the server, the
 * desktop app, and the web shell. Because every layer imports these same
 * definitions, page data cannot drift between client and server.
 *
 * A **page** is the unit of storage: a stable UUID, an optional display name
 * (not unique — identity is always the id), and an opaque document payload
 * ({@link PageSnapshot}). The storage layer treats `data` as opaque JSON; its
 * internal shape is owned by the document editor.
 */

/**
 * The serialized form of a reactive document. Three sibling keys:
 *  - `editorjs` — the block-native export projection (`{blocks}`), and for
 *    legacy pages the stored block list. **The JSON key name `editorjs` is a
 *    RETAINED storage / back-compat alias** — do not rename it on disk; every
 *    persisted snapshot uses it and renaming would strand stored data. In
 *    memory this shape is `ExportDoc` (see ui `exportBlocks.ts`). Kept opaque
 *    here so the SDK has no dependency on the editor; cast at the edit site.
 *  - `values`   — `[cellId, value]` pairs from the reactive store.
 *  - `names`    — `[name, cellId]` pairs (the name index).
 */
export interface PageSnapshot {
  /** Retained storage/back-compat alias for the export projection; see doc above. */
  editorjs: unknown;
  values: Array<[string, unknown]>;
  names: Array<[string, string]>;
  /** Which editor owns this document ('blocks' = the CRDT block editor). */
  editor?: string;
  /** CRDT block-editor document (opaque here; shaped by the ui package). */
  blockdoc?: unknown;
  /**
   * `[blockId, ISO mtime]` pairs — when each top-level block last changed. The
   * server stamps these on write (see sdk `stampSnapshotMtimes`): a block whose
   * content is unchanged keeps its old timestamp, a changed/new one is restamped
   * `now`. This is the per-block change signal the on-disk book mirror, the
   * external-change watcher, and conflict detection all read; absent on pages
   * written before the feature shipped (treated as "unknown — assume changed").
   */
  mtimes?: Array<[string, string]>;
  /**
   * `[blockId, subject]` pairs — the *verified* author (`iss#sub`) who last
   * changed each block, a sparse map carried with the snapshot so an edit is
   * still correctly attributed after it syncs to another instance (OB-170). The
   * server stamps it on write from the request's verified principal; only
   * verified identities appear (guest/local/unverified edits are not recorded
   * here). Absent on single-user / unverified documents. See sdk `authors.ts`.
   */
  authors?: Array<[string, string]>;
}

/** An empty snapshot, for initializing a brand-new page. */
export const emptyPageSnapshot = (): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
});

/** Lightweight page record for listings (no `data` payload). */
export interface PageMeta {
  id: string;
  name: string | null;
  /** The page's emoji icon, or `null` when none is set — projected from
   *  `page.properties` so lists (sidebar, tabs, mentions) resolve it directly,
   *  without a per-page fetch. */
  icon: string | null;
  /**
   * If this page *hosts* a database (contains a collection of row pages), the
   * id of that database; otherwise `null`. Lets the sidebar mark database
   * pages and the document area decide whether to render the database view.
   */
  hostedDatabaseId: string | null;
  /** The page this page is nested under, if any (drives the sidebar tree). */
  parentId: string | null;
  /**
   * When the page is in the trash (soft-deleted), the ISO timestamp it was
   * deleted; `null` for live pages. Trash listings carry this so the UI can
   * show how long ago each item was deleted.
   */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One node in the page-link graph — a live page (standalone or database row). */
export interface PageGraphNode {
  id: string;
  name: string | null;
  /** The page's emoji icon, or `null`/absent when none is set. */
  icon?: string | null;
}

/**
 * A directed link between two pages in the graph. `kind` distinguishes an inline
 * `@`-mention in the source page's document (`'mention'`) from a structured
 * relation reference in its properties (`'relation'`), so the two can be rendered
 * distinctly.
 */
export interface PageGraphEdge {
  from: string;
  to: string;
  kind: 'mention' | 'relation';
}

/**
 * The whole page-link graph: every live, readable page as a node, plus every
 * directed link (mention or relation) whose BOTH endpoints are readable by the
 * requesting principal. Edges are computed on the fly from page content +
 * properties (no persisted edge table); self-loops and edges to missing/deleted
 * pages are dropped.
 */
export interface PageGraph {
  nodes: PageGraphNode[];
  edges: PageGraphEdge[];
}

/** A full page as returned by the store. `data` is the document snapshot. */
export interface StoredPage {
  id: string;
  name: string | null;
  data: PageSnapshot;
  /** The database this page *hosts*, if any (mirrors {@link PageMeta.hostedDatabaseId}). */
  hostedDatabaseId: string | null;
  /** The database this page is a *row* of, if any; `null` for ordinary pages. */
  databaseId: string | null;
  /** The page this page is nested under, if any. */
  parentId: string | null;
  /** Manual database-property values, keyed by property id (empty for non-rows). */
  properties: Record<string, unknown>;
  /** When the page is in the trash, the ISO timestamp it was deleted; else `null`. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Metadata for one captured page version (PVH-1) — no snapshot payload, so a
 * history list stays cheap. `author*` is the verified principal who *superseded*
 * the captured state (the one who saved over it); all three are `null` for a
 * server-merged checkpoint, which has no single saving principal.
 */
export interface PageVersionMeta {
  id: string;
  pageId: string;
  authorSubject: string | null;
  authorIssuer: string | null;
  authorName: string | null;
  createdAt: string;
}

/**
 * A captured page version WITH its snapshot payload — the state to roll back TO.
 * Restoring one writes this `data` back through the normal save path, which
 * captures the pre-restore state as a new version (so restore is non-destructive).
 */
export interface StoredPageVersion extends PageVersionMeta {
  data: PageSnapshot;
}

/**
 * Payload for creating/updating a page.
 *  - `id` present → upsert that page; absent → create with a fresh server id.
 *  - `name` optional; a display label, not unique (pages are identified by id).
 *
 * Note: a page's database membership (`databaseId`) and manual `properties` are
 * not set through this payload — they are managed by the database row APIs so a
 * routine content save never clobbers them.
 */
export interface PageInput {
  id?: string;
  name?: string | null;
  data: PageSnapshot;
  /**
   * The page to nest this new page under. Applied only when the page is first
   * created; a later content save with the same id leaves the parent untouched.
   */
  parentId?: string | null;
  /**
   * Optional client idempotency key for the **create** path (no `id`). A retried/
   * replayed keyless create carrying the same key returns the page the first call
   * minted instead of a duplicate (ER-7). Ignored when `id` is present (an id-bearing
   * upsert is already idempotent via the store's `ON CONFLICT` no-op). Scoped to the
   * server-resolved principal, so one user's key never collides with another's. Not
   * persisted on the page — it only keys the dedup ledger.
   */
  idempotencyKey?: string;
}

/**
 * Sharing & access model (OB-188; contract docs/sharing-access-contract-spike-OB-182.md).
 * These are the data-model types behind migration 0011 — the roster row, the
 * per-page ACL row, and the per-page visibility scope. The *authorization* layer
 * (`authorize()` in §1.1) is OB-189 and is intentionally NOT defined here.
 */

/**
 * Per-page audience scope (OB-182 §1.1). `inherit` resolves up the **parent**
 * chain for an ordinary page (or, for a database row, via the database host page)
 * down to `InstanceConfig.defaultVisibility` at the root. The other four are the
 * fixed audience scopes: `public` (anyone, incl. anonymous), `authenticated` (any
 * signed-in jws user), `members` (active roster members), `restricted`
 * (owner/admin/ACL only).
 */
export type PageVisibility = 'inherit' | 'public' | 'authenticated' | 'members' | 'restricted';

/** Alias for {@link PageVisibility} (the OB-188 directive's shorthand name). */
export type Visibility = PageVisibility;

/** Every {@link PageVisibility} value, in escalating-privacy order — the source of
 *  truth for server-side validation and the share dialog's scope picker. */
export const PAGE_VISIBILITIES: readonly PageVisibility[] = [
  'inherit',
  'public',
  'authenticated',
  'members',
  'restricted',
];

/**
 * The two INSTANCE-level agent-edits modes (AGED-1). Governs whether an agent (an
 * MCP tool or the built-in AI) writes a page DIRECTLY or persists its change as a
 * suggestion for a human to accept. `suggest` is the safe default; `direct` opts the
 * whole instance into unattended agent edits. This is the resolved (effective) shape
 * — never `inherit`, which is a page-level pointer at this instance mode.
 */
export type AgentEditsMode = 'suggest' | 'direct';

/**
 * A PAGE's agent-edits policy (AGED-1). `inherit` (the default) defers to the
 * instance's {@link AgentEditsMode}; `suggest` / `direct` override it for this page.
 * Resolve to an effective {@link AgentEditsMode} with {@link resolveAgentEdits}.
 */
export type AgentEditsPolicy = 'inherit' | 'suggest' | 'direct';

/** Every {@link AgentEditsMode} — the source of truth for validating an instance
 *  policy write (`PUT /api/instance`). */
export const AGENT_EDITS_MODES: readonly AgentEditsMode[] = ['suggest', 'direct'];

/** Every {@link AgentEditsPolicy} — the source of truth for validating a page policy
 *  write (`PUT /api/pages/:id/agent-edits`). */
export const AGENT_EDITS_POLICIES: readonly AgentEditsPolicy[] = ['inherit', 'suggest', 'direct'];

/**
 * Resolve a page's agent-edits policy against the instance mode into the ONE
 * effective {@link AgentEditsMode} (AGED-1 — the single source of truth shared by the
 * server, the MCP layer, and the UI). Precedence: an explicit page policy
 * (`suggest` / `direct`) wins; otherwise the instance mode; otherwise the safe
 * `suggest` default (a pre-AGED-1 / unset instance, or `page='inherit'` with no
 * instance mode). Never returns `inherit`.
 */
export function resolveAgentEdits(
  page: AgentEditsPolicy,
  instance: AgentEditsMode | undefined,
): AgentEditsMode {
  if (page === 'suggest' || page === 'direct') return page;
  return instance ?? 'suggest';
}

/** The two OSS roster roles (OB-182): `admin` = full access, `viewer` = locked
 *  read-only. (Contract §1.1 names this union `Role`.) */
export type MemberRole = 'admin' | 'viewer';

/**
 * The caller's *effective* instance role (P1-8) — the roster roles plus `owner`,
 * the rung the roster can't express: the claimed owner (`jws` &&
 * `subject===ownerSubject`) or the loopback owner (`verifiedVia==='local'`, the
 * in-webview single-user path — a request-borne principal is never `local`).
 * Returned as {@link InstanceInfo.youRole} so a client can render read-only viewer
 * chrome (OB-205) or the manage-sharing entry without a second probe. UI-only — the
 * server's `authorize()` remains the sole write enforcement.
 */
export type EffectiveRole = 'owner' | MemberRole;

/**
 * Lifecycle of a roster row (OB-182 §2.1). `invited` = an email persona not yet
 * claimed by a signed-in subject; `active` = bound + live; `suspended` = retained
 * but grants nothing. Only `active` rows resolve to a role at request time (S3).
 */
export type MemberStatus = 'invited' | 'active' | 'suspended';

/**
 * Where a roster row came from (OB-199). `local` = a locally-issued invite (the
 * OB-191 path); `managed` = projected from the bound account library's roster by
 * the periodic sync. The two coexist: the managed sync only ever touches `managed`
 * rows, so a local invite is never clobbered (and vice-versa).
 */
export type MemberSource = 'local' | 'managed';

/** Per-page ACL grant level (OB-182 §1.1). */
export type AclLevel = 'read' | 'write';

/**
 * One roster row — the data-server-native `members` table (OB-182 §2.1). A row is
 * either an EMAIL PERSONA (`email` set, `subject` NULL until claimed on sign-in)
 * or a SUBJECT/handle MEMBER (`subject` set, `email` NULL). One account `subject`
 * may back several persona rows — one per verified email — each its own member
 * with its own role. `issuer` PINS the email-authority for a persona so a federated
 * issuer can never satisfy an `account.book.pub`-scoped grant (B1).
 */
export interface Member {
  id: string;
  /** Bound `iss#sub`; `null` until an email persona is claimed. */
  subject: string | null;
  /** Persona email (lowercased); `null` for a subject/handle member. */
  email: string | null;
  /** The pinned email-authority issuer for a persona (B1). */
  issuer: string;
  role: MemberRole;
  status: MemberStatus;
  /**
   * Provenance of the row (OB-199): `local` for a locally-issued invite (OB-191),
   * `managed` for a row projected from the bound library roster. Defaults to
   * `local`; the managed sync only ever writes/removes `managed` rows.
   * Optional: absent (a pre-OB-199 row / a test fixture) is treated as `local`.
   */
  source?: MemberSource;
  /** The principal subject that issued the invite, if any. */
  invitedBy: string | null;
  createdAt: string;
}

/**
 * One per-page ACL grant — a row of the `page_acl` table (OB-182 §2.3). Exactly
 * one grantee key is set: `subject` (a grantee already bound to any trusted issuer)
 * XOR `email` (a grantee by persona email, lowercased). An email grant MUST pin an
 * `issuer` (the email-authority — B1).
 */
export interface PageAcl {
  pageId: string;
  subject: string | null;
  email: string | null;
  issuer: string | null;
  level: AclLevel;
  invitedBy: string | null;
  createdAt: string;
}

/** Status of a desktop install's local server. */
export interface ServerInfo {
  /** Whether the local server is currently running. */
  running: boolean;
  /** Bound base URL the local UI connects to, when running (loopback). */
  address: string | null;
  /**
   * Whether the host process manages the local server lifecycle (true in the
   * packaged desktop app). When false (e.g. dev, or the web shell), the server
   * is external and start/stop are unavailable.
   */
  managed: boolean;
  /**
   * Whether the server is published on the LAN (bound beyond loopback). When
   * true, the library is reachable by other devices at {@link lanAddress} and the
   * sidecar also serves the web UI there. The LAN bind is TOKENLESS (STAB-7): the
   * only gate is the library's guest-access setting (write/read/off). Off by default.
   */
  published?: boolean;
  /** The shareable LAN URL (`http://<ip>:<port>`) when published; else null. */
  lanAddress?: string | null;
  /** Folder the on-disk book mirror writes to (durable mode). */
  bookDir?: string | null;
  /**
   * Whether the host also binds a loopback TCP listener (`127.0.0.1:4319`) on the
   * same sidecar so an out-of-process local MCP/agent connector can reach this
   * exact library (STAB-5). Gated on the local-MCP/agent toggle — OFF by default,
   * and independent of {@link published} (which binds `0.0.0.0` for the LAN).
   * Unlike the FS-permissioned IPC socket, this loopback listener is reachable by
   * any local process AND by any web origin the user's browser will POST to (the
   * sidecar serves wildcard CORS and guestAccess defaults to 'write') — a real
   * added surface, hence the explicit opt-in toggle; browser-reachability
   * hardening is tracked separately. */
  agentLocalTcp?: boolean;
}

/**
 * Controls for the host-managed local server, provided by the platform layer
 * (the Tauri desktop app). Absent on the web, where there is no local server.
 */
export interface ServerControls {
  info(): Promise<ServerInfo>;
  /** Legacy lifecycle hooks. The desktop now keeps the local server always-on
   *  over IPC, so these are optional and unused there. */
  start?(): Promise<ServerInfo>;
  stop?(): Promise<ServerInfo>;
  /** Publish (or unpublish) the server on the LAN — adds the `0.0.0.0` bind and
   *  serves the web UI there. Tokenless (STAB-7): the library's guest-access
   *  setting is the only gate. The local UI keeps using IPC; resolves the new
   *  status. */
  publish?(enabled: boolean): Promise<ServerInfo>;
  /** Open a native folder picker to choose the book-mirror directory. Resolves
   *  the new status (with the chosen `bookDir`), or unchanged if cancelled. */
  chooseBookDir?(): Promise<ServerInfo>;
  /** Reveal the current book-mirror directory in the OS file manager. */
  revealBookDir?(): Promise<void>;
  /**
   * Bind (or unbind) the loopback TCP listener (`127.0.0.1:4319`) used by an
   * out-of-process local MCP/agent connector (STAB-5). Flipped together with the
   * agent-API toggle so the connector's default endpoint actually points at THIS
   * library's server. Resolves the new status (with {@link ServerInfo.agentLocalTcp}).
   * Absent on the web / an old host that predates the capability. */
  setAgentLocalTcp?(enabled: boolean): Promise<ServerInfo>;
}
