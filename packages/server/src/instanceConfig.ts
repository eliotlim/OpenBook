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

import type {Jwks} from '@book.dev/sdk';
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
  }> {
    const config = await this.store.getInstanceConfig();
    return {
      guestAccess: config.guestAccess,
      allowedIssuers: config.trustedIssuers.map((i) => i.issuer),
      audience: config.audience,
      requireAudience: config.requireAudience,
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
}
