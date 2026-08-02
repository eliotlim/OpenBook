/**
 * Multi-user instance policy + change provenance (OB-165). The contract the
 * server and clients share for: the guest-access gate, the set of trusted
 * identity issuers, and the durable per-change edit log.
 *
 * Design: `docs/multi-user-and-backups-2026-06.md`.
 */

import {DEFAULT_ACCOUNT_URL} from './account';
import type {Jwks, Principal, RevocationSet, VerifiedVia} from './identity';
import type {AgentEditsMode, EffectiveRole, MemberRole, PageVisibility} from './types';

/** What an unauthenticated (guest) caller may do on this instance. */
export type GuestAccess =
  /** Guests are rejected entirely (sign-in required). */
  | 'off'
  /** Guests may read, but not write. */
  | 'read'
  /** Guests may read and write (the default — same as a no-login library today). */
  | 'write';

/** An identity issuer this instance trusts (issuer-rooted federation). */
export interface TrustedIssuerConfig {
  /** The `iss` claim this config authorizes. */
  issuer: string;
  /** Where to (re)fetch the issuer's JWKS for online refresh. */
  jwksUrl?: string;
  /** Inline / cached JWKS — makes verification offline-capable (and is how the
   *  dev issuer ships its key). */
  jwks?: Jwks;
  /**
   * Where to (re)fetch the issuer's revocation document (OB-106) — an EdDSA-signed
   * JWS verified against the issuer's JWKS. Polled + cached like {@link jwksUrl},
   * with a last-good offline fallback. Absent ⇒ this issuer publishes no
   * revocations and every signature-valid, in-window token is honoured.
   */
  revocationsUrl?: string;
  /**
   * Inline / cached revocation set — config-trusted (like an inline {@link jwks}),
   * so it needs no signature check. Mainly for the dev issuer and tests; the real
   * account issuer ships a signed document via {@link revocationsUrl}.
   */
  revocations?: RevocationSet;
}

/** The instance's multi-user policy, persisted in the `settings` table. */
export interface InstanceConfig {
  guestAccess: GuestAccess;
  /**
   * Instance-wide agent-edits mode (AGED-1): whether an agent (an MCP tool or the
   * built-in AI) writes a page DIRECTLY or persists its change as a suggestion for a
   * human to accept. Defaults to `'suggest'` (the safe default — no unattended agent
   * edits). A page may override this per-page via its `agentEdits` policy; the
   * effective decision is {@link resolveAgentEdits}. This is the CONTRACT only — no
   * behaviour reads it yet (AGED-3/4 wire the MCP / AI layers to it).
   */
  agentEdits: AgentEditsMode;
  /**
   * A stable, opaque per-library identifier (STAB-5). Minted once at first
   * startup and persisted; it authorizes NOTHING (like {@link ownerSubject}, it's
   * a non-secret coordinate) and only exists so an out-of-process connector can
   * confirm it reached THIS library's server rather than a foreign responder that
   * happens to answer on the same loopback port (e.g. a stale `pnpm dev`). Surfaced
   * on `GET /api/instance` as {@link InstanceInfo.instanceId}. Absent on a
   * pre-STAB-5 config until the next boot's {@link ensureInstanceId} mints it.
   */
  instanceId?: string;
  /** The principal subject that administers this instance, once claimed. */
  ownerSubject?: string;
  trustedIssuers: TrustedIssuerConfig[];
  /**
   * This server's own audience identifier (OB-177). When set, an identity token
   * scoped to a *different* audience is rejected, and clients should request a
   * token bound to this value. Leave unset for the single-server model.
   */
  audience?: string;
  /** Require every identity token to be audience-bound to {@link audience}
   *  (reject unscoped tokens). Multi-server hardening. */
  requireAudience?: boolean;
  /**
   * Default audience scope a page's `visibility='inherit'` resolves to at the root
   * (OB-182 §2.4, Fork 1). Set to `'members'` (private) when the instance is
   * claimed; an unclaimed instance never reaches the access path. Never `'inherit'`.
   */
  defaultVisibility?: Exclude<PageVisibility, 'inherit'>;
  /**
   * The ONE issuer whose `email` claim is trusted for persona / email-ACL matching
   * (OB-182 §2.4, B1). Subject-based grants work for any {@link trustedIssuers}
   * entry, but only a token from `emailAuthority` can satisfy an email persona or
   * an email ACL. Must be one of {@link trustedIssuers} or every email grant
   * silently (and safely) stops matching. Defaults to account.book.pub.
   */
  emailAuthority?: string;
  /**
   * When this instance is a MANAGED library (OB-199), the account library it
   * is bound to. Set, the periodic roster sync projects that library's roster
   * (admins / viewers + the library owner) into the local `members` table so
   * `members`-scope + admin/viewer roles resolve for direct (non-edge) access too.
   * Unset ⇒ a standalone instance; the sync is inert. Additive — absence is the
   * pre-OB-199 single-instance behaviour. Holds non-secret COORDINATES only; the
   * credential the instance presents to read the roster is supplied out-of-band
   * (never persisted in policy). See {@link LibraryBinding}.
   */
  libraryBinding?: LibraryBinding;
  /**
   * Ledger auto-export (LGR-7 insurance): absolute file path the server writes
   * the canonical postings CSV to (atomically, debounced) after any ledger
   * mutation. Unset / null ⇒ OFF (the default — no ambient file writes).
   * Owner-only to change, like every other instance-policy field: the path is
   * a server-side filesystem write target.
   */
  ledgerAutoExportPath?: string | null;
}

/**
 * Binds a managed instance to an account library (OB-199; LIB-5 renamed from
 * `WorkspaceBinding`). Non-secret coordinates only — the roster-read credential is
 * injected at runtime, never stored here. Set by the owner (via the instance-policy
 * route) or learned during the forwarding/claim flow.
 */
export interface LibraryBinding {
  /** The account library id this instance serves (renamed from `workspaceId`; SAME id value). */
  libraryId: string;
  /**
   * Base URL of the account that owns the library (where the roster lives).
   * Defaults to the instance `emailAuthority` (account.book.pub) when omitted.
   */
  accountBaseUrl?: string;
}

/**
 * One entry of the account library roster (OB-197 contract; LIB-5 renamed from
 * `WorkspaceRosterEntry`), as consumed by the OB-199 sync. Identifies a member by a
 * bound `subject` (`iss#sub`) and/or a persona `email`, with the library role. The
 * account is the producer; the instance only reads this shape (it never writes the
 * account).
 */
export interface LibraryRosterEntry {
  /** Bound `iss#sub` of the member, when the account exposes it. */
  subject?: string;
  /** Persona email (any case; lowercased on sync). */
  email?: string;
  role: MemberRole;
}

/**
 * The account library roster returned by `GET /api/libraries/:id/roster`
 * (OB-197; LIB-5 renamed from `WorkspaceRoster`), as consumed by the OB-199 sync.
 * `ownerSubject` is the library owner's bound subject (`iss#sub`) — admitted as an
 * admin even when it differs from the instance's own site owner (OB-198 F2), so the
 * library owner is never locked out of a library they own.
 */
export interface LibraryRoster {
  /** The account library id (renamed from `workspaceId`; SAME id value). */
  libraryId: string;
  /** Bound `iss#sub` of the library owner (admitted as admin). */
  ownerSubject?: string;
  members: LibraryRosterEntry[];
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  guestAccess: 'write',
  // Agents SUGGEST by default (AGED-1) — no unattended direct edits until the owner
  // opts the instance (or a page) into `'direct'`.
  agentEdits: 'suggest',
  // Trust account.book.pub out of the box — it's the OpenBook identity authority
  // (the shared root that makes identities federate across instances). Only ever
  // consulted when an `iss=account.book.pub` assertion is actually presented; the
  // JWKS is fetched + cached lazily. Override or extend in instance settings.
  trustedIssuers: [
    {
      issuer: DEFAULT_ACCOUNT_URL,
      jwksUrl: `${DEFAULT_ACCOUNT_URL}/api/identity/jwks`,
      // Consult account.book.pub's revocation list (OB-106) — signed against the
      // same JWKS, cached with a last-good offline fallback.
      revocationsUrl: `${DEFAULT_ACCOUNT_URL}/api/identity/revocations`,
    },
  ],
  // `inherit` at the root resolves here. Private-by-default once claimed (Fork 1);
  // an unclaimed instance short-circuits before this is ever consulted (rule 0).
  defaultVisibility: 'members',
  // account.book.pub is the default email-authority — the one issuer whose `email`
  // claim drives persona / email-ACL matching (B1). It is already trusted above.
  emailAuthority: DEFAULT_ACCOUNT_URL,
};

/**
 * Public view of the instance policy returned by `GET /api/instance` — issuer
 * URLs only (never private JWKS material), plus the principal resolved for the
 * *current* request, so a client can render "you are signed in as …" / "guest".
 */
export interface InstanceInfo {
  guestAccess: GuestAccess;
  /**
   * The instance-wide agent-edits mode (AGED-1) — see {@link InstanceConfig.agentEdits}.
   * Read-only here; a client changes it via `PUT /api/instance` (owner only). Exposed
   * so the UI can render "agents suggest / edit directly" and resolve a page's
   * `inherit` policy without a second probe. Optional: absent on a pre-AGED-1 server /
   * a test fixture — a client then treats it as the safe `'suggest'` default. */
  agentEdits?: AgentEditsMode;
  /**
   * The stable, opaque per-library identifier (STAB-5) — see
   * {@link InstanceConfig.instanceId}. An out-of-process MCP connector compares
   * this against its configured `OPENBOOK_INSTANCE_ID` to refuse a foreign
   * responder on the same port. Not a secret (authorizes nothing). Optional:
   * absent on a pre-STAB-5 server / a test fixture — a connector then can't verify
   * identity and falls back to a reachability-only probe. */
  instanceId?: string | null;
  ownerSubject: string | null;
  trustedIssuers: string[];
  /** This server's audience identifier, so a client can request an `aud`-scoped
   *  identity token (OB-177). `null` for the single-server (unscoped) model. */
  audience: string | null;
  /** Whether this instance *requires* every identity token to be bound to
   *  {@link audience} (OB-202). Lets a client short-circuit the audience-bind on
   *  relaunch: when the server already persisted `audience==host && requireAudience`
   *  it only needs to ensure its own token is scoped, never to relax + re-assert.
   *  Optional: absent (e.g. a pre-OB-202 server / a test fixture) is treated as `false`. */
  requireAudience?: boolean;
  /**
   * The audience scope a page's `visibility='inherit'` resolves to at the root once
   * the instance is claimed (OB-182 §2.4) — the TRUE effective default behind the
   * Share dialog's "Library default". Exposed so a claimed instance can show what
   * inheriting really means (e.g. "members only") instead of the guest-gate summary,
   * which only governs an *unclaimed* instance's rule-0 short-circuit. Never
   * `inherit`. Optional: absent on a pre-SHR-6 server / a test fixture — the client
   * falls back to the {@link guestAccess} summary. */
  defaultVisibility?: Exclude<PageVisibility, 'inherit'> | null;
  /**
   * The ledger auto-export target (LGR-7), or `null` when auto-export is off.
   * Surfaced so the legitimate owner can SEE that their book is being written to
   * a file — an unreadable setting is an invisible exfiltration channel. Fenced
   * behind the same identity gate as the rest of the identity-infrastructure
   * block (a claimed instance never shows it to an anonymous caller). Optional:
   * absent on a pre-LGR-7 server / a test fixture.
   */
  ledgerAutoExportPath?: string | null;
  /** Who the server resolved you to be on this request. */
  you: Principal;
  /**
   * Your *effective* instance role on this request (P1-8), or `null` if you hold
   * no special role (a guest / signed-in stranger). Layers the `owner` rung the
   * roster can't express — the claimed owner (`jws` && `subject===ownerSubject`),
   * or the loopback owner (`verifiedVia==='local'`, the in-webview path only — a
   * request-borne principal is never `local`) — on top of the active-persona roster
   * role (`admin` / `viewer`, OB-182 §1.1). Lets a client render read-only viewer
   * chrome (OB-205: `viewer` locks the editor) and gate manager-only UI (the Share
   * dialog: `owner`/`admin` manage) without a second probe. UI-only: the server's
   * `authorize()` stays the sole write enforcement, so a wrong/absent value never
   * grants a write the server would 403; a signed-in owner reads as `owner`, and an
   * unclaimed instance keeps write via the client's coarse guest-gate fallback.
   * Optional: absent (a pre-P1-8 server / a test fixture) is treated as `null`.
   */
  youRole?: EffectiveRole | null;
  /**
   * Whether this request arrived over the trusted local transport (the desktop
   * host's per-run `LOCAL_OWNER_HEADER` secret matched). When true the caller
   * holds machine-owner authority regardless of {@link you}: policy writes pass
   * the owner gate, and a drifted `ownerSubject` may be repaired (re-pointed to
   * the caller's own verified subject) via `PUT /api/instance`. Optional: absent
   * (a pre-hatch server / a test fixture) is treated as `false`.
   */
  localOwner?: boolean;
}

/** One recorded change — a row of the append-only edit log. */
export interface StoredEdit {
  id: string;
  pageId: string | null;
  authorSubject: string;
  authorIssuer: string;
  authorName: string;
  verifiedVia: VerifiedVia;
  /** What kind of change: `page.save`, `page.create`, `page.delete`, `row.update`, … */
  kind: string;
  /** The signed credential that authorized it (users only). */
  assertionKid: string | null;
  assertionJti: string | null;
  summary: string;
  createdAt: string;
}
