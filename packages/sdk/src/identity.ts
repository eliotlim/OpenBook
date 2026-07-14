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
  /** Attribution carried in from another instance via the sync/merge path
   *  (OB-170) — vouched for by the originating instance, not re-verified here. */
  | 'synced'
  /** In-process caller (the embedded `LocalDataClient`) — implicitly the local
   *  owner; there is no request to carry a credential. */
  | 'local'
  /**
   * An **agent Personal-Access-Token** (AGENT-6): a `Bearer obat_…` credential an
   * instance admin minted, bound at mint time to the MINTER's own verified subject
   * (never client-chosen). It rides the SUBJECT-keyed authorize rungs its bound user
   * would — owner-content, subject-ACL, authenticated-read — but is deliberately
   * NOT a roster member (no `admin`/`viewer` rung, see `resolveMemberRole`), carries
   * no persona email (never matches an email-ACL), and can never mint verified block
   * authorship (`verifiedSubject` stays jws-only). Its HTTP surface is further
   * confined by a default-deny scope-gate. */
  | 'pat';

export type PrincipalKind = 'user' | 'guest';

/** What a minted agent token may do over the API (AGENT-6). `read` is confined to
 *  the read scope-gate allowlist; `write` additionally admits the unsafe methods on
 *  content routes. Never grants any privileged/admin route (default-deny). */
export type AgentTokenScope = 'read' | 'write';

/**
 * The **redacted** view of a minted agent token (AGENT-6), safe to return from the
 * management API and render in settings. NEVER carries the secret itself — only an
 * `obat_…` preview prefix; the plaintext is shown exactly once, in the create
 * response, and only its SHA-256 hash is stored at rest.
 */
export interface AgentTokenMeta {
  id: string;
  /** Human label the minter gave the token. */
  name: string;
  scope: AgentTokenScope;
  /** The verified subject the token is bound to (the minter's own subject, or
   *  `local:owner` for a hatch/local-owner minter). */
  subject: string;
  /** The issuer that vouched for {@link subject} (empty / `local` for the hatch). */
  issuer: string;
  /** Who minted it (a display label). */
  createdBy: string;
  /** ISO timestamps. */
  createdAt: string;
  /** ISO expiry, or `null` for a no-expiry token. */
  expiresAt: string | null;
  /** ISO last-used, or `null` if never presented. */
  lastUsedAt: string | null;
  /** A short, non-secret prefix of the token (`obat_xxxx…`) for recognition. */
  preview: string;
  /** True once revoked (kept listed briefly for provenance; never resolves). */
  revoked: boolean;
  /** True when the token may authenticate a FORWARDED `/api/mcp` request over the
   *  public edge (AGENT-7 remote MCP, L7). Default false — a local-only token can
   *  never be replayed remotely. Set at mint only, requires the instance's
   *  `agentApi.remote` setting to already be on. */
  remote: boolean;
}

/** The actor behind a request, resolved by the server and stamped onto changes. */
export interface Principal {
  kind: PrincipalKind;
  /** Stable, globally-meaningful id. Users: `iss#sub`. Guests: `guest:<name|anon>`. */
  subject: string;
  /** The issuer URL that vouched for a user (empty for guests/local). */
  issuer: string;
  /** Human-readable display name, when known. */
  name: string;
  /**
   * The single **active-persona email** (lowercased), when the issuer asserts one
   * (OB-182 §1.1/§3). Net-new threading from the verified `email` claim — there is
   * never an `emails[]` array (Fork 4/5): one token carries exactly one persona
   * facet. Only ever *trusted* for persona / email-ACL matching when the principal
   * is `verifiedVia==='jws'` AND `issuer === config.emailAuthority` (the
   * `emailIsAuthoritative` gate, B1); on any other principal it is at most an
   * attribution hint. Absent when the issuer asserts no email. */
  email?: string;
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

/**
 * Header carrying the per-run local-owner secret (OB-202 follow-up). The desktop
 * host mints a secret at launch, hands it to the sidecar via env, and its IPC
 * bridge stamps this header on every request that originates in the app's own
 * webview — and ONLY those: tunnel-forwarded requests (marked `FORWARDED_HEADER`)
 * never get it, and any inbound copy is stripped before forwarding. A matching
 * value lets the server treat the request as the machine owner ({@link
 * localPrincipal}), which is what restores the desktop's authority over its own
 * claimed instance when no (or a stale) account identity is present.
 */
export const LOCAL_OWNER_HEADER = 'X-OpenBook-Local';

/** Stable short id for a principal — the value embedded in CRDT edit origins. */
export function principalId(p: Principal): string {
  return p.subject;
}

/**
 * The principal's subject ONLY when it is a cryptographically-verified (`jws`)
 * identity, else `''`. This is the subject that may be stamped as a block's
 * *verified* author (OB-170): guest/local/unverified writers carry no verified
 * attribution, so their edits honestly leave a block un-attributed rather than
 * recording a spoofable or process-local identity. Used on every server write path
 * that stamps per-block authorship (the durable snapshot save + Collab T9's
 * server-authoritative persist).
 */
export function verifiedSubject(p: Principal | null | undefined): string {
  return p?.verifiedVia === 'jws' ? p.subject : '';
}

/**
 * The fixed palette presence/awareness cursors are tinted from (Collab T4). A
 * small, high-contrast set so a handful of simultaneous collaborators stay
 * distinguishable; both the server (when it stamps the verified identity onto an
 * awareness state) and the client (its local self-view) index into the SAME
 * palette so a peer's colour is stable and agreed wherever it's rendered.
 */
export const IDENTITY_COLORS = ['#e4a33c', '#5b8def', '#4fae6e', '#c96bd6', '#e0635c', '#3aa6a6', '#9b6dff', '#d98c40'];

/**
 * A stable presence colour for an identity seed (Collab T4). Derived from the
 * principal's subject (or any stable seed) by a tiny FNV-1a hash into
 * {@link IDENTITY_COLORS}, so the SAME user always tints the SAME colour — across
 * sessions, devices, and both sides of the awareness re-stamp. Deterministic and
 * isomorphic (no crypto), so the server and every client agree without
 * coordinating. An empty seed falls back to the first colour.
 */
export function colorForIdentity(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length];
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
  /**
   * Audience — the data server this assertion is scoped to (OB-177). When
   * present, a verifier MUST reject the token unless `aud` names *itself*, so a
   * server the user connected to can't replay their identity to a different
   * server (confused-deputy / token redirection). Absent on unscoped tokens
   * (the single-server model, where exactly one server trusts the issuer).
   */
  aud?: string;
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

// ── Token revocation (OB-106) ─────────────────────────────────────────────────

/** One revoked subject in an issuer's revocation set. */
export interface RevocationEntry {
  /** The user id (issuer-local `sub`) whose tokens are revoked. */
  sub: string;
  /** Epoch seconds: a token for this `sub` is revoked when its `iat` is older than this. */
  since: number;
  /** Why the subject was revoked (advisory; not part of the trust decision). */
  reason?: 'deleted' | 'signed-out' | string;
}

/**
 * An issuer's set of revoked subjects (OB-106). The issuer publishes it as an
 * EdDSA-signed JWS (same shape as an identity token) which the consumer verifies
 * with {@link verifyRevocations} against the issuer's JWKS, then hands to
 * {@link verifyIdentity}: a token is revoked iff its `iss` matches {@link iss} and
 * this set lists the token's `sub` with `since` newer than the token's `iat`. A
 * short-lived snapshot — the issuer stamps `iat`/`ttl`; the consumer refreshes on
 * its own cadence (and the short token TTL backstops a stale set).
 */
export interface RevocationSet {
  /** Issuer URL these revocations apply to (must equal the token's `iss`). */
  iss: string;
  /** When the issuer produced this snapshot (epoch seconds). */
  iat?: number;
  /** How long the snapshot stays fresh, in seconds (advisory). */
  ttl?: number;
  /** The revoked subjects. */
  revocations: RevocationEntry[];
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
 * Sign an arbitrary JSON payload into a compact EdDSA JWS:
 * `base64url(header).base64url(payload).base64url(sig)`. Shared by the identity
 * assertion ({@link signIdentity}) and the revocation document
 * ({@link signRevocations}) — both are the same JWS shape over a different payload.
 */
async function signCompactJws(privateKeyPkcs8: string, payload: unknown, kid?: string): Promise<string> {
  const header: IdentityHeader = {alg: 'EdDSA', typ: 'JWT', ...(kid ? {kid} : {})};
  const signingInput = `${b64uEncodeString(JSON.stringify(header))}.${b64uEncodeString(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('pkcs8', b64uDecode(privateKeyPkcs8), ED25519, false, ['sign']);
  const sig = await crypto.subtle.sign(ED25519, key, utf8(signingInput));
  return `${signingInput}.${b64uEncode(new Uint8Array(sig))}`;
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
  return signCompactJws(privateKeyPkcs8, claims, kid);
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
  | 'untrusted-issuer'
  | 'wrong-audience'
  /** The issuer revoked this subject's tokens issued before the token's `iat` (OB-106). */
  | 'revoked';

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
  /**
   * This data server's own audience identifier (OB-177). When a token carries an
   * `aud`, it must equal this — otherwise the token was scoped to a *different*
   * server and is rejected (`wrong-audience`). Leave unset only for the
   * single-server model, where the issuer never sets `aud`.
   */
  audience?: string;
  /**
   * Require every token to be audience-bound to {@link audience}: an unscoped
   * (no-`aud`) token is rejected. Set on a multi-server deployment so a server
   * can't be handed an unscoped, freely-replayable assertion.
   */
  requireAudience?: boolean;
  /**
   * The issuer's (already-signature-verified) revocation set (OB-106). When
   * supplied, a token whose `iss` matches the set and whose `sub` is listed with
   * a `since` newer than the token's `iat` is rejected as `revoked`. Obtain it
   * with {@link verifyRevocations} so the set itself is trusted; omit it to skip
   * the revocation check (fail-open — the short token TTL is the backstop).
   */
  revocations?: RevocationSet;
}

/**
 * Verify a compact EdDSA JWS's *signature* against a JWKS. Pure + offline.
 * Returns `'unknown-key'` when no key matches the header `kid`, `'bad-signature'`
 * when candidate keys exist but none validated, and `'ok'` on success. Shared by
 * the identity-token ({@link verifyIdentity}) and revocation-document
 * ({@link verifyRevocations}) verifiers — both prove the same EdDSA signature.
 */
async function verifyCompactSignature(
  jws: string,
  header: IdentityHeader,
  jwks: Jwks,
): Promise<'ok' | 'unknown-key' | 'bad-signature'> {
  // Pick candidate keys: the kid-matched one, else every key (kid is a hint).
  const candidates = header.kid ? jwks.keys.filter((k) => k.kid === header.kid) : jwks.keys;
  if (candidates.length === 0) return 'unknown-key';
  const parts = jws.split('.');
  const signingInput = utf8(`${parts[0]}.${parts[1]}`);
  const sig = b64uDecode(parts[2]);
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey('raw', b64uDecode(jwk.x), ED25519, false, ['verify']);
      if (await crypto.subtle.verify(ED25519, key, sig, signingInput)) return 'ok';
    } catch {
      // Malformed key — try the next candidate.
    }
  }
  return 'bad-signature';
}

/**
 * Verify an identity assertion against an issuer's JWKS. Pure + offline: the
 * caller supplies the (cached) key set, so no network call happens here.
 *
 * Returns `{ok:true, claims}` only on a fresh, signature-valid, in-window,
 * trusted-issuer, non-revoked assertion. On failure returns a reason (and the
 * decoded claims when they parsed, so the server can record a claimed-but-
 * unverified identity).
 */
export async function verifyIdentity(jws: string, jwks: Jwks, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const decoded = decodeIdentity(jws);
  if (!decoded) return {ok: false, reason: 'malformed'};
  const {header, claims} = decoded;
  if (header.alg !== 'EdDSA') return {ok: false, reason: 'unsupported-alg', claims};
  if (opts.allowedIssuers && !opts.allowedIssuers.includes(claims.iss)) {
    return {ok: false, reason: 'untrusted-issuer', claims};
  }

  const sigCheck = await verifyCompactSignature(jws, header, jwks);
  if (sigCheck !== 'ok') return {ok: false, reason: sigCheck, claims};

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

  // Audience binding (OB-177). A scoped token must name THIS server; an unscoped
  // token is accepted only when the server doesn't demand scoping. Checked after
  // the signature so a forged `aud` can't pass — `aud` is inside the signed payload.
  if (typeof claims.aud === 'string' && claims.aud.length > 0) {
    if (!opts.audience || claims.aud !== opts.audience) {
      return {ok: false, reason: 'wrong-audience', claims};
    }
  } else if (opts.requireAudience) {
    return {ok: false, reason: 'wrong-audience', claims};
  }

  // Revocation (OB-106). Checked LAST — after the signature and the time/aud
  // window — so only a genuine, in-window token can ever be marked revoked (a
  // forged token has already failed). The set was signature-verified by the
  // caller (see {@link verifyRevocations}). A token is revoked when its issuer
  // published a revocation for this `sub` whose `since` is newer than the token's
  // `iat`, so a fresh re-login (a newer `iat`) is unaffected.
  const rev = opts.revocations;
  if (rev && rev.iss === claims.iss && typeof claims.iat === 'number') {
    const entry = rev.revocations.find((r) => r.sub === claims.sub);
    if (entry && claims.iat < entry.since) return {ok: false, reason: 'revoked', claims};
  }

  return {ok: true, claims, header};
}

/**
 * Validate + normalise a decoded revocations payload into a {@link RevocationSet}.
 * Returns `null` when the top-level shape is wrong (so a malformed document is
 * ignored rather than trusted), and drops any entry missing a `sub` or a numeric
 * `since`.
 */
function normalizeRevocationSet(payload: unknown): RevocationSet | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as {iss?: unknown; iat?: unknown; ttl?: unknown; revocations?: unknown};
  if (typeof p.iss !== 'string' || !Array.isArray(p.revocations)) return null;
  const revocations: RevocationEntry[] = [];
  for (const raw of p.revocations) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as {sub?: unknown; since?: unknown; reason?: unknown};
    if (typeof e.sub !== 'string' || typeof e.since !== 'number') continue;
    revocations.push({sub: e.sub, since: e.since, ...(typeof e.reason === 'string' ? {reason: e.reason} : {})});
  }
  return {
    iss: p.iss,
    ...(typeof p.iat === 'number' ? {iat: p.iat} : {}),
    ...(typeof p.ttl === 'number' ? {ttl: p.ttl} : {}),
    revocations,
  };
}

/**
 * Verify an issuer's revocation document — a compact EdDSA JWS, the same format
 * as an identity token — against the issuer's JWKS, returning the parsed
 * {@link RevocationSet}. Pure + offline (the caller supplies the cached JWKS).
 * Returns `null` on a malformed document, unsupported alg, or bad signature, so a
 * forged or unsigned document can never revoke anything.
 */
export async function verifyRevocations(jws: string, jwks: Jwks): Promise<RevocationSet | null> {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  let header: IdentityHeader;
  let payload: unknown;
  try {
    header = JSON.parse(b64uDecodeString(parts[0])) as IdentityHeader;
    payload = JSON.parse(b64uDecodeString(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== 'EdDSA') return null;
  if ((await verifyCompactSignature(jws, header, jwks)) !== 'ok') return null;
  return normalizeRevocationSet(payload);
}

/**
 * Sign a revocation document (issuer side / dev / tests) — the counterpart to
 * {@link verifyRevocations}. Produces the same compact EdDSA JWS the account
 * service publishes at its revocations endpoint.
 */
export async function signRevocations(
  privateKeyPkcs8: string,
  set: RevocationSet,
  kid?: string,
): Promise<string> {
  return signCompactJws(privateKeyPkcs8, set, kid);
}

/** The active-persona email (lowercased) carried by an assertion, if any. */
function personaEmail(claims: IdentityClaims): string | undefined {
  const email = claims.email?.trim().toLowerCase();
  return email ? email : undefined;
}

/** Build a verified user principal from validated claims. */
export function principalFromClaims(claims: IdentityClaims, header?: IdentityHeader): Principal {
  const email = personaEmail(claims);
  return {
    kind: 'user',
    subject: `${claims.iss}#${claims.sub}`,
    issuer: claims.iss,
    name: claims.name ?? '',
    ...(email ? {email} : {}),
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
  const email = personaEmail(claims);
  return {
    kind: 'user',
    subject: `${claims.iss}#${claims.sub}`,
    issuer: claims.iss,
    name: claims.name ?? '',
    // Carried for attribution only — an unverified principal is never `jws`, so
    // `emailIsAuthoritative` is false and this email never drives a grant (B1/N8).
    ...(email ? {email} : {}),
    verifiedVia: 'unverified',
    assertion: {jti: claims.jti},
  };
}
