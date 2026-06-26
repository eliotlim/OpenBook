/**
 * Per-request principal resolution and the guest-access gate (OB-165).
 *
 * The server is single-tenant: one shared workspace. This layer answers *who*
 * is making a request (a verified user, or a guest) and *whether* an
 * unauthenticated caller is allowed to proceed — it does not partition data.
 *
 * Identity rides a dedicated `X-OpenBook-Identity: <jws>` header (orthogonal to
 * the instance-wide `Authorization: Bearer <accessToken>` reachability gate). A
 * presented assertion is verified against a trusted issuer's cached JWKS; a
 * missing assertion is a guest. See `docs/multi-user-and-backups-2026-06.md`.
 */

import type {Context} from 'hono';
import {
  decodeIdentity,
  guestPrincipal,
  principalFromClaims,
  unverifiedPrincipalFromClaims,
  verifyIdentity,
  type GuestAccess,
  type Jwks,
  type Principal,
} from '@book.dev/sdk';

/** Header carrying the identity assertion (JWS). */
export const IDENTITY_HEADER = 'X-OpenBook-Identity';
/** Optional guest display-name hint, so even anonymous edits get a label. */
export const GUEST_NAME_HEADER = 'X-OpenBook-Guest-Name';
/** Query-param fallback for `EventSource` (which can't set headers). */
export const IDENTITY_QUERY = 'identity';

/**
 * What the middleware needs to resolve + gate a principal. Implemented by
 * {@link IdentityService}; injected via `AppOptions.identity`. Optional — when
 * absent the instance behaves as a legacy single-user, guest-everyone server.
 */
export interface IdentityProvider {
  /** Current guest policy + the issuer URLs this instance trusts. */
  policy(): Promise<{guestAccess: GuestAccess; allowedIssuers: string[]}>;
  /** The (cached, offline-capable) JWKS for an issuer, or `null` if untrusted/unknown. */
  jwks(issuer: string): Promise<Jwks | null>;
  /** Clock injection point (tests). Defaults to `Date.now()`. */
  now?(): number;
}

/** A rejection the middleware should turn into an error response. */
export interface PrincipalRejection {
  status: 401 | 403;
  error: string;
}

export type Resolved = {principal: Principal} | {reject: PrincipalRejection};

function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * Resolve the principal behind a request. A verified assertion → a user
 * principal; no assertion → a guest; a *present but invalid* assertion → a 401
 * (a bad credential is an error, never a silent downgrade to guest), unless the
 * instance has no identity provider at all (legacy / no trust configured), in
 * which case a presented assertion is recorded as a claimed-but-unverified
 * identity and allowed through the same as today.
 */
export async function resolvePrincipal(c: Context, identity: IdentityProvider | undefined): Promise<Resolved> {
  const jws = c.req.header(IDENTITY_HEADER) ?? c.req.query(IDENTITY_QUERY);
  const guestName = c.req.header(GUEST_NAME_HEADER) ?? '';

  if (!jws) return {principal: guestPrincipal(guestName)};

  if (!identity) {
    // No issuer trust configured: we can't verify, but presenting a credential
    // shouldn't break a legacy instance. Record the claimed identity, unverified.
    const decoded = decodeIdentity(jws);
    return {principal: decoded ? unverifiedPrincipalFromClaims(decoded.claims) : guestPrincipal(guestName)};
  }

  const decoded = decodeIdentity(jws);
  if (!decoded) return {reject: {status: 401, error: 'malformed identity assertion'}};
  const jwks = await identity.jwks(decoded.claims.iss);
  if (!jwks) return {reject: {status: 401, error: 'identity from an untrusted issuer'}};
  const {allowedIssuers} = await identity.policy();
  const res = await verifyIdentity(jws, jwks, {allowedIssuers, nowMs: identity.now?.()});
  if (!res.ok) return {reject: {status: 401, error: `identity rejected: ${res.reason}`}};
  return {principal: principalFromClaims(res.claims, res.header)};
}

/**
 * Enforce the guest-access policy. Verified users always pass (per-page ACLs are
 * out of scope for single-tenant v1). Returns a rejection, or `null` to allow.
 */
export function guestGate(principal: Principal, guestAccess: GuestAccess, method: string): PrincipalRejection | null {
  if (principal.kind !== 'guest') return null;
  if (guestAccess === 'off') return {status: 401, error: 'guest access is disabled on this instance'};
  if (guestAccess === 'read' && isWriteMethod(method)) {
    return {status: 403, error: 'guest access is read-only on this instance'};
  }
  return null;
}
