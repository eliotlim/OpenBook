/**
 * Audience-bind orchestration (OB-202) — the failure-safe choreography that turns
 * forwarding on/off without ever stranding the loopback owner. Exercised entirely
 * through the `setInstancePolicy` / `getInstanceInfo` seams (i.e. `PUT/GET
 * /api/instance`) over a fake instance, NOT by poking the store: these prove the
 * three-phase ORDER, the mid-sequence rollback, the disable cleanup, and the
 * relaunch ensure-scoped short-circuit.
 */

import {describe, it, expect} from 'vitest';
import {guestPrincipal, type InstanceConfig, type Principal} from '@book.dev/sdk';
import {
  bindForwardingAudience,
  ensureClaimedForForwarding,
  ensureForwardingAudience,
  unbindForwardingAudience,
  type AudienceBindDeps,
} from '../forwardingAudience';

const HOST = 'demo-xyz.book.cloud';

/** A verified (jws) signed-in identity, as the server resolves the owner over loopback. */
const verifiedYou = (subject = 'https://account.book.pub#me'): Principal => ({
  kind: 'user',
  subject,
  issuer: 'https://account.book.pub',
  name: 'me',
  verifiedVia: 'jws',
});

interface FakeOpts {
  initial?: {audience: string | null; requireAudience: boolean};
  /** Does the (fake) account issuer mint a token scoped to the recorded audience? */
  issuerScopes?: boolean;
  /** Override the mint result (e.g. always `null` for a transient mint failure). */
  remintResult?: (localAudience: string | null) => string | null;
  /** Throw from `setInstancePolicy` when the patch matches (simulate a rejected PUT). */
  failPolicyWhen?: (patch: Partial<InstanceConfig>) => boolean;
  /** The instance's claim state at the start (default unclaimed). */
  ownerSubject?: string | null;
  /** Who the server resolves you to be (default an anonymous guest). */
  you?: Principal;
}

function makeFake(opts: FakeOpts = {}) {
  const issuerScopes = opts.issuerScopes ?? true;
  const you = opts.you ?? guestPrincipal();
  const state = {
    audience: opts.initial?.audience ?? null,
    requireAudience: opts.initial?.requireAudience ?? false,
    ownerSubject: opts.ownerSubject ?? null,
    localAudience: null as string | null,
    reminted: 0,
    ops: [] as string[],
  };
  const deps: AudienceBindDeps = {
    async setInstancePolicy(patch) {
      state.ops.push(`policy:${JSON.stringify(patch)}`);
      if (opts.failPolicyWhen?.(patch)) throw new Error('policy write rejected');
      // The owner-claim CAS: the patch value only TRIGGERS the claim; the server binds
      // the request's VERIFIED principal subject, and only a jws identity may claim.
      if (patch.ownerSubject !== undefined && !state.ownerSubject && you.verifiedVia === 'jws') {
        state.ownerSubject = you.subject;
      }
      if (patch.audience !== undefined) state.audience = patch.audience ?? null;
      if (patch.requireAudience !== undefined) state.requireAudience = !!patch.requireAudience;
      return {
        guestAccess: 'write',
        trustedIssuers: [],
        ownerSubject: state.ownerSubject ?? undefined,
        audience: state.audience ?? undefined,
        requireAudience: state.requireAudience,
      };
    },
    async getInstanceInfo() {
      state.ops.push('info');
      return {
        guestAccess: 'write',
        ownerSubject: state.ownerSubject,
        trustedIssuers: [],
        audience: state.audience,
        requireAudience: state.requireAudience,
        you,
      };
    },
    async remintIdentity() {
      state.ops.push('mint');
      state.reminted += 1;
      if (opts.remintResult) return opts.remintResult(state.localAudience);
      return issuerScopes && state.localAudience ? state.localAudience : null;
    },
    setLocalAudience(host) {
      state.ops.push(`local:${host ?? 'null'}`);
      state.localAudience = host;
    },
  };
  return {deps, state};
}

describe('bindForwardingAudience — the seamless 3-phase switch', () => {
  it('happy path: accepts → scopes the owner token → requires, in that order', async () => {
    const {deps, state} = makeFake({issuerScopes: true});
    const outcome = await bindForwardingAudience(HOST, deps);

    expect(outcome).toEqual({status: 'bound'});
    expect(state.audience).toBe(HOST);
    expect(state.requireAudience).toBe(true);
    expect(state.localAudience).toBe(HOST);
    // Order matters: requireAudience is asserted ONLY after the owner token is scoped.
    expect(state.ops).toEqual([
      `policy:${JSON.stringify({audience: HOST, requireAudience: false})}`,
      `local:${HOST}`,
      'mint',
      `policy:${JSON.stringify({requireAudience: true})}`,
    ]);
  });

  it('rollback: never requires the audience when the owner token is not host-scoped', async () => {
    // The issuer returns an unscoped token (no audience allowlist) — phase 3 must NOT run.
    const {deps, state} = makeFake({issuerScopes: false});
    const outcome = await bindForwardingAudience(HOST, deps);

    expect(outcome.status).toBe('partial');
    expect(state.audience).toBe(HOST); // kept — still rejects a *different* site's token
    expect(state.requireAudience).toBe(false); // NOT required over an unscoped owner token
    // requireAudience:true was never written.
    expect(state.ops).not.toContain(`policy:${JSON.stringify({requireAudience: true})}`);
  });

  it('rollback: a transient mint failure holds at requireAudience:false (no lockout)', async () => {
    const {deps, state} = makeFake({remintResult: () => null}); // mint resolved null (transient)
    const outcome = await bindForwardingAudience(HOST, deps);

    expect(outcome.status).toBe('partial');
    expect(state.requireAudience).toBe(false);
  });

  it('rollback: a phase-3 PUT failure relaxes back, leaving loopback open', async () => {
    const {deps, state} = makeFake({
      issuerScopes: true,
      failPolicyWhen: (p) => p.requireAudience === true, // the phase-3 require throws
    });
    const outcome = await bindForwardingAudience(HOST, deps);

    expect(outcome.status).toBe('failed');
    // The catch relaxed back — the instance is NOT left requiring the audience.
    expect(state.requireAudience).toBe(false);
    expect(state.ops).toContain(`policy:${JSON.stringify({requireAudience: false})}`);
  });
});

describe('ensureForwardingAudience — relaunch (#4)', () => {
  it('fresh enable (no binding yet) runs the full 3-phase bind', async () => {
    const {deps, state} = makeFake({initial: {audience: null, requireAudience: false}, issuerScopes: true});
    const outcome = await ensureForwardingAudience(HOST, deps);

    expect(outcome).toEqual({status: 'bound'});
    expect(state.requireAudience).toBe(true);
    // It did the full bind (read info, then the phase-1 accept PUT).
    expect(state.ops).toContain(`policy:${JSON.stringify({audience: HOST, requireAudience: false})}`);
  });

  it('already bound: re-scopes this session WITHOUT relaxing (no transient open window)', async () => {
    const {deps, state} = makeFake({initial: {audience: HOST, requireAudience: true}, issuerScopes: true});
    const outcome = await ensureForwardingAudience(HOST, deps);

    expect(outcome).toEqual({status: 'bound'});
    expect(state.requireAudience).toBe(true);
    // The key #4 guarantee: it NEVER writes the policy on relaunch — only re-scopes
    // the owner token — so `requireAudience` is never transiently dropped.
    expect(state.ops.some((o) => o.startsWith('policy:'))).toBe(false);
    expect(state.ops).toEqual(['info', `local:${HOST}`, 'mint']);
  });

  it('already bound but cannot re-scope this launch: does NOT relax the server', async () => {
    const {deps, state} = makeFake({initial: {audience: HOST, requireAudience: true}, issuerScopes: false});
    const outcome = await ensureForwardingAudience(HOST, deps);

    expect(outcome.status).toBe('partial');
    expect(state.requireAudience).toBe(true); // left intact — the binding survives a bad launch
    expect(state.ops.some((o) => o.startsWith('policy:'))).toBe(false);
  });
});

describe('unbindForwardingAudience — disable cleanup (Fix 2)', () => {
  it('relax confirmed: clears the scoping and re-mints unscoped, in that order', async () => {
    const {deps, state} = makeFake({initial: {audience: HOST, requireAudience: true}});
    state.localAudience = HOST; // owner token currently scoped
    const outcome = await unbindForwardingAudience(deps);

    expect(outcome).toEqual({status: 'relaxed'});
    expect(state.requireAudience).toBe(false);
    expect(state.localAudience).toBeNull(); // unscoped only AFTER the relax
    expect(state.ops).toEqual([
      `policy:${JSON.stringify({requireAudience: false})}`,
      'local:null',
      'mint',
    ]);
  });

  it('relax NOT confirmed: leaves scoping intact rather than lock the owner out', async () => {
    const {deps, state} = makeFake({
      initial: {audience: HOST, requireAudience: true},
      failPolicyWhen: (p) => p.requireAudience === false, // the relax PUT is rejected
    });
    state.localAudience = HOST;
    const outcome = await unbindForwardingAudience(deps);

    expect(outcome.status).toBe('held');
    // The owner is NOT unscoped while the server still requires the audience.
    expect(state.localAudience).toBe(HOST);
    expect(state.requireAudience).toBe(true);
    expect(state.reminted).toBe(0); // never re-minted an unscoped token
  });
});

describe('ensureClaimedForForwarding — publish implies claim (OB-209)', () => {
  it('unclaimed + verified identity: atomically claims to the owner subject before exposing', async () => {
    const {deps, state} = makeFake({ownerSubject: null, you: verifiedYou('https://account.book.pub#owner')});
    const outcome = await ensureClaimedForForwarding(deps);

    expect(outcome).toEqual({status: 'claimed'});
    // It claimed to the VERIFIED subject via the policy seam (the CAS on the server).
    expect(state.ownerSubject).toBe('https://account.book.pub#owner');
    expect(state.ops).toContain(`policy:${JSON.stringify({ownerSubject: 'https://account.book.pub#owner'})}`);
  });

  it('unclaimed + UNVERIFIED (guest): refuses, and never writes a claim', async () => {
    const {deps, state} = makeFake({ownerSubject: null, you: guestPrincipal('Anon')});
    const outcome = await ensureClaimedForForwarding(deps);

    expect(outcome.status).toBe('refused');
    expect(state.ownerSubject).toBeNull();
    // No policy write attempted — we never expose an unclaimed instance.
    expect(state.ops.some((o) => o.startsWith('policy:'))).toBe(false);
  });

  it('already claimed: a no-op (idempotent re-enable), never re-writes the owner', async () => {
    const {deps, state} = makeFake({
      ownerSubject: 'https://account.book.pub#someone',
      you: verifiedYou('https://account.book.pub#me'),
    });
    const outcome = await ensureClaimedForForwarding(deps);

    expect(outcome).toEqual({status: 'already'});
    expect(state.ownerSubject).toBe('https://account.book.pub#someone'); // untouched
    expect(state.ops.some((o) => o.startsWith('policy:'))).toBe(false);
  });

  it('claim write rejected but a concurrent claim landed: re-reads and proceeds (claimed)', async () => {
    // The claim PUT throws (a race claimed it first); the re-read then shows it owned,
    // so exposing is safe regardless of who won.
    const claimed = makeFake({ownerSubject: null, you: verifiedYou()});
    // Simulate the racer's win: reject our write AND flip the state to claimed.
    const {deps, state} = claimed;
    let threw = false;
    const wrapped: AudienceBindDeps = {
      ...deps,
      async setInstancePolicy() {
        threw = true;
        state.ownerSubject = 'https://account.book.pub#racer'; // someone else won the CAS
        throw new Error('this instance has already been claimed');
      },
    };
    const outcome = await ensureClaimedForForwarding(wrapped);

    expect(threw).toBe(true);
    expect(outcome).toEqual({status: 'claimed'}); // landed (the racer's), so exposure is safe
  });
});
