/**
 * The one authorization function (OB-189; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §1).
 *
 * `authorize(principal, page, ctx)` is the single, **pure, isomorphic** access
 * decision for the whole product. The origin calls it on every content
 * request/event; the client reuses it to grey out UI. It has **no I/O**: the
 * roster role, the resolved (post-`inherit`) visibility, and the email-authority
 * gate are all computed by the caller (the store) and handed in via {@link
 * AccessCtx}. This module only composes them through the §1.2 precedence ladder.
 *
 * Wiring it into routes, streams and the request → {@link AccessCtx} build is
 * OB-190 (enforcement) and is intentionally NOT here.
 */

import type {Principal} from './identity';
import type {InstanceConfig} from './provenance';
import type {AclLevel, MemberRole, PageVisibility} from './types';

/**
 * Roster role, in the authorize layer (contract §1.1 calls this union `Role`).
 * An ALIAS of {@link MemberRole} — there is exactly one role union in the SDK.
 */
export type Role = MemberRole;

/** A resolved (never `inherit`) page visibility scope. */
export type EffectiveVisibility = Exclude<PageVisibility, 'inherit'>;

/**
 * One per-page ACL grant, as seen by {@link authorize} (the in-memory shape of a
 * `page_acl` row, §2.3). Exactly one grantee key is set: `subject` (a grantee
 * already bound to any trusted issuer) XOR `email` (a grantee by persona email,
 * lowercased). An `email` entry MUST carry the pinned `issuer` — the
 * email-authority — or it can never match (B1).
 */
export interface AclEntry {
  /** Grantee already bound to a member/handle (any trusted issuer). */
  subject?: string;
  /** Grantee by persona email (lowercased). */
  email?: string;
  /** REQUIRED for an email entry — the pinned email-authority (B1). */
  issuer?: string;
  level: AclLevel;
}

/** The per-page inputs to a decision: the page's scope + its ACL grants. */
export interface AccessPage {
  visibility: PageVisibility;
  acl: AclEntry[];
}

/**
 * The non-page, caller-resolved inputs to a decision (contract §1.1). Everything
 * here is computed by the store before the call: the active-persona role, the
 * effective visibility after resolving `inherit`, and whether the principal's
 * email may be trusted.
 */
export interface AccessCtx {
  config: Pick<InstanceConfig, 'guestAccess' | 'ownerSubject' | 'defaultVisibility' | 'emailAuthority'>;
  /**
   * Role of the principal's ACTIVE persona, resolved by the store: a roster row
   * with `status='active'` whose BOUND `subject === principal.subject` (and, for
   * an email persona, whose email === principal.email under the pinned authority).
   * `invited`/`suspended` rows resolve to `null` — a dormant row grants nothing
   * (S3). `null` ⇒ the principal is not an active member.
   */
  role: Role | null;
  /**
   * Effective visibility after resolving `inherit` (up the PARENT chain for an
   * ordinary page, or via the DATABASE HOST PAGE for a database row — N9), down to
   * `config.defaultVisibility` at the root. Never `inherit`.
   */
  effectiveVisibility: EffectiveVisibility;
  /**
   * True iff the principal's email may be trusted for persona / email-ACL
   * matching: `verifiedVia==='jws'` AND `principal.issuer === config.emailAuthority`
   * (B1). Only then does email matching fire. See {@link isEmailAuthoritative}.
   */
  emailIsAuthoritative: boolean;
}

/** The decision: independent read/write grants plus the deciding rung's reason. */
export interface Decision {
  canRead: boolean;
  canWrite: boolean;
  reason: string;
}

/**
 * The `emailIsAuthoritative` predicate (contract §1.1, B1) as a reusable pure
 * helper the store uses to build {@link AccessCtx.emailIsAuthoritative}. An email
 * is trustworthy ONLY on a fresh JWS from the one pinned email-authority — a
 * federated self-issuer asserting arbitrary emails can never satisfy it.
 */
export function isEmailAuthoritative(
  principal: Principal,
  config: Pick<InstanceConfig, 'emailAuthority'>,
): boolean {
  return (
    principal.verifiedVia === 'jws' &&
    !!config.emailAuthority &&
    principal.issuer === config.emailAuthority
  );
}

/**
 * The highest ACL grant a principal matches on this page (§1.2 rule 3), or `null`.
 * `'write'` outranks `'read'`. A **subject** entry matches only a `jws` principal
 * with the same subject (any trusted issuer); an **email** entry matches only when
 * the email is authoritative AND the lowercased emails are equal AND the entry's
 * `issuer` is the pinned email-authority (B1) — so a federated issuer can never
 * satisfy an `account.book.pub`-scoped email grant.
 */
function matchAcl(principal: Principal, acl: AclEntry[], ctx: AccessCtx): AclLevel | null {
  const isJws = principal.verifiedVia === 'jws';
  let best: AclLevel | null = null;
  for (const entry of acl) {
    let matches = false;
    if (entry.subject) {
      matches = isJws && entry.subject === principal.subject;
    } else if (entry.email) {
      matches =
        ctx.emailIsAuthoritative &&
        !!principal.email &&
        entry.email.toLowerCase() === principal.email.toLowerCase() &&
        entry.issuer === ctx.config.emailAuthority;
    }
    if (matches) {
      if (entry.level === 'write') return 'write';
      best = 'read';
    }
  }
  return best;
}

/** Does the principal get READ purely from the visibility scope (§1.2 rule 5)? */
function scopeAllowsRead(principal: Principal, ctx: AccessCtx, guestBlocked: boolean): boolean {
  switch (ctx.effectiveVisibility) {
  case 'public':
    // Read for ALL — incl. anonymous — overriding the guest gate, EXCEPT a
    // guest when `guestAccess='off'` (rule 6 / footnote ¹).
    return !guestBlocked;
  case 'authenticated':
    // Any signed-in (jws) user; guests denied (N8).
    return principal.verifiedVia === 'jws';
  case 'members':
    // Only active roster members — an active row resolves to a non-null role.
    // A signed-in non-member or invited/suspended persona (role null) gets
    // nothing here; it may still read via an ACL above.
    return ctx.role !== null;
  case 'restricted':
    // Only owner/admin/ACL, all handled above; everyone else: no.
    return false;
  }
}

/**
 * Decide read+write for a principal on a page (contract §1.2 precedence ladder).
 *
 * Ladder, highest authority first; the first rule that grants a *field* wins, and
 * write is only ever granted by rules 0/1/2/3/4:
 *
 *  0. Unclaimed instance (`ownerSubject` unset) → legacy guest-gate short-circuit
 *     (loopback-only by the §2.6 exposure invariant).
 *  1. Loopback owner (`verifiedVia==='local'`) → read+write.
 *  2. Owner (`jws` && `subject===ownerSubject`) → read+write.
 *  3. Per-page ACL: `write` → read+write; `read` → read (write falls through).
 *  4. Roster role: `admin` → read+write; `viewer` → read per scope, write denied.
 *  5. Visibility scope vs principal class → governs read for everyone else.
 *  6. Guest-gate floor (`guestAccess='off'` denies the guest class even `public`).
 *  7. Default deny.
 */
export function authorize(principal: Principal, page: AccessPage, ctx: AccessCtx): Decision {
  const {config} = ctx;
  const isLocal = principal.verifiedVia === 'local';
  const isJws = principal.verifiedVia === 'jws';

  // Rule 0 — unclaimed instance: legacy short-circuit, preserving today's
  // loopback behaviour exactly. Roster/scope/ACL don't exist until claimed; the
  // in-process (`local`) and any `jws` caller always read+write (truth-table
  // footer), everyone else is judged by the guest gate. Reachable only on
  // loopback (the §2.6 exposure invariant — a claim is required before exposure).
  if (config.ownerSubject === undefined) {
    const privileged = isJws || isLocal;
    return {
      canRead: config.guestAccess !== 'off' || privileged,
      canWrite: config.guestAccess === 'write' || privileged,
      reason: 'legacy-guest-gate',
    };
  }

  // ── Claimed instance ──────────────────────────────────────────────────────
  const isOwner = isJws && principal.subject === config.ownerSubject; // rule 2
  const aclMatch = matchAcl(principal, page.acl, ctx); // rule 3
  const isAdmin = ctx.role === 'admin'; // rule 4
  const isViewer = ctx.role === 'viewer'; // rule 4
  // Rule 6 floor: the guest class is denied even `public` when guests are
  // disabled. Hardened (OB-190, OB-189 security review #1) to the WHOLE
  // unauthenticated class — any principal that is neither an authenticated `jws`
  // user nor the loopback owner. `kind==='guest'` is the common case, but a
  // non-request-assertable `unverified`/`synced` `user` principal must never slip
  // past the `guestAccess='off'` floor onto a `public` page either (defence in
  // depth behind the middleware, which already rejects such principals at the gate
  // on an identity-enabled instance).
  const guestBlocked = !isJws && !isLocal && config.guestAccess === 'off';
  const scopeRead = scopeAllowsRead(principal, ctx, guestBlocked); // rule 5

  // WRITE — only rules 1/2/3(write)/4(admin) ever grant it. `viewer` is locked,
  // jws-non-members and guests are read-only on a claimed instance.
  const canWrite = isLocal || isOwner || aclMatch === 'write' || isAdmin;

  // READ — granted by the first rung that allows it.
  const canRead = isLocal || isOwner || aclMatch !== null || isAdmin || scopeRead;

  let reason: string;
  if (isLocal) reason = 'local-owner';
  else if (isOwner) reason = 'owner';
  else if (aclMatch === 'write') reason = 'acl-write';
  else if (isAdmin) reason = 'admin';
  else if (aclMatch === 'read') reason = 'acl-read';
  else if (isViewer) reason = canRead ? 'viewer-readonly' : 'no-grant';
  else if (canRead) reason = 'visibility-scope';
  else if (guestBlocked) reason = 'guest-disabled';
  else reason = 'no-grant';

  return {canRead, canWrite, reason};
}
