// Per-instance roster assertion (OB-199 — "bind instance ↔ library").
//
// When a managed instance pulls its bound library's roster from the account
// (`GET /api/libraries/:id/roster`), it must prove it is the SITE that owns the
// binding — not an end user. It does so by signing a short-lived assertion with
// the site's device private key (the same key that double-gates the forwarding
// tunnel attach). The account verifies the signature against the Site row's
// registered public key and that the site is bound to the library.
//
// The signing half runs ONLY where the private key lives — the desktop's OS
// keychain — so the raw key never enters the (separate) data-server process. The
// verify half mirrors the relay's `verifyWithSiteKey`; it is provided here so the
// account can adopt one canonical implementation and so the contract is testable
// end-to-end (sign → verify) without the account repo.
//
// LIB-5 — the wire field renamed from `workspaceId` → `libraryId`. Because the
// field name lives INSIDE the signed bytes, the rename is versioned: the signer
// emits `openbook.roster.v2` (carrying `libraryId`) while the verifier
// DUAL-ACCEPTS v1 (`workspaceId`) + v2 (`libraryId`), fail-closed. The version is
// authenticated (it is part of the signed payload AND the signed-message prefix),
// so an attacker can never flip v1↔v2 without breaking the signature, and the
// verifier never trusts an out-of-band version. See the LIB-5 design + runbook.
//
// Runtime-agnostic (Web Crypto via {@link signWithSiteKey}/{@link verifyWithSiteKey}).

import {b64uDecodeString, b64uEncodeString} from './encoding';
import {signWithSiteKey, verifyWithSiteKey} from './siteKey';

/** The legacy assertion version tag (v1) — carries `workspaceId`. Still ACCEPTED. */
export const ROSTER_ASSERTION_VERSION = 'openbook.roster.v1';

/** The current assertion version tag (v2, LIB-5) — carries `libraryId`. What the signer emits. */
export const ROSTER_ASSERTION_V2 = 'openbook.roster.v2';

/**
 * Every version tag the verifier accepts (dual-accept v1 + v2). Pinned BEFORE any
 * crypto runs — an unknown / absent `v` is rejected without a signature check, so
 * there is no downgrade oracle. Retiring v1 is a later, reversible step (drop it
 * from this set) — never do it while any un-updatable desktop build still signs v1.
 */
export const ACCEPTED_ROSTER_VERSIONS = [ROSTER_ASSERTION_VERSION, ROSTER_ASSERTION_V2] as const;

/** An accepted roster-assertion version tag. */
export type RosterAssertionVersion = (typeof ACCEPTED_ROSTER_VERSIONS)[number];

/**
 * Which JSON key carries the audience (the bound library id) PER version. v1 signed
 * `workspaceId`; v2 renames the KEY to `libraryId` (the id VALUE — a cuid — is
 * UNCHANGED). The verifier selects this field strictly from the AUTHENTICATED `v`
 * via THIS explicit map — never a binary ternary that defaults to v1 — so a v1 body
 * can't be re-read as v2 (or vice-versa): each version reads only its own key, and
 * a body carrying the wrong key resolves to `undefined` → reject.
 */
const AUDIENCE_KEY_BY_VERSION: Record<RosterAssertionVersion, 'workspaceId' | 'libraryId'> = {
  [ROSTER_ASSERTION_VERSION]: 'workspaceId',
  [ROSTER_ASSERTION_V2]: 'libraryId',
};

/** Narrow an arbitrary string to an accepted version tag (pinned before crypto). */
export function isAcceptedRosterVersion(v: unknown): v is RosterAssertionVersion {
  return v === ROSTER_ASSERTION_VERSION || v === ROSTER_ASSERTION_V2;
}

/** Default freshness window for a roster assertion (±5 min — the account's window). */
export const ROSTER_ASSERTION_SKEW_MS = 5 * 60 * 1000;

/** The legacy (v1) assertion payload — carries `workspaceId`. Still verifiable. */
export interface RosterAssertionV1Payload {
  /** Fixed protocol tag, {@link ROSTER_ASSERTION_VERSION}. */
  v: typeof ROSTER_ASSERTION_VERSION;
  /** The site's registered public key (raw 32-byte Ed25519, base64url). */
  pub: string;
  /** The library the site is asserting it is bound to (legacy key name). */
  workspaceId: string;
  /** Epoch millis the site stamped when signing (freshness). */
  ts: number;
}

/** The current (v2, LIB-5) assertion payload — carries `libraryId`. What the signer emits. */
export interface RosterAssertionV2Payload {
  /** Fixed protocol tag, {@link ROSTER_ASSERTION_V2}. */
  v: typeof ROSTER_ASSERTION_V2;
  /** The site's registered public key (raw 32-byte Ed25519, base64url). */
  pub: string;
  /** The library the site is asserting it is bound to (renamed from `workspaceId`; SAME id value). */
  libraryId: string;
  /** Epoch millis the site stamped when signing (freshness). */
  ts: number;
}

/** Any accepted roster-assertion payload (v1 or v2). */
export type RosterAssertionPayload = RosterAssertionV1Payload | RosterAssertionV2Payload;

/**
 * The exact bytes signed/verified: `<version>.<base64url(payloadJson)>`. The version
 * prefix is derived from the payload's OWN `v` tag (never hardcoded), so the signed
 * message and the authenticated version can never disagree. The base64url payload
 * carries no `.`, so it never collides with the version prefix's dots when the
 * account reconstructs the message from the assertion's first half.
 */
function rosterAssertionMessage(version: RosterAssertionVersion, payloadB64: string): string {
  return `${version}.${payloadB64}`;
}

export interface SignRosterAssertionInput {
  /** base64url PKCS#8 site private key — from the OS keychain. NEVER the data-server. */
  privateKey: string;
  /** The site's registered public key (raw base64url) — the verifiable half. */
  publicKey: string;
  /** The bound library id (renamed from `workspaceId`; SAME id value). */
  libraryId: string;
  /** Clock injection (tests). Defaults to {@link Date.now}. */
  now?: () => number;
}

/**
 * Mint a fresh signed roster assertion bearer for `Authorization: Bearer <…>`.
 * Emits `openbook.roster.v2` (`libraryId`). Returns
 * `base64url(payloadJson) + '.' + base64url(ed25519Sig)`. Stamps `ts` at call time,
 * so mint one PER fetch (the account's freshness window is ±5 min).
 */
export async function signRosterAssertion(input: SignRosterAssertionInput): Promise<string> {
  const ts = input.now ? input.now() : Date.now();
  const payload: RosterAssertionV2Payload = {
    v: ROSTER_ASSERTION_V2,
    pub: input.publicKey,
    libraryId: input.libraryId,
    ts,
  };
  const payloadB64 = b64uEncodeString(JSON.stringify(payload));
  const signature = await signWithSiteKey(input.privateKey, rosterAssertionMessage(ROSTER_ASSERTION_V2, payloadB64));
  return `${payloadB64}.${signature}`;
}

export interface VerifyRosterAssertionInput {
  /** The bearer string produced by {@link signRosterAssertion}. */
  assertion: string;
  /** The site's registered public key (raw base64url) to verify against. */
  publicKey: string;
  /** The library the assertion must claim (renamed from `workspaceId`; SAME id value). */
  libraryId: string;
  /** Clock for the freshness check (ms). Defaults to {@link Date.now}. */
  now?: number;
  /** Freshness window (ms). Defaults to {@link ROSTER_ASSERTION_SKEW_MS}. */
  skewMs?: number;
}

/**
 * A verified roster assertion, version-normalized. `libraryId` is the audience read
 * from whichever key the AUTHENTICATED version carries (v1 `workspaceId`, v2
 * `libraryId`) — callers always read `libraryId` regardless of the on-wire version.
 */
export interface VerifiedRosterAssertion {
  /** The authenticated version tag that verified. */
  v: RosterAssertionVersion;
  /** The site's public key the signature verified against. */
  pub: string;
  /** The bound library id (normalized name, whatever the on-wire key). */
  libraryId: string;
  /** The signer's stamped epoch-millis timestamp. */
  ts: number;
}

/**
 * Verify a roster assertion (the account side, mirrored here for one canonical
 * impl + end-to-end tests). DUAL-ACCEPTS v1 + v2. Returns the version-normalized
 * result on success, or `null` on ANY failure — bad framing, unknown/absent
 * version, missing/mistyped field, wrong library/pub, a stale/future `ts`, or a bad
 * signature. Never throws (so it can sit directly in an auth gate).
 *
 * Fail-closed order (all BEFORE trusting anything): frame → decode → pin the
 * version from the authenticated body → select the audience field by the
 * per-version map → require a non-empty audience that matches → freshness →
 * Ed25519 verify over the prefix reconstructed from the authenticated version.
 */
export async function verifyRosterAssertion(
  input: VerifyRosterAssertionInput,
): Promise<VerifiedRosterAssertion | null> {
  try {
    const dot = input.assertion.indexOf('.');
    if (dot <= 0 || dot === input.assertion.length - 1) return null;
    const payloadB64 = input.assertion.slice(0, dot);
    const signature = input.assertion.slice(dot + 1);
    if (!signature || signature.includes('.')) return null; // exactly two non-empty base64url parts

    const parsed = JSON.parse(b64uDecodeString(payloadB64)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const payload = parsed as Record<string, unknown>;

    // (1) Pin the version from the AUTHENTICATED, decoded body BEFORE any crypto.
    // Unknown / absent → reject with no signature check (no downgrade oracle).
    const version = payload.v;
    if (!isAcceptedRosterVersion(version)) return null;

    // (2/3) Select the audience field by an EXPLICIT per-version map — never a
    // binary ternary defaulting to v1. A v1 body carrying `libraryId` reads its
    // (absent) `workspaceId` key → undefined → reject; a v2 body reads `libraryId`.
    const aud = payload[AUDIENCE_KEY_BY_VERSION[version]];

    if (typeof payload.pub !== 'string' || payload.pub !== input.publicKey) return null;
    if (typeof aud !== 'string' || !aud) return null; // (4) non-empty audience required
    if (aud !== input.libraryId) return null; // audience bind — id VALUE unchanged
    if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return null;

    const now = input.now ?? Date.now();
    const skewMs = input.skewMs ?? ROSTER_ASSERTION_SKEW_MS;
    if (Math.abs(now - payload.ts) > skewMs) return null; // symmetric — rejects stale AND future

    // Reconstruct the signed prefix from the AUTHENTICATED version, never a constant.
    const ok = await verifyWithSiteKey(input.publicKey, rosterAssertionMessage(version, payloadB64), signature);
    if (!ok) return null;
    return {v: version, pub: payload.pub, libraryId: aud, ts: payload.ts};
  } catch {
    return null;
  }
}
