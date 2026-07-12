/**
 * Roster assertion — the LIB-5 versioned signed contract (v1 `workspaceId` →
 * v2 `libraryId`). The signer emits v2; the verifier DUAL-ACCEPTS v1 + v2,
 * fail-closed. This is the canonical, security-critical test: it exercises the
 * full invariant matrix AND exports fixed v2 test vectors so the (separately
 * implemented) account verifier can byte-check agreement with this signer.
 *
 * Invariants under test:
 *  1. Version is pinned from the AUTHENTICATED decoded body BEFORE any crypto.
 *  2. The signed-message prefix is reconstructed from `payload.v`, never hardcoded.
 *  3. The audience field is chosen by an EXPLICIT per-version map (v1 `workspaceId`,
 *     v2 `libraryId`) — never a binary ternary defaulting to v1.
 *  4. A non-empty audience is required; it must equal the expected library id.
 *  5. Possession (Ed25519), 6. symmetric freshness (stale AND future rejected),
 *     7. fail-closed on any bad framing / missing field / bad signature.
 */

import {describe, expect, it} from 'vitest';
import {b64uEncodeString} from './encoding';
import {mintSiteKeypair, signWithSiteKey, type SiteKeypair} from './siteKey';
import {
  ROSTER_ASSERTION_V2,
  ROSTER_ASSERTION_VERSION,
  signRosterAssertion,
  verifyRosterAssertion,
} from './rosterAssertion';

// ─── Canonical v2 test vectors ─────────────────────────────────────────────────
// A FIXED keypair + payload → the EXACT bearer string. Ed25519 is deterministic
// (RFC 8032), so `signRosterAssertion` reproduces `bearer` byte-for-byte. Exported
// so the account-side verifier (a separate implementation, no shared import) can
// assert byte-level agreement with this signer. DO NOT edit the values by hand —
// regenerate the whole tuple together if the wire shape ever changes.
export const V2_VECTOR = {
  /** Raw 32-byte Ed25519 public key, base64url (also embedded as `pub` in the payload). */
  publicKey: 'V1bSKWux63CaNSd4aS0MzZ_VFwVB05B6YOwn-4BWV7Q',
  /** PKCS#8 private key, base64url (the keychain half; the signer's input). */
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIO3ux9SxxRdqR6MruNpKlIxvnKj5kVhAT7ar4kSSXWTE',
  /** The bound library id (a stand-in cuid — the id VALUE is unchanged by LIB-5). */
  libraryId: 'clib_5xample0000000000000',
  /** The `ts` the payload is stamped with (epoch ms). */
  ts: 1_720_000_000_000,
  /** base64url(JSON.stringify({v, pub, libraryId, ts})) — the FIRST bearer segment. */
  payloadB64:
    'eyJ2Ijoib3BlbmJvb2sucm9zdGVyLnYyIiwicHViIjoiVjFiU0tXdXg2M0NhTlNkNGFTME16Wl9WRndWQjA1QjZZT3duLTRCV1Y3USIsImxpYnJhcnlJZCI6ImNsaWJfNXhhbXBsZTAwMDAwMDAwMDAwMDAiLCJ0cyI6MTcyMDAwMDAwMDAwMH0',
  /** base64url(ed25519 sig over `openbook.roster.v2.<payloadB64>`) — the SECOND segment. */
  signature: 'eC_dv4DnLZtHBt3A5uLff0lJJy8u7i-BZGd2DLPKVZh8Aw_5urHwbc5XfHo68OaZauLvhm_Li0nWynWya01zCg',
  /** The full `Authorization: Bearer <…>` value: `payloadB64 + '.' + signature`. */
  bearer:
    'eyJ2Ijoib3BlbmJvb2sucm9zdGVyLnYyIiwicHViIjoiVjFiU0tXdXg2M0NhTlNkNGFTME16Wl9WRndWQjA1QjZZT3duLTRCV1Y3USIsImxpYnJhcnlJZCI6ImNsaWJfNXhhbXBsZTAwMDAwMDAwMDAwMDAiLCJ0cyI6MTcyMDAwMDAwMDAwMH0.eC_dv4DnLZtHBt3A5uLff0lJJy8u7i-BZGd2DLPKVZh8Aw_5urHwbc5XfHo68OaZauLvhm_Li0nWynWya01zCg',
} as const;

/** Sign an ARBITRARY payload under an arbitrary version prefix (to craft negatives). */
async function craft(version: string, payloadObj: Record<string, unknown>, privateKey: string): Promise<string> {
  const payloadB64 = b64uEncodeString(JSON.stringify(payloadObj));
  const signature = await signWithSiteKey(privateKey, `${version}.${payloadB64}`);
  return `${payloadB64}.${signature}`;
}

describe('roster assertion — canonical v2 vectors (cross-repo byte agreement)', () => {
  it('signRosterAssertion reproduces the exact canonical bearer (deterministic Ed25519)', async () => {
    const bearer = await signRosterAssertion({
      privateKey: V2_VECTOR.privateKey,
      publicKey: V2_VECTOR.publicKey,
      libraryId: V2_VECTOR.libraryId,
      now: () => V2_VECTOR.ts,
    });
    expect(bearer).toBe(V2_VECTOR.bearer);
    expect(bearer.split('.')[0]).toBe(V2_VECTOR.payloadB64);
    expect(bearer.split('.')[1]).toBe(V2_VECTOR.signature);
  });

  it('verifies the canonical bearer at ts → normalized {v2, pub, libraryId, ts}', async () => {
    const out = await verifyRosterAssertion({
      assertion: V2_VECTOR.bearer,
      publicKey: V2_VECTOR.publicKey,
      libraryId: V2_VECTOR.libraryId,
      now: V2_VECTOR.ts,
    });
    expect(out).toEqual({
      v: ROSTER_ASSERTION_V2,
      pub: V2_VECTOR.publicKey,
      libraryId: V2_VECTOR.libraryId,
      ts: V2_VECTOR.ts,
    });
  });
});

describe('roster assertion — the dual-accept invariant matrix', () => {
  let kp: SiteKeypair;
  const libraryId = 'clib_matrix000000000000000';
  const at = 1_000_000;

  // Fresh keypair per assertion so signatures are real (not the fixed vector).
  const freshKp = async (): Promise<SiteKeypair> => (kp = await mintSiteKeypair());

  it('v2-sign → verify ✓', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    const out = await verifyRosterAssertion({assertion, publicKey: kp.publicKey, libraryId, now: at});
    expect(out).toMatchObject({v: ROSTER_ASSERTION_V2, pub: kp.publicKey, libraryId, ts: at});
  });

  it('v1-sign (legacy workspaceId) → verify ✓ (normalized to libraryId)', async () => {
    await freshKp();
    // A legitimate v1 body: version tag v1 + the audience under `workspaceId`.
    const v1 = await craft(
      ROSTER_ASSERTION_VERSION,
      {v: ROSTER_ASSERTION_VERSION, pub: kp.publicKey, workspaceId: libraryId, ts: at},
      kp.privateKey,
    );
    const out = await verifyRosterAssertion({assertion: v1, publicKey: kp.publicKey, libraryId, now: at});
    // The v1 audience (read from `workspaceId`) is normalized into `libraryId`.
    expect(out).toMatchObject({v: ROSTER_ASSERTION_VERSION, pub: kp.publicKey, libraryId, ts: at});
  });

  it('a v1 body carrying `libraryId` (not `workspaceId`) → reject', async () => {
    await freshKp();
    // v1 selects the `workspaceId` key STRICTLY — a v1 body that carries only
    // `libraryId` has no audience under its version → reject (no cross-read).
    const forged = await craft(
      ROSTER_ASSERTION_VERSION,
      {v: ROSTER_ASSERTION_VERSION, pub: kp.publicKey, libraryId, ts: at},
      kp.privateKey,
    );
    expect(await verifyRosterAssertion({assertion: forged, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
  });

  it('a v2 body carrying only `workspaceId` (not `libraryId`) → reject', async () => {
    await freshKp();
    const forged = await craft(
      ROSTER_ASSERTION_V2,
      {v: ROSTER_ASSERTION_V2, pub: kp.publicKey, workspaceId: libraryId, ts: at},
      kp.privateKey,
    );
    expect(await verifyRosterAssertion({assertion: forged, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
  });

  it('v2 at the wrong audience → reject', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, libraryId: 'clib_other0000000000000000', now: at})).toBeNull();
  });

  it('unknown / missing `v` → reject (before any crypto)', async () => {
    await freshKp();
    const unknown = await craft('openbook.roster.v3', {v: 'openbook.roster.v3', pub: kp.publicKey, libraryId, ts: at}, kp.privateKey);
    const missing = await craft('openbook.roster.v2', {pub: kp.publicKey, libraryId, ts: at}, kp.privateKey);
    expect(await verifyRosterAssertion({assertion: unknown, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
    expect(await verifyRosterAssertion({assertion: missing, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
  });

  it('the version cannot be flipped without breaking the signature (authenticated `v`)', async () => {
    await freshKp();
    // Sign a body whose `v` says v2, but present it under a v1 prefix's expectations:
    // the verifier reconstructs the prefix from the body's own `v` (v2) → the sig
    // still verifies as v2, and a v1-only reader would read `libraryId`, not
    // `workspaceId`. There is no prefix an attacker can substitute out-of-band.
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    // Tamper the version INSIDE the (base64url) body → signature no longer matches.
    const tamperedBody = b64uEncodeString(JSON.stringify({v: ROSTER_ASSERTION_VERSION, pub: kp.publicKey, workspaceId: libraryId, ts: at}));
    const stolenSig = assertion.split('.')[1];
    expect(await verifyRosterAssertion({assertion: `${tamperedBody}.${stolenSig}`, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
  });

  it('stale OR future `ts` → reject (symmetric ±5 min window)', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, libraryId, now: at + 6 * 60 * 1000})).toBeNull(); // stale
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, libraryId, now: at - 6 * 60 * 1000})).toBeNull(); // future
    expect(await verifyRosterAssertion({assertion, publicKey: kp.publicKey, libraryId, now: at + 4 * 60 * 1000})).not.toBeNull(); // inside
  });

  it('stripped / empty / malformed signature → reject', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    const [body, sig] = assertion.split('.');
    expect(await verifyRosterAssertion({assertion: `${body}.`, publicKey: kp.publicKey, libraryId, now: at})).toBeNull(); // empty sig
    expect(await verifyRosterAssertion({assertion: body, publicKey: kp.publicKey, libraryId, now: at})).toBeNull(); // no dot at all
    const flipped = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    expect(await verifyRosterAssertion({assertion: `${body}.${flipped}`, publicKey: kp.publicKey, libraryId, now: at})).toBeNull(); // wrong sig
    expect(await verifyRosterAssertion({assertion: `${body}.${sig}.extra`, publicKey: kp.publicKey, libraryId, now: at})).toBeNull(); // 3 parts
  });

  it('wrong public key → reject (possession)', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    const other = await mintSiteKeypair();
    expect(await verifyRosterAssertion({assertion, publicKey: other.publicKey, libraryId, now: at})).toBeNull();
  });

  it('a tampered payload byte → reject', async () => {
    await freshKp();
    const assertion = await signRosterAssertion({privateKey: kp.privateKey, publicKey: kp.publicKey, libraryId, now: () => at});
    const [body, sig] = assertion.split('.');
    const tampered = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    expect(await verifyRosterAssertion({assertion: `${tampered}.${sig}`, publicKey: kp.publicKey, libraryId, now: at})).toBeNull();
  });
});
