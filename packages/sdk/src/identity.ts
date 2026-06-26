/**
 * Verifiable user identity for multi-user OpenBook (OB-165).
 *
 * A user proves who they are with a compact **JWS** (JSON Web Signature) signed
 * by a trusted **issuer** (account.book.pub, or any federated issuer) using
 * **Ed25519 / `alg: EdDSA`** — the same primitive the forwarding site keys and
 * plugin provenance already use, so this adds no dependency. The data server
 * verifies the assertion against the issuer's published JWKS (which it caches,
 * so verification works offline and on any federated instance), then attributes
 * every change to the resulting {@link Principal}.
 *
 * Design: see `docs/multi-user-and-backups-2026-06.md`. This module is
 * isomorphic (Web Crypto only) so it runs in the server, the desktop app, the
 * web shell, and tests alike.
 */

import {b64uDecode, b64uEncode, b64uDecodeString, b64uEncodeString, utf8} from './forwarding/encoding';

const ED25519 = {name: 'Ed25519'} as const;

/** How an actor's identity was established for a given request/change. */
export type VerifiedVia =
  /** A fresh, signature-verified identity JWS from a trusted issuer. */
  | 'jws'
  /** Unauthenticated (or self-named) guest. */
  | 'guest'
  /** A well-formed JWS that no longer verifies fresh (e.g. expired while
   *  offline). The claimed identity is recorded but flagged as not vouched-for. */
  | 'unverified'
  /** In-process caller (the embedded `LocalDataClient`) — implicitly the local
   *  owner; there is no request to carry a credential. */
  | 'local';

export type PrincipalKind = 'user' | 'guest';

/** The actor behind a request, resolved by the server and stamped onto changes. */
export interface Principal {
  kind: PrincipalKind;
  /** Stable, globally-meaningful id. Users: `iss#sub`. Guests: `guest:<name|anon>`. */
  subject: string;
  /** The issuer URL that vouched for a user (empty for guests/local). */
  issuer: string;
  /** Human-readable display name, when known. */
  name: string;
  verifiedVia: VerifiedVia;
  /** Which signed credential authorized this (users only): issuer key id + assertion id. */
  assertion?: {kid?: string; jti?: string};
}

/** A guest principal with an optional display name. */
export function guestPrincipal(name = ''): Principal {
  const label = name.trim();
  return {
    kind: 'guest',
    subject: label ? `guest:${label}` : 'guest:anonymous',
    issuer: '',
    name: label,
    verifiedVia: 'guest',
  };
}

/** The implicit local owner (in-process / loopback desktop). */
export function localPrincipal(name = 'Local'): Principal {
  return {kind: 'user', subject: 'local:owner', issuer: 'local', name, verifiedVia: 'local'};
}

/** Stable short id for a principal — the value embedded in CRDT edit origins. */
export function principalId(p: Principal): string {
  return p.subject;
}

// ── The identity assertion (JWS) ──────────────────────────────────────────────

/** JOSE header of an identity assertion. */
export interface IdentityHeader {
  alg: 'EdDSA';
  typ?: string;
  /** Issuer key id — selects the verifying key from the issuer's JWKS. */
  kid?: string;
}

/** Claims carried by an identity assertion (a JWT-shaped payload). */
export interface IdentityClaims {
  /** Issuer URL (the authenticating source). */
  iss: string;
  /** Stable user id within the issuer. */
  sub: string;
  /** Display name. */
  name?: string;
  /** Email, when the issuer chooses to assert it. */
  email?: string;
  /** Issued-at (epoch seconds). */
  iat?: number;
  /** Expiry (epoch seconds). */
  exp?: number;
  /** Not-before (epoch seconds). */
  nbf?: number;
  /** Unique assertion id — recorded with each change for traceability. */
  jti?: string;
}

/** An Ed25519 public key in JWK form (`kty:'OKP'`, raw 32-byte `x`, base64url). */
export interface Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  /** Raw 32-byte public key, base64url. */
  x: string;
  kid?: string;
  use?: 'sig';
  alg?: 'EdDSA';
}

/** A set of public keys an issuer publishes (the cached, offline-verifiable set). */
export interface Jwks {
  keys: Jwk[];
}

/** An issuer signing keypair (dev/test issuer, or the account service). */
export interface IdentityKeypair {
  /** The public key as a JWK (publish in the JWKS). */
  publicJwk: Jwk;
  /** PKCS#8 private key, base64url — kept secret by the issuer. */
  privateKey: string;
}

/**
 * Mint a fresh issuer keypair (Ed25519). Used by the dev issuer and tests; the
 * real issuer (account.book.pub) holds the equivalent and rotates `kid`s.
 */
export async function mintIdentityKeypair(kid = 'dev-1'): Promise<IdentityKeypair> {
  const kp = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return {
    publicJwk: {kty: 'OKP', crv: 'Ed25519', x: b64uEncode(raw), kid, use: 'sig', alg: 'EdDSA'},
    privateKey: b64uEncode(priv),
  };
}

/**
 * Sign an identity assertion (issuer side / dev / tests). Produces a compact
 * EdDSA JWS: `base64url(header).base64url(claims).base64url(sig)`.
 */
export async function signIdentity(
  privateKeyPkcs8: string,
  claims: IdentityClaims,
  kid?: string,
): Promise<string> {
  const header: IdentityHeader = {alg: 'EdDSA', typ: 'JWT', ...(kid ? {kid} : {})};
  const signingInput = `${b64uEncodeString(JSON.stringify(header))}.${b64uEncodeString(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey('pkcs8', b64uDecode(privateKeyPkcs8), ED25519, false, ['sign']);
  const sig = await crypto.subtle.sign(ED25519, key, utf8(signingInput));
  return `${signingInput}.${b64uEncode(new Uint8Array(sig))}`;
}

/**
 * Decode an assertion's header + claims **without** verifying the signature.
 * For client-side display, and for the server's "claimed-but-unverified"
 * provenance fallback. Never use this to make a trust decision.
 */
export function decodeIdentity(jws: string): {header: IdentityHeader; claims: IdentityClaims} | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64uDecodeString(parts[0])) as IdentityHeader;
    const claims = JSON.parse(b64uDecodeString(parts[1])) as IdentityClaims;
    if (!claims || typeof claims.iss !== 'string' || typeof claims.sub !== 'string') return null;
    return {header, claims};
  } catch {
    return null;
  }
}

/** Reason an assertion failed to verify (for logging / the unverified fallback). */
export type VerifyFailure =
  | 'malformed'
  | 'unsupported-alg'
  | 'unknown-key'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'untrusted-issuer';

export type VerifyResult =
  | {ok: true; claims: IdentityClaims; header: IdentityHeader}
  | {ok: false; reason: VerifyFailure; claims?: IdentityClaims};

export interface VerifyOptions {
  /** Allowed clock skew, in seconds (covers minor offsets + short offline). Default 60. */
  clockToleranceSec?: number;
  /** Current time in epoch ms (injectable for tests). Default `Date.now()`. */
  nowMs?: number;
  /** If set, the `iss` claim must be one of these (issuer-rooted federation). */
  allowedIssuers?: string[];
}

/**
 * Verify an identity assertion against an issuer's JWKS. Pure + offline: the
 * caller supplies the (cached) key set, so no network call happens here.
 *
 * Returns `{ok:true, claims}` only on a fresh, signature-valid, in-window,
 * trusted-issuer assertion. On failure returns a reason (and the decoded claims
 * when they parsed, so the server can record a claimed-but-unverified identity).
 */
export async function verifyIdentity(jws: string, jwks: Jwks, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const decoded = decodeIdentity(jws);
  if (!decoded) return {ok: false, reason: 'malformed'};
  const {header, claims} = decoded;
  if (header.alg !== 'EdDSA') return {ok: false, reason: 'unsupported-alg', claims};
  if (opts.allowedIssuers && !opts.allowedIssuers.includes(claims.iss)) {
    return {ok: false, reason: 'untrusted-issuer', claims};
  }

  // Pick candidate keys: the kid-matched one, else every key (kid is a hint).
  const candidates = header.kid ? jwks.keys.filter((k) => k.kid === header.kid) : jwks.keys;
  if (candidates.length === 0) return {ok: false, reason: 'unknown-key', claims};

  const parts = jws.split('.');
  const signingInput = utf8(`${parts[0]}.${parts[1]}`);
  const sig = b64uDecode(parts[2]);
  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey('raw', b64uDecode(jwk.x), ED25519, false, ['verify']);
      if (await crypto.subtle.verify(ED25519, key, sig, signingInput)) {
        verified = true;
        break;
      }
    } catch {
      // Malformed key — try the next candidate.
    }
  }
  if (!verified) return {ok: false, reason: 'bad-signature', claims};

  // Time window (after the signature is proven, so we can distinguish expired
  // from forged). Tolerance covers clock skew and short offline spells.
  const tol = opts.clockToleranceSec ?? 60;
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.nbf === 'number' && now + tol < claims.nbf) {
    return {ok: false, reason: 'not-yet-valid', claims};
  }
  if (typeof claims.exp === 'number' && now - tol > claims.exp) {
    return {ok: false, reason: 'expired', claims};
  }
  return {ok: true, claims, header};
}

/** Build a verified user principal from validated claims. */
export function principalFromClaims(claims: IdentityClaims, header?: IdentityHeader): Principal {
  return {
    kind: 'user',
    subject: `${claims.iss}#${claims.sub}`,
    issuer: claims.iss,
    name: claims.name ?? '',
    verifiedVia: 'jws',
    assertion: {kid: header?.kid, jti: claims.jti},
  };
}

/**
 * Build a claimed-but-unverified principal from an assertion that parsed but
 * didn't verify fresh (e.g. expired while offline). Provenance still names the
 * claimed subject, flagged `unverified`.
 */
export function unverifiedPrincipalFromClaims(claims: IdentityClaims): Principal {
  return {
    kind: 'user',
    subject: `${claims.iss}#${claims.sub}`,
    issuer: claims.iss,
    name: claims.name ?? '',
    verifiedVia: 'unverified',
    assertion: {jti: claims.jti},
  };
}
