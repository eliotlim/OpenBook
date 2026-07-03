/**
 * Audience-bind orchestration for forwarding (OB-202).
 *
 * Enabling the tunnel binds the instance's identity `audience` to its canonical
 * `<prefix>.book.cloud` host with `requireAudience` (OB-177), so the edge's
 * aud-scoped viewer tokens verify and a token minted for a *different* site is
 * rejected. The catch: the local owner reaches the SAME server over loopback with
 * their OWN token, so requiring the audience while that token is still unscoped
 * would lock the owner out — yet the owner's token can't be scoped to the host
 * until the server already accepts it.
 *
 * This module is the failure-safe choreography that resolves that chicken-and-egg
 * WITHOUT ever stranding the owner. It is pure (all side effects injected) so the
 * three-phase sequence, the mid-sequence rollback, the disable cleanup, and the
 * relaunch short-circuit are all exercised against `setInstancePolicy` /
 * `PUT /api/instance` in tests — never by poking the store directly.
 */

import {type InstanceConfig, type InstanceInfo} from '@book.dev/sdk';

/** Side effects the audience-bind drives, injected so the logic stays testable. */
export interface AudienceBindDeps {
  /** `PUT /api/instance` — the audience-policy write (gated server-side). */
  setInstancePolicy(patch: Partial<InstanceConfig>): Promise<InstanceConfig>;
  /** `GET /api/instance` — to read the persisted `audience` + `requireAudience`. */
  getInstanceInfo(): Promise<InstanceInfo>;
  /**
   * Re-mint the owner's own identity token, scoped to whatever
   * {@link setLocalAudience} last recorded. Resolves to the audience the issuer
   * ACTUALLY scoped the minted token to — `null` when it returned an unscoped
   * token (the issuer scopes only when it runs an audience allowlist) or when
   * nothing could be minted. The bind decision turns on this REAL value, never on
   * the audience we merely *asked* for.
   */
  remintIdentity(): Promise<string | null>;
  /** Record (or clear, with `null`) the host the owner's token is scoped to. */
  setLocalAudience(host: string | null): void;
  /**
   * Whether the account service issues identity JWSes at all (AccountProvider's
   * `identityIssuance`). `unconfigured` means the service answered 501 — terminal,
   * so an unverified claim refusal should say "issuance is disabled" instead of
   * offering the refresh-identity affordance (which would loop forever). Optional
   * so non-UI callers need not wire it; absent, refusals stay `unverified`.
   */
  identityIssuance?(): 'unknown' | 'ok' | 'unconfigured';
}

/**
 * A stable, localizable code for every non-clean audience outcome (OB-202). The UI
 * maps each to a `forwarding.*` message via `t()`; the English `reason` carried
 * alongside stays for logging and is the `{error}` detail for the failure codes.
 */
export type AudienceNoticeCode = 'partialUnscoped' | 'ensureRescope' | 'bindFailed' | 'unbindHeld';

/** The result of binding (or ensuring) the forwarded audience. */
export type AudienceBindOutcome =
  /** Phase 3 reached: `requireAudience` is on and the owner's token is host-scoped. */
  | {status: 'bound'}
  /**
   * The `audience` is set but `requireAudience` stays OFF, because no host-scoped
   * owner token exists (the issuer doesn't scope, or the mint failed) — `partialUnscoped`
   * — or a resumed session couldn't re-scope this launch (`ensureRescope`). A token for
   * a *different* site is still rejected; only unscoped tokens stay accepted — no
   * strict isolation, but crucially no loopback lockout.
   */
  | {status: 'partial'; code: 'partialUnscoped' | 'ensureRescope'; reason: string}
  /** A phase threw; the binding was relaxed back so loopback stays open. */
  | {status: 'failed'; code: 'bindFailed'; reason: string};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** User-facing reason for the `partial` outcome (issuer returned an unscoped token). */
export const PARTIAL_UNSCOPED_REASON =
  'Forwarding is on, but your account did not issue a site-scoped owner token, so strict ' +
  'audience isolation stays off (a token minted for a different site is still rejected, and ' +
  'the tunnel works normally).';

/** User-facing reason when a resumed session can't (yet) re-scope the owner token. */
export const ENSURE_RESCOPE_REASON =
  'Forwarding resumed, but this session could not scope your owner token to the site yet. ' +
  'Your existing access is unchanged; sign in again if a request is refused.';

/**
 * Bind the forwarded `host` as this instance's required audience via the seamless
 * three-phase switch — and never leave the instance requiring an audience the
 * owner's own token can't satisfy:
 *
 *  1. **accept** the host audience but don't REQUIRE it (the owner's still-unscoped
 *     loopback token keeps verifying);
 *  2. **scope** the owner's own token to the host AND confirm the issuer really
 *     scoped it — phase 3 proceeds ONLY on a confirmed host-scoped credential;
 *  3. **require** the audience: owner (scoped) + edge tokens carry it, others fail.
 *
 * If phase 2 can't confirm a host-scoped token, hold at `requireAudience:false`
 * (a `partial` outcome) rather than lock the owner out. If any phase throws, relax
 * back to `requireAudience:false` (best-effort) so loopback stays open — the
 * server's loopback-owner recovery still relaxes it even if that PUT is itself
 * rejected.
 */
export async function bindForwardingAudience(host: string, deps: AudienceBindDeps): Promise<AudienceBindOutcome> {
  try {
    // Phase 1 — accept the audience without requiring it yet.
    await deps.setInstancePolicy({audience: host, requireAudience: false});
    // Phase 2 — scope the owner's token, then CONFIRM it actually carries the host
    // aud. The issuer may hand back an unscoped token even though we asked for one.
    deps.setLocalAudience(host);
    const mintedAud = await deps.remintIdentity();
    if (mintedAud !== host) {
      // No host-scoped owner token: requiring the audience now would 401 the owner
      // over loopback. Hold at `requireAudience:false` and report why.
      return {status: 'partial', code: 'partialUnscoped', reason: PARTIAL_UNSCOPED_REASON};
    }
    // Phase 3 — both the owner (scoped) and the edge carry the audience; require it.
    await deps.setInstancePolicy({requireAudience: true});
    return {status: 'bound'};
  } catch (e) {
    // A phase threw after `audience` may have been set. Never leave the instance
    // requiring an audience the owner can't satisfy: relax back so loopback stays
    // open. If even this PUT is rejected (the owner is already audience-locked), the
    // server's loopback-owner recovery accepts a `requireAudience:false` relax from
    // the signature-verified owner regardless of their token's audience.
    try {
      await deps.setInstancePolicy({requireAudience: false});
    } catch {
      /* recovery-on-the-server is the last line; surface the original error below */
    }
    return {status: 'failed', code: 'bindFailed', reason: errText(e)};
  }
}

/**
 * Resume the audience binding on launch WITHOUT relaxing it every time. When the
 * server already persisted `audience==host && requireAudience` (a previous session
 * reached phase 3), only re-scope THIS session's owner token — don't transiently
 * drop `requireAudience` (which would reopen the unscoped-token window on every
 * relaunch). Otherwise (fresh enable, or a prior `partial`), run the full bind.
 */
export async function ensureForwardingAudience(host: string, deps: AudienceBindDeps): Promise<AudienceBindOutcome> {
  let info: InstanceInfo | null = null;
  try {
    info = await deps.getInstanceInfo();
  } catch {
    info = null; // can't read policy — fall through to a full (idempotent) bind
  }
  if (info && info.audience === host && info.requireAudience) {
    // Already bound; just make sure this session's owner token is host-scoped.
    deps.setLocalAudience(host);
    const mintedAud = await deps.remintIdentity();
    if (mintedAud === host) return {status: 'bound'};
    // Couldn't re-scope this launch. Don't relax the server (that would defeat the
    // persisted binding); the owner keeps any still-valid scoped token, and the
    // loopback-owner recovery covers a hard lockout.
    return {status: 'partial', code: 'ensureRescope', reason: ENSURE_RESCOPE_REASON};
  }
  return bindForwardingAudience(host, deps);
}

/** The result of ensuring the instance is claimed before it is exposed. */
export type ForwardingClaimOutcome =
  /** We atomically claimed ownership to the enabling account's verified subject. */
  | {status: 'claimed'}
  /** Already claimed (by this owner or anyone) — nothing to do; safe to expose. */
  | {status: 'already'}
  /**
   * Couldn't claim, so we won't expose. `code` is the stable discriminant the surface
   * localizes + styles by severity: `unverified` is a precondition the signed-in owner
   * clears by verifying their identity (NOT a crash); `issuance-disabled` is that same
   * precondition made TERMINAL — the account server can't mint identities at all (501),
   * so no refresh will ever clear it; `claim-failed` is a genuine failure. `reason` is
   * the English fallback for logs / non-UI callers — the UI routes `code` through `t()`
   * (`forwarding.claimRefusedUnverified` / `forwarding.claimRefusedIssuanceDisabled` /
   * `forwarding.claimFailed`).
   */
  | {status: 'refused'; code: 'unverified' | 'issuance-disabled' | 'claim-failed'; reason: string};

/**
 * English fallback when forwarding is refused because the account identity is not
 * JWS-verified yet (on desktop the default owner is `verifiedVia:'local'`). The owner
 * IS already signed in on this path — what's missing is a verified identity, not an
 * account — so this guides verifying, not signing in. UI: `forwarding.claimRefusedUnverified`.
 */
export const UNVERIFIED_CLAIM_REASON =
  'To publish, your account identity needs to be verified first.';

/**
 * English fallback when the identity can never be verified on this account service:
 * it answered 501 — identity issuance is disabled there — so, unlike `unverified`,
 * no "refresh identity" retry can succeed. UI: `forwarding.claimRefusedIssuanceDisabled`.
 */
export const ISSUANCE_DISABLED_CLAIM_REASON =
  'To publish, a verified identity is required — but the account server has identity issuance disabled.';

/** English fallback when the claim write did not land. UI: `forwarding.claimFailed`. */
export const CLAIM_FAILED_REASON =
  'Couldn’t claim this device for your account, so it wasn’t published. Try again.';

/**
 * Publish-implies-claim (OB-209). Forwarding turns the local instance into a public
 * ingress that BYPASSES the boot exposure backstop (`assertExposureSafe` only guards
 * a listener bind; the tunnel reaches the loopback server). An UNCLAIMED instance
 * short-circuits `authorize()` rule-0 to the legacy guest gate (default
 * `guestAccess:'write'`) — so exposing it unclaimed = anonymous world-write. We
 * therefore CLAIM before we expose: atomically bind ownership to the enabling
 * account's OWN verified subject (the server routes this through the OB-191 CAS and
 * only ever binds the verified principal — never a client-supplied value), and refuse
 * to dial out when there is no verified identity to claim with. Idempotent: a
 * re-enable on an already-claimed instance is a no-op.
 */
export async function ensureClaimedForForwarding(deps: AudienceBindDeps): Promise<ForwardingClaimOutcome> {
  const info = await deps.getInstanceInfo();
  if (info.ownerSubject) return {status: 'already'}; // claim is one-way; already safe to expose
  // Unclaimed: only a verified (jws) identity may claim — and publish requires one.
  if (info.you.verifiedVia !== 'jws') {
    // Distinguish "verify and retry" from "can never verify here": when the account
    // service has identity issuance disabled (a terminal 501), the refusal must say
    // so — the generic `unverified` notice offers a refresh that would loop forever.
    if (deps.identityIssuance?.() === 'unconfigured') {
      return {status: 'refused', code: 'issuance-disabled', reason: ISSUANCE_DISABLED_CLAIM_REASON};
    }
    return {status: 'refused', code: 'unverified', reason: UNVERIFIED_CLAIM_REASON};
  }
  try {
    // The patch value only TRIGGERS the claim; the server binds `you.subject` from the
    // request's verified principal, so a client can never claim to someone else.
    const next = await deps.setInstancePolicy({ownerSubject: info.you.subject});
    if (next.ownerSubject) return {status: 'claimed'};
  } catch {
    // The write was rejected (a race claimed it first, or the identity was refused).
    // Fall through to a re-read: if it is now claimed, exposing is safe regardless.
  }
  const after = await deps.getInstanceInfo();
  if (after.ownerSubject) return {status: 'claimed'}; // landed (ours, or a concurrent claim)
  return {status: 'refused', code: 'claim-failed', reason: CLAIM_FAILED_REASON};
}

/** The result of unwinding the audience binding on disable. */
export type AudienceUnbindOutcome =
  /** `requireAudience` was relaxed and the owner token re-minted unscoped. */
  | {status: 'relaxed'}
  /** The relax was NOT confirmed; scoping was LEFT INTACT to avoid a lockout. */
  | {status: 'held'; code: 'unbindHeld'; reason: string};

/**
 * Unwind the binding on disable in the SAFE order: relax `requireAudience` FIRST —
 * while the owner's token is still scoped to the host, so the PUT verifies — and
 * ONLY drop the local scoping + re-mint an unscoped owner token once the relax is
 * CONFIRMED. If the relax fails (the owner is already audience-locked, or the
 * server is unreachable), DON'T unscope: that would strand the owner behind a
 * requirement their token no longer satisfies — a permanent loopback lockout.
 * Leave the scoping intact (`held`) so the owner stays verified and can retry.
 *
 * The instance keeps its `audience` for address stability — a later re-enable just
 * re-asserts `requireAudience`.
 */
export async function unbindForwardingAudience(deps: AudienceBindDeps): Promise<AudienceUnbindOutcome> {
  try {
    await deps.setInstancePolicy({requireAudience: false});
  } catch (e) {
    return {status: 'held', code: 'unbindHeld', reason: errText(e)};
  }
  deps.setLocalAudience(null);
  await deps.remintIdentity();
  return {status: 'relaxed'};
}
