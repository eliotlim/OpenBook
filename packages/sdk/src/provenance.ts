/**
 * Multi-user instance policy + change provenance (OB-165). The contract the
 * server and clients share for: the guest-access gate, the set of trusted
 * identity issuers, and the durable per-change edit log.
 *
 * Design: `docs/multi-user-and-backups-2026-06.md`.
 */

import {DEFAULT_ACCOUNT_URL} from './account';
import type {Jwks, Principal, VerifiedVia} from './identity';
import type {PageVisibility} from './types';

/** What an unauthenticated (guest) caller may do on this instance. */
export type GuestAccess =
  /** Guests are rejected entirely (sign-in required). */
  | 'off'
  /** Guests may read, but not write. */
  | 'read'
  /** Guests may read and write (the default — same as a no-login workspace today). */
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
}

/** The instance's multi-user policy, persisted in the `settings` table. */
export interface InstanceConfig {
  guestAccess: GuestAccess;
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
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  guestAccess: 'write',
  // Trust account.book.pub out of the box — it's the OpenBook identity authority
  // (the shared root that makes identities federate across instances). Only ever
  // consulted when an `iss=account.book.pub` assertion is actually presented; the
  // JWKS is fetched + cached lazily. Override or extend in instance settings.
  trustedIssuers: [{issuer: DEFAULT_ACCOUNT_URL, jwksUrl: `${DEFAULT_ACCOUNT_URL}/api/identity/jwks`}],
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
  ownerSubject: string | null;
  trustedIssuers: string[];
  /** This server's audience identifier, so a client can request an `aud`-scoped
   *  identity token (OB-177). `null` for the single-server (unscoped) model. */
  audience: string | null;
  /** Who the server resolved you to be on this request. */
  you: Principal;
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
