/**
 * Managed-workspace roster sync (OB-199) — the instance side of "bind instance ↔
 * workspace". When an instance is bound to an account workspace
 * ({@link InstanceConfig.workspaceBinding}), this pulls that workspace's roster
 * from the account (`GET /api/workspaces/:id/roster`, the OB-197 contract) and
 * reconciles it into the local `members` table, so the `members`-scope +
 * admin/viewer roles resolve for DIRECT (non-edge) access too and the binding is
 * coherent with what the edge admits (OB-198).
 *
 * Shape mirrors {@link BackupScheduler}: a single low-frequency `setInterval`
 * (`unref`'d so it never holds the process open) plus an on-demand `syncNow()`.
 * No SSE.
 *
 * Three invariants:
 *  - **Managed vs local coexist.** Only `source='managed'` rows are written or
 *    removed; the OB-191 local-invite path is never touched. {@link PageStore.syncManagedRoster}.
 *  - **Owner reconcile (OB-198 F2).** The bound workspace's owner is admitted as
 *    an admin even when it differs from the instance's own site owner, so the
 *    workspace owner is never locked out — and the sync never creates, demotes, or
 *    removes a row for the instance's own `ownerSubject` (who already has full
 *    access via the owner short-circuit in `authorize()`).
 *  - **Fail-safe.** A fetch failure keeps the last-good roster (never drops it,
 *    never widens access); only a successful fetch — including a legitimately
 *    EMPTY roster — reconciles.
 */

import {
  DEFAULT_ACCOUNT_URL,
  type InstanceConfig,
  type MemberRole,
  type WorkspaceRoster,
  type WorkspaceRosterEntry,
} from '@book.dev/sdk';
import type {ManagedMemberInput, PageStore, RosterSyncResult} from './store';

/**
 * Reads the bound workspace's roster from the account. Injected so the auth
 * mechanism (the instance's forwarding/site credential, or a device identity) and
 * the transport are wired by the host, and so tests mock the account. Resolves the
 * roster on success; THROWS on any failure (non-OK / network) so the syncer keeps
 * the last-good roster. A successful-but-EMPTY roster is NOT a failure — it
 * legitimately removes all managed rows.
 */
export type RosterFetcher = (binding: ResolvedBinding, signal?: AbortSignal) => Promise<WorkspaceRoster>;

/**
 * Mints a fresh per-instance roster assertion (the `Authorization: Bearer <…>`
 * value) for the bound workspace. INJECTED by the host so the actual signing
 * happens in the layer that holds the site private key (the desktop OS keychain),
 * and the raw key never enters the data-server. The data-server only ever sees the
 * resulting opaque bearer string.
 *
 * Called once per fetch so the assertion's `ts` is always fresh (the account's
 * freshness window is ±5 min). Returns `null` (or no provider at all) ⇒ send no
 * auth header — today's inert default, before an instance is bound + the desktop
 * keychain wiring lands. A THROW (e.g. the keychain is locked / signing failed)
 * propagates into the fetcher and routes through the fail-safe path (last-good
 * roster retained, `lastError` recorded) — it never falls back to an
 * unauthenticated request.
 */
export type RosterAssertionProvider = (workspaceId: string) => Promise<string | null> | string | null;

/** A binding with its account base URL resolved (never null). */
export interface ResolvedBinding {
  workspaceId: string;
  accountBaseUrl: string;
}

/** The subset the HTTP app needs (so `createApp` doesn't depend on the class). */
export interface RosterController {
  status(): Promise<RosterSyncStatus>;
  syncNow(): Promise<RosterSyncResult | null>;
}

/** Binding + last-sync observability (the `GET /api/workspace/sync` shape). */
export interface RosterSyncStatus {
  /** Whether a workspace binding is configured (the sync is otherwise inert). */
  bound: boolean;
  workspaceId: string | null;
  accountBaseUrl: string | null;
  /** ISO time of the last SUCCESSFUL reconcile, or null. */
  lastSyncAt: string | null;
  /** Counts from the last successful reconcile, or null. */
  lastResult: RosterSyncResult | null;
  /** Message from the most recent failed fetch (last-good is retained), or null. */
  lastError: string | null;
}

export interface RosterSyncerOptions {
  /** Reads the bound workspace roster from the account. */
  fetchRoster: RosterFetcher;
  /** How often to re-sync (ms). Default 5 min. */
  intervalMs?: number;
  /**
   * Abort a single roster fetch after this many ms (Quinn #1). A *hung* (not
   * refused) account endpoint must not block the on-demand `POST
   * /api/workspace/sync` — nor coalesce every periodic tick onto one stuck run —
   * for the whole interval. On timeout the fetch aborts → the normal fetch-failure
   * path (last-good retained, `lastError` recorded). Default 15s.
   */
  fetchTimeoutMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
  /** Structured log sink (defaults to `console`). */
  log?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;

export class RosterSyncer implements RosterController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSyncAt: string | null = null;
  private lastResult: RosterSyncResult | null = null;
  private lastError: string | null = null;
  /** Serialize overlapping ticks (a slow fetch must not race the interval). */
  private inFlight: Promise<RosterSyncResult | null> | null = null;

  constructor(
    private readonly store: PageStore,
    private readonly opts: RosterSyncerOptions,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(message: string): void {
    (this.opts.log ?? ((m) => console.error(m)))(message);
  }

  /** Start the periodic sync (runs once immediately to converge after downtime). */
  start(): void {
    if (this.timer) return;
    void this.tick();
    const interval = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** A periodic tick — never throws (errors are logged + recorded). */
  async tick(): Promise<void> {
    try {
      await this.syncNow();
    } catch {
      /* syncNow already records + logs; the timer must keep running */
    }
  }

  async status(): Promise<RosterSyncStatus> {
    const binding = resolveBinding(await this.store.getInstanceConfig());
    return {
      bound: binding !== null,
      workspaceId: binding?.workspaceId ?? null,
      accountBaseUrl: binding?.accountBaseUrl ?? null,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  /**
   * Pull + reconcile the bound roster now. Returns the reconcile counts, or `null`
   * when the instance isn't bound (no-op). Fail-safe: a fetch failure records the
   * error and leaves the existing roster untouched.
   */
  async syncNow(): Promise<RosterSyncResult | null> {
    // Coalesce concurrent calls (periodic tick + an on-demand POST) onto one run.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async run(): Promise<RosterSyncResult | null> {
    const config = await this.store.getInstanceConfig();
    const binding = resolveBinding(config);
    if (!binding) return null; // not a managed instance — inert

    let roster: WorkspaceRoster;
    // Bound the fetch (Quinn #1): a hung endpoint must abort, not block the run for
    // the whole interval. `unref` so the timer never holds the process open.
    const controller = new AbortController();
    const timeoutMs = this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      roster = await this.opts.fetchRoster(binding, controller.signal);
    } catch (err) {
      // FAIL-SAFE: keep the last-good roster, never widen access. Record + log. A
      // timeout aborts into this same path (a normal fetch failure).
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`OpenBook workspace roster sync failed (keeping last-good roster): ${this.lastError}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const desired = resolveDesiredRoster(roster, config);
    let result: RosterSyncResult;
    try {
      result = await this.store.syncManagedRoster(desired);
    } catch (err) {
      // FAIL-SAFE (Quinn #2): a store-reconcile failure (e.g. a DB error) must be
      // recorded too — the transaction rolls back so the roster stays intact, but
      // an unrecorded throw would leave `lastError`/status stale.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`OpenBook workspace roster reconcile failed (roster intact): ${this.lastError}`);
      throw err;
    }
    this.lastSyncAt = new Date(this.now()).toISOString();
    this.lastResult = result;
    this.lastError = null;
    return result;
  }
}

/** Resolve a binding's account base URL (binding override → emailAuthority →
 *  account.book.pub), or `null` when the instance isn't bound. */
export function resolveBinding(config: InstanceConfig): ResolvedBinding | null {
  const binding = config.workspaceBinding;
  if (!binding?.workspaceId) return null;
  const accountBaseUrl = (binding.accountBaseUrl ?? config.emailAuthority ?? DEFAULT_ACCOUNT_URL).replace(/\/+$/, '');
  return {workspaceId: binding.workspaceId, accountBaseUrl};
}

/** Pick the higher-privilege role (admin ≻ viewer). */
function higherRole(a: MemberRole | undefined, b: MemberRole): MemberRole {
  return a === 'admin' || b === 'admin' ? 'admin' : 'viewer';
}

/**
 * Project an account {@link WorkspaceRoster} onto the desired managed-member set:
 * dedupe by identity (subject preferred, then email; admin wins), admit the
 * workspace owner as admin (OB-198 F2), and EXCLUDE the instance's own site owner
 * — the sync must never create/demote/remove a row for `ownerSubject`, who is
 * already admitted by the owner short-circuit. The pinned email-authority issuer
 * (B1) stamps every entry.
 *
 * Emails are trimmed + lowercased for parity with the store's `normalizeEmail`
 * (Quinn #3) — surrounding whitespace must not slip the local-email coexistence
 * skip or the `lower(email)` unique match.
 *
 * Site-owner exclusion also keys on email (Quinn #4): the subject filter alone
 * lets an email-only roster entry for the site owner mint a managed `invited`
 * persona for them. We resolve the owner's persona email *when the roster binds it
 * to the owner's subject* and exclude any email-only entry matching it. A pure
 * email-only owner (never bound to a subject anywhere in the roster) can't be
 * resolved here, but that residual case is safe: an `invited` row confers no role
 * (`resolveMemberRole` ignores non-`active` rows) and the owner keeps full access
 * via the owner short-circuit regardless.
 */
export function resolveDesiredRoster(roster: WorkspaceRoster, config: InstanceConfig): ManagedMemberInput[] {
  const issuer = config.emailAuthority ?? DEFAULT_ACCOUNT_URL;
  const siteOwner = config.ownerSubject;
  const bySubject = new Map<string, ManagedMemberInput>();
  const byEmail = new Map<string, ManagedMemberInput>();

  // Resolve the site owner's persona email when the roster binds it to the owner's
  // subject, so we can also exclude an email-only entry for the same human.
  const ownerEmail = siteOwner
    ? normEmail(roster.members.find((m) => m.subject === siteOwner && m.email)?.email)
    : null;

  const add = (subject: string | null, rawEmail: string | null, role: MemberRole): void => {
    // Never touch the instance's own site owner — they already have full access
    // via the owner short-circuit, and the sync must not demote/lock them out.
    if (subject && siteOwner && subject === siteOwner) return;
    const email = normEmail(rawEmail);
    if (subject) {
      const prev = bySubject.get(subject);
      if (prev) prev.role = higherRole(prev.role, role);
      else bySubject.set(subject, {subject, email: null, issuer, role});
    } else if (email) {
      // The site owner listed email-only — same exclusion as the subject case.
      if (ownerEmail && email === ownerEmail) return;
      const prev = byEmail.get(email);
      if (prev) prev.role = higherRole(prev.role, role);
      else byEmail.set(email, {subject: null, email, issuer, role});
    }
  };

  for (const m of roster.members) {
    if (!m.subject && !normEmail(m.email)) continue;
    add(m.subject ?? null, m.email ?? null, m.role);
  }

  // OB-198 F2: admit the workspace owner as admin even when it differs from the
  // site owner. (Same-as-site-owner is filtered out by `add` — they're already in.)
  if (roster.ownerSubject) add(roster.ownerSubject, null, 'admin');

  return [...bySubject.values(), ...byEmail.values()];
}

/** Trim + lowercase an email for parity with the store's `normalizeEmail`, or
 *  `null` when empty/whitespace-only. */
function normEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * The default HTTP roster fetcher. Reads `GET <account>/api/workspaces/:id/roster`
 * and presents a fresh per-instance roster assertion (minted by the injected
 * {@link RosterAssertionProvider}) as a `Bearer` token.
 *
 * The account endpoint authenticates the INSTANCE/SITE (not an end user) and
 * authorizes it to read its bound workspace's roster: the assertion is an Ed25519
 * signature by the site's private key, verified against the Site row's registered
 * public key (see `signRosterAssertion` in `@book.dev/sdk`). The signing happens in
 * the keychain-holding layer (the provider), so the raw key never reaches here.
 *
 * With no provider (today's default) the request is unauthenticated — inert until
 * an instance is bound + the desktop keychain wiring lands. Throws on any non-OK /
 * network error, AND on a malformed-but-200 body (Sasha INFO-1), so the syncer
 * keeps last-good and records the failure; a provider that throws routes through
 * the same fail-safe (it never downgrades to an unauthenticated request).
 */
export function httpRosterFetcher(opts: {
  fetchImpl?: typeof fetch;
  /**
   * Mints a fresh signed roster assertion for the workspace (the keychain layer).
   * Absent / returns null ⇒ no auth header. A throw → fail-safe (last-good kept).
   */
  assertionProvider?: RosterAssertionProvider;
} = {}): RosterFetcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (binding, signal) => {
    const url = `${binding.accountBaseUrl}/api/workspaces/${encodeURIComponent(binding.workspaceId)}/roster`;
    const token = await opts.assertionProvider?.(binding.workspaceId);
    const headers: Record<string, string> = {Accept: 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, {headers, signal});
    if (!res.ok) {
      throw new Error(`account roster fetch ${res.status} for workspace ${binding.workspaceId}`);
    }
    // Validate the shape HERE (Sasha INFO-1) rather than blind-casting: a
    // malformed-but-200 body (e.g. `members` missing / not an array) would
    // otherwise throw downstream in `resolveDesiredRoster`, OUTSIDE `run()`'s
    // fetch try/catch, so the failure wouldn't be recorded. Throwing in the
    // fetcher routes it through the fail-safe path (last-good kept, `lastError`
    // set). Still no mutation.
    return parseWorkspaceRoster(await res.json(), binding.workspaceId);
  };
}

/**
 * Validate an account roster response into a {@link WorkspaceRoster}, throwing on a
 * malformed shape (Sasha INFO-1). Defensive against an unvalidated 200 from the
 * (cross-repo) account endpoint; never mutates and never widens access.
 */
export function parseWorkspaceRoster(data: unknown, workspaceId: string): WorkspaceRoster {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`account roster for workspace ${workspaceId} is not an object`);
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.members)) {
    throw new Error(`account roster for workspace ${workspaceId} has no members array`);
  }
  if (obj.ownerSubject !== undefined && typeof obj.ownerSubject !== 'string') {
    throw new Error(`account roster for workspace ${workspaceId} has a malformed ownerSubject`);
  }
  const members: WorkspaceRosterEntry[] = obj.members.map((m, i) => {
    if (typeof m !== 'object' || m === null) {
      throw new Error(`account roster for workspace ${workspaceId} member ${i} is not an object`);
    }
    const entry = m as Record<string, unknown>;
    if (entry.role !== 'admin' && entry.role !== 'viewer') {
      throw new Error(`account roster for workspace ${workspaceId} member ${i} has an invalid role`);
    }
    if (entry.subject !== undefined && typeof entry.subject !== 'string') {
      throw new Error(`account roster for workspace ${workspaceId} member ${i} has a malformed subject`);
    }
    if (entry.email !== undefined && typeof entry.email !== 'string') {
      throw new Error(`account roster for workspace ${workspaceId} member ${i} has a malformed email`);
    }
    return {
      ...(entry.subject !== undefined ? {subject: entry.subject as string} : {}),
      ...(entry.email !== undefined ? {email: entry.email as string} : {}),
      role: entry.role,
    };
  });
  return {
    workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : workspaceId,
    ...(typeof obj.ownerSubject === 'string' ? {ownerSubject: obj.ownerSubject} : {}),
    members,
  };
}
