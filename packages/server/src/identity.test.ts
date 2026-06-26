import {describe, expect, it} from 'vitest';
import {
  decodeIdentity,
  mintIdentityKeypair,
  principalFromClaims,
  signIdentity,
  unverifiedPrincipalFromClaims,
  verifyIdentity,
  type IdentityClaims,
  type Jwks,
} from '@book.dev/sdk';

const ISS = 'https://account.book.pub';
const NOW = 1_750_000_000_000; // fixed epoch ms for deterministic time checks

async function issuer(kid = 'k1'): Promise<{jwks: Jwks; sign: (c: IdentityClaims) => Promise<string>}> {
  const kp = await mintIdentityKeypair(kid);
  return {
    jwks: {keys: [kp.publicJwk]},
    sign: (claims) => signIdentity(kp.privateKey, claims, kid),
  };
}

const claims = (over: Partial<IdentityClaims> = {}): IdentityClaims => ({
  iss: ISS,
  sub: 'user-123',
  name: 'Caryl',
  iat: Math.floor(NOW / 1000) - 60,
  exp: Math.floor(NOW / 1000) + 3600,
  jti: 'assert-1',
  ...over,
});

describe('identity JWS', () => {
  it('signs and verifies a fresh assertion', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims());
    const res = await verifyIdentity(jws, jwks, {nowMs: NOW, allowedIssuers: [ISS]});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.sub).toBe('user-123');
      const p = principalFromClaims(res.claims, res.header);
      expect(p).toMatchObject({kind: 'user', subject: `${ISS}#user-123`, issuer: ISS, verifiedVia: 'jws'});
      expect(p.assertion).toMatchObject({kid: 'k1', jti: 'assert-1'});
    }
  });

  it('rejects a tampered payload (bad signature)', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims());
    const [h, , s] = jws.split('.');
    // Swap in a different payload, keep the original signature.
    const forged = await issuer();
    const otherJws = await forged.sign(claims({sub: 'attacker'}));
    const tampered = `${h}.${otherJws.split('.')[1]}.${s}`;
    const res = await verifyIdentity(tampered, jwks, {nowMs: NOW});
    expect(res).toMatchObject({ok: false, reason: 'bad-signature'});
  });

  it('rejects an assertion signed by an unknown key', async () => {
    const a = await issuer('k1');
    const b = await issuer('k2');
    const jws = await b.sign(claims());
    const res = await verifyIdentity(jws, a.jwks, {nowMs: NOW});
    // kid k2 is not in issuer a's JWKS.
    expect(res).toMatchObject({ok: false, reason: 'unknown-key'});
  });

  it('rejects an untrusted issuer', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims({iss: 'https://evil.example'}));
    const res = await verifyIdentity(jws, jwks, {nowMs: NOW, allowedIssuers: [ISS]});
    expect(res).toMatchObject({ok: false, reason: 'untrusted-issuer'});
  });

  it('rejects an expired assertion beyond tolerance', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims({exp: Math.floor(NOW / 1000) - 3600}));
    const res = await verifyIdentity(jws, jwks, {nowMs: NOW, clockToleranceSec: 60});
    expect(res).toMatchObject({ok: false, reason: 'expired'});
    // ...but the claimed identity is still recoverable for unverified provenance.
    expect(res.claims?.sub).toBe('user-123');
    const p = unverifiedPrincipalFromClaims(res.claims!);
    expect(p).toMatchObject({kind: 'user', verifiedVia: 'unverified', subject: `${ISS}#user-123`});
  });

  it('honours clock tolerance for slightly-expired assertions', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims({exp: Math.floor(NOW / 1000) - 30}));
    const res = await verifyIdentity(jws, jwks, {nowMs: NOW, clockToleranceSec: 60, allowedIssuers: [ISS]});
    expect(res.ok).toBe(true);
  });

  it('rejects a not-yet-valid assertion', async () => {
    const {jwks, sign} = await issuer();
    const jws = await sign(claims({nbf: Math.floor(NOW / 1000) + 3600}));
    const res = await verifyIdentity(jws, jwks, {nowMs: NOW});
    expect(res).toMatchObject({ok: false, reason: 'not-yet-valid'});
  });

  it('rejects a token scoped to a different audience, accepts a matching one (OB-177)', async () => {
    const {jwks, sign} = await issuer();
    const scoped = await sign(claims({aud: 'https://data-a.example'}));
    // Wrong audience configured.
    expect(await verifyIdentity(scoped, jwks, {nowMs: NOW, audience: 'https://data-b.example'})).toMatchObject({
      ok: false,
      reason: 'wrong-audience',
    });
    // Scoped token but no audience configured → can't confirm we're the target.
    expect(await verifyIdentity(scoped, jwks, {nowMs: NOW})).toMatchObject({ok: false, reason: 'wrong-audience'});
    // Matching audience → accepted.
    expect((await verifyIdentity(scoped, jwks, {nowMs: NOW, audience: 'https://data-a.example'})).ok).toBe(true);
  });

  it('accepts an unscoped token unless audience binding is required (OB-177)', async () => {
    const {jwks, sign} = await issuer();
    const unscoped = await sign(claims());
    // Unscoped is fine even when this server has an audience (single-server model).
    expect((await verifyIdentity(unscoped, jwks, {nowMs: NOW, audience: 'https://data-a.example'})).ok).toBe(true);
    // ...but a server that *requires* scoping rejects an unscoped token.
    expect(
      await verifyIdentity(unscoped, jwks, {nowMs: NOW, audience: 'https://data-a.example', requireAudience: true}),
    ).toMatchObject({ok: false, reason: 'wrong-audience'});
  });

  it('decodes claims without verifying (display / fallback)', async () => {
    const {sign} = await issuer();
    const jws = await sign(claims());
    const d = decodeIdentity(jws);
    expect(d?.claims.name).toBe('Caryl');
    expect(decodeIdentity('not-a-jws')).toBeNull();
  });
});
