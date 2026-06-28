// Per-instance roster assertion (OB-199 — "bind instance ↔ workspace").
//
// When a managed instance pulls its bound workspace's roster from the account
// (`GET /api/workspaces/:id/roster`), it must prove it is the SITE that owns the
// binding — not an end user. It does so by signing a short-lived assertion with
// the site's device private key (the same key that double-gates the forwarding
// tunnel attach). The account verifies the signature against the Site row's
// registered public key and that the site is bound to the workspace.
//
// The signing half runs ONLY where the private key lives — the desktop's OS
// keychain — so the raw key never enters the (separate) data-server process. The
// verify half mirrors the relay's `verifyWithSiteKey`; it is provided here so the
// account can adopt one canonical implementation and so the contract is testable
// end-to-end (sign → verify) without the account repo.
//
// Runtime-agnostic (Web Crypto via {@link signWithSiteKey}/{@link verifyWithSiteKey}).

import {b64uDecodeString, b64uEncodeString} from './encoding';
import {signWithSiteKey, verifyWithSiteKey} from './siteKey';

/** The assertion payload version tag — also the signed-message prefix. */
export const ROSTER_ASSERTION_VERSION = 'openbook.roster.v1';

/** Default freshness window for a roster assertion (±5 min — the account's window). */
export const ROSTER_ASSERTION_SKEW_MS = 5 * 60 * 1000;

export interface RosterAssertionPayload {
  /** Fixed protocol tag, {@link ROSTER_ASSERTION_VERSION}. */
  v: typeof ROSTER_ASSERTION_VERSION;
  /** The site's registered public key (raw 32-byte Ed25519, base64url). */
  pub: string;
  /** The workspace the site is asserting it is bound to. */
  workspaceId: string;
  /** Epoch millis the site stamped when signing (freshness). */
  ts: number;
}

/**
 * The exact bytes signed/verified: `openbook.roster.v1.<base64url(payloadJson)>`.
 * Order and separators are fixed so the site and the account never disagree. The
 * base64url payload carries no `.`, so it never collides with the version prefix's
 * dots when the account reconstructs the message from the assertion's first half.
 */
function rosterAssertionMessage(payloadB64: string): string {
  return `${ROSTER_ASSERTION_VERSION}.${payloadB64}`;
}

export interface SignRosterAssertionInput {
  /** base64url PKCS#8 site private key — from the OS keychain. NEVER the data-server. */
  privateKey: string;
  /** The site's registered public key (raw base64url) — the verifiable half. */
  publicKey: string;
  /** The bound workspace id. */
  workspaceId: string;
  /** Clock injection (tests). Defaults to {@link Date.now}. */
  now?: () => number;
}

/**
 * Mint a fresh signed roster assertion bearer for `Authorization: Bearer <…>`.
 * Returns `base64url(payloadJson) + '.' + base64url(ed25519Sig)`. Stamps `ts` at
 * call time, so mint one PER fetch (the account's freshness window is ±5 min).
 */
export async function signRosterAssertion(input: SignRosterAssertionInput): Promise<string> {
  const ts = input.now ? input.now() : Date.now();
  const payload: RosterAssertionPayload = {
    v: ROSTER_ASSERTION_VERSION,
    pub: input.publicKey,
    workspaceId: input.workspaceId,
    ts,
  };
  const payloadB64 = b64uEncodeString(JSON.stringify(payload));
  const signature = await signWithSiteKey(input.privateKey, rosterAssertionMessage(payloadB64));
  return `${payloadB64}.${signature}`;
}

export interface VerifyRosterAssertionInput {
  /** The bearer string produced by {@link signRosterAssertion}. */
  assertion: string;
  /** The site's registered public key (raw base64url) to verify against. */
  publicKey: string;
  /** The workspace the assertion must claim. */
  workspaceId: string;
  /** Clock for the freshness check (ms). Defaults to {@link Date.now}. */
  now?: number;
  /** Freshness window (ms). Defaults to {@link ROSTER_ASSERTION_SKEW_MS}. */
  skewMs?: number;
}

/**
 * Verify a roster assertion (the account side, mirrored here for one canonical
 * impl + end-to-end tests). Returns the parsed payload on success, or `null` on
 * ANY failure — bad framing, wrong version/workspace/pub, a stale `ts`, or a bad
 * signature. Never throws (so it can sit directly in an auth gate).
 */
export async function verifyRosterAssertion(
  input: VerifyRosterAssertionInput,
): Promise<RosterAssertionPayload | null> {
  try {
    const dot = input.assertion.indexOf('.');
    if (dot <= 0 || dot === input.assertion.length - 1) return null;
    const payloadB64 = input.assertion.slice(0, dot);
    const signature = input.assertion.slice(dot + 1);
    if (signature.includes('.')) return null; // exactly two base64url parts

    const parsed = JSON.parse(b64uDecodeString(payloadB64)) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const payload = parsed as Record<string, unknown>;
    if (payload.v !== ROSTER_ASSERTION_VERSION) return null;
    if (typeof payload.pub !== 'string' || payload.pub !== input.publicKey) return null;
    if (typeof payload.workspaceId !== 'string' || payload.workspaceId !== input.workspaceId) return null;
    if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return null;

    const now = input.now ?? Date.now();
    const skewMs = input.skewMs ?? ROSTER_ASSERTION_SKEW_MS;
    if (Math.abs(now - payload.ts) > skewMs) return null;

    const ok = await verifyWithSiteKey(input.publicKey, rosterAssertionMessage(payloadB64), signature);
    if (!ok) return null;
    return {v: ROSTER_ASSERTION_VERSION, pub: payload.pub, workspaceId: payload.workspaceId, ts: payload.ts};
  } catch {
    return null;
  }
}
