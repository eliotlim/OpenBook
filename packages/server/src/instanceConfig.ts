/**
 * Backs {@link IdentityProvider} from the instance's stored policy (OB-165).
 *
 * Policy (guest gate + trusted issuers) is read fresh from the `settings` table
 * per request — it's one indexed lookup, and a guest-access change must take
 * effect immediately. JWKS material is cached in memory, with an offline
 * fallback to the last good key set, so verification keeps working when the
 * issuer is unreachable. A trusted issuer may also ship an *inline* JWKS, which
 * makes verification fully offline (and is how the dev issuer registers).
 */

import {verifyRevocations, type Jwks, type RevocationSet} from '@book.dev/sdk';
import type {PageStore} from './store';
import type {IdentityProvider} from './principal';

export interface IdentityServiceOptions {
  /** `fetch` for JWKS refresh (injectable for tests). */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Clock (tests). */
  now?: () => number;
  /** How long a network-fetched JWKS stays fresh before refetch (ms). Default 10 min. */
  jwksTtlMs?: number;
}

const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;

export class IdentityService implements IdentityProvider {
  private readonly jwksCache = new Map<string, {jwks: Jwks; at: number}>();
  private readonly revocationsCache = new Map<string, {set: RevocationSet; at: number}>();

  constructor(
    private readonly store: PageStore,
    private readonly opts: IdentityServiceOptions = {},
  ) {}

  now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async policy(): Promise<{
    guestAccess: import('@book.dev/sdk').GuestAccess;
    allowedIssuers: string[];
    audience?: string;
    requireAudience?: boolean;
    ownerSubject?: string;
  }> {
    const config = await this.store.getInstanceConfig();
    return {
      guestAccess: config.guestAccess,
      allowedIssuers: config.trustedIssuers.map((i) => i.issuer),
      audience: config.audience,
      requireAudience: config.requireAudience,
      ownerSubject: config.ownerSubject,
    };
  }

  async jwks(issuer: string): Promise<Jwks | null> {
    const config = await this.store.getInstanceConfig();
    const trusted = config.trustedIssuers.find((i) => i.issuer === issuer);
    if (!trusted) return null;
    // Inline / cached-in-config JWKS → fully offline-capable.
    if (trusted.jwks) return trusted.jwks;
    if (!trusted.jwksUrl) return null;

    const ttl = this.opts.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS;
    const cached = this.jwksCache.get(issuer);
    if (cached && this.now() - cached.at < ttl) return cached.jwks;

    try {
      const res = await (this.opts.fetchImpl ?? fetch)(trusted.jwksUrl);
      if (!res.ok) return cached?.jwks ?? null; // keep serving the last good set
      const jwks = (await res.json()) as Jwks;
      this.jwksCache.set(issuer, {jwks, at: this.now()});
      return jwks;
    } catch {
      // Offline / network error: fall back to the last good key set if we have one.
      return cached?.jwks ?? null;
    }
  }

  /**
   * The issuer's revocation set (OB-106) — a carbon copy of {@link jwks}'s plumbing
   * (inline-config short-circuit, in-memory cache, ~10-min TTL, last-good offline
   * fallback), with one extra step: the fetched document is an EdDSA-signed JWS, so
   * it is signature-verified against the issuer's cached JWKS before it is trusted.
   * Returns `null` when the issuer publishes no revocations, or when the document
   * is unobtainable/forged cold (no cache) — benign: the caller skips the check
   * (fail-open), with the short token TTL as the backstop.
   */
  async revocations(issuer: string): Promise<RevocationSet | null> {
    const config = await this.store.getInstanceConfig();
    const trusted = config.trustedIssuers.find((i) => i.issuer === issuer);
    if (!trusted) return null;
    // Inline / cached-in-config set → config-trusted, fully offline-capable.
    if (trusted.revocations) return trusted.revocations;
    if (!trusted.revocationsUrl) return null;

    const ttl = this.opts.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS;
    const cached = this.revocationsCache.get(issuer);
    if (cached && this.now() - cached.at < ttl) return cached.set;

    // The document is signed against the issuer's JWKS — fetch the keys first (its
    // own cache + offline fallback) so we can prove the signature before trusting it.
    const keys = await this.jwks(issuer);
    if (!keys) return cached?.set ?? null;

    try {
      const res = await (this.opts.fetchImpl ?? fetch)(trusted.revocationsUrl);
      if (!res.ok) return cached?.set ?? null; // keep serving the last good set
      const set = await verifyRevocations(await res.text(), keys);
      if (!set) return cached?.set ?? null; // forged / malformed → never trust it
      this.revocationsCache.set(issuer, {set, at: this.now()});
      return set;
    } catch {
      // Offline / network error: fall back to the last good set if we have one.
      return cached?.set ?? null;
    }
  }
}
