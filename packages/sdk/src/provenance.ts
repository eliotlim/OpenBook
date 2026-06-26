/**
 * Multi-user instance policy + change provenance (OB-165). The contract the
 * server and clients share for: the guest-access gate, the set of trusted
 * identity issuers, and the durable per-change edit log.
 *
 * Design: `docs/multi-user-and-backups-2026-06.md`.
 */

import {DEFAULT_ACCOUNT_URL} from './account';
import type {Jwks, Principal, VerifiedVia} from './identity';

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
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  guestAccess: 'write',
  // Trust account.book.pub out of the box — it's the OpenBook identity authority
  // (the shared root that makes identities federate across instances). Only ever
  // consulted when an `iss=account.book.pub` assertion is actually presented; the
  // JWKS is fetched + cached lazily. Override or extend in instance settings.
  trustedIssuers: [{issuer: DEFAULT_ACCOUNT_URL, jwksUrl: `${DEFAULT_ACCOUNT_URL}/api/identity/jwks`}],
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
