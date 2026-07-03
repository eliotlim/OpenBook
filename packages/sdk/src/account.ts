/**
 * Client for the OpenBook account service (account.book.pub): the deep-link
 * sign-in URL plus the settings-sync API. Identity + settings sync live in a
 * service separate from the (single-tenant) data server, so this is its own
 * small client — independent of {@link HttpDataClient}, authed by a bearer
 * "device token" rather than the cookieless data API.
 */

/** Where the account service lives when nothing overrides it. */
export const DEFAULT_ACCOUNT_URL = 'https://account.book.pub';

const ACCOUNT_URL_KEY = 'openbook.accountUrl';

const trimUrl = (u: string): string => u.trim().replace(/\/+$/, '');

/** A dev/self-host override for the account base URL (localStorage), or null. */
export function getAccountUrlOverride(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(ACCOUNT_URL_KEY);
  return v && v.trim() ? trimUrl(v) : null;
}

/** Set (or clear, with `null`) the account base URL override. */
export function setAccountUrlOverride(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (url && url.trim()) localStorage.setItem(ACCOUNT_URL_KEY, trimUrl(url));
  else localStorage.removeItem(ACCOUNT_URL_KEY);
}

/** The effective account base URL (override, else the production default). */
export function resolveAccountUrl(): string {
  return getAccountUrlOverride() ?? DEFAULT_ACCOUNT_URL;
}

/** The user's synced blob plus the server's last-write timestamp. */
export interface AccountSettings {
  /** Whatever the app stored, or `{}` when nothing is synced yet. */
  settings: Record<string, unknown>;
  /** ISO timestamp of the last server write, or null if never written. */
  updatedAt: string | null;
}

/** Thrown on a non-OK account response, so callers can branch on `status` (401). */
export class AccountError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/**
 * The outcome of an identity mint, discriminated so callers can react to each
 * terminal state instead of collapsing them all into null-or-throw. The split
 * matters because the states demand OPPOSITE reactions:
 *  - `unconfigured` (501) is terminal — the account never issues identities, so
 *    the app acts as a named guest (and no retry will change that);
 *  - `audRejected` (400 with an `aud` supplied) means the issuer refused the
 *    *audience*, not the user — the caller should retry WITHOUT the audience
 *    rather than drop the identity (an unscoped token still verifies the user
 *    on their own instance);
 *  - transient/auth failures still throw {@link AccountError}, so a network
 *    blip never masquerades as either terminal state.
 */
export type IdentityTokenResult =
  /** A fresh identity assertion was minted. */
  | {status: 'ok'; identity: string; expiresAt: string}
  /** Identity issuance is not configured on this account service (501). */
  | {status: 'unconfigured'}
  /** The issuer refused the requested `aud` (no allowlist configured, or an
   *  allowlist miss). `error` is the server's own explanation, for logs/UI. */
  | {status: 'audRejected'; error: string};

/**
 * Talks to the account service's `/api/connect` (deep-link sign-in) and
 * `/api/settings` (bearer-authed settings sync). Stateless: the caller holds the
 * device token and passes it per request.
 */
export class AccountClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = resolveAccountUrl()) {
    this.baseUrl = trimUrl(baseUrl);
  }

  /** The base URL this client targets (already trimmed). */
  get origin(): string {
    return this.baseUrl;
  }

  /**
   * The browser URL that starts deep-link sign-in: it runs OAuth (if needed),
   * mints a one-shot device token, and redirects to
   * `redirectUri#token=<token>&state=<state>`. Open it in the system browser.
   */
  connectUrl(opts: {redirectUri: string; state: string; name?: string}): string {
    const u = new URL('/api/connect', this.baseUrl + '/');
    u.searchParams.set('redirect_uri', opts.redirectUri);
    u.searchParams.set('state', opts.state);
    if (opts.name) u.searchParams.set('name', opts.name);
    return u.toString();
  }

  /** Pull the synced settings blob. Throws `AccountError(401)` if the token is
   *  invalid or revoked. */
  async getSettings(token: string): Promise<AccountSettings> {
    const res = await fetch(new URL('/api/settings', this.baseUrl + '/'), {
      headers: {authorization: `Bearer ${token}`},
      cache: 'no-store',
    });
    if (!res.ok) throw new AccountError(res.status, `account settings GET failed (${res.status})`);
    const body = (await res.json()) as Partial<AccountSettings>;
    return {settings: body.settings ?? {}, updatedAt: body.updatedAt ?? null};
  }

  /** Push the settings blob; returns the new server timestamp for reconciliation. */
  async putSettings(token: string, settings: Record<string, unknown>): Promise<{updatedAt: string}> {
    const res = await fetch(new URL('/api/settings', this.baseUrl + '/'), {
      method: 'PUT',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
      body: JSON.stringify({settings}),
      cache: 'no-store',
    });
    if (!res.ok) throw new AccountError(res.status, `account settings PUT failed (${res.status})`);
    const body = (await res.json()) as {updatedAt: string};
    return {updatedAt: body.updatedAt};
  }

  /**
   * Mint a verifiable identity assertion (JWS) for the OpenBook data server
   * (OB-165). The data server verifies it against the account's JWKS and
   * attributes the user's changes to `iss#sub`. Returns a discriminated
   * {@link IdentityTokenResult} — `ok` with `{identity, expiresAt}`,
   * `unconfigured` when the account doesn't issue identities (501, terminal),
   * or `audRejected` when the issuer refused the requested audience (400 with
   * `aud` supplied — retry unscoped, don't drop the identity). Throws
   * `AccountError` on anything else (401 invalid/revoked token, 5xx, …).
   */
  async getIdentityToken(token: string, aud?: string): Promise<IdentityTokenResult> {
    // `aud` scopes the assertion to one data server (OB-177), so it can't be
    // replayed to another. Required by the issuer only when it runs an audience
    // allowlist; when it doesn't, the issuer 400s the *request* — which must not
    // be confused with the *user* being rejected (see `audRejected` above).
    const url = new URL('/api/identity/token', this.baseUrl + '/');
    if (aud) url.searchParams.set('aud', aud);
    const res = await fetch(url, {
      headers: {authorization: `Bearer ${token}`},
      cache: 'no-store',
    });
    if (res.status === 501) return {status: 'unconfigured'}; // issuance not configured on this account
    if (res.status === 400 && aud) {
      // The issuer refused the audience we asked for ("audience binding is not
      // configured on this server", or an allowlist miss). Carry its own words.
      let error = `audience "${aud}" was rejected by the issuer`;
      try {
        const body = (await res.json()) as {error?: unknown};
        if (typeof body.error === 'string' && body.error) error = body.error;
      } catch {
        /* non-JSON body — keep the generic explanation */
      }
      return {status: 'audRejected', error};
    }
    if (!res.ok) throw new AccountError(res.status, `account identity token failed (${res.status})`);
    const body = (await res.json()) as {identity?: string; expiresAt?: string};
    // A 200 with a malformed body: treat like an issuer that mints nothing, the
    // same guest fallback the pre-discrimination client applied.
    if (!body.identity || !body.expiresAt) return {status: 'unconfigured'};
    return {status: 'ok', identity: body.identity, expiresAt: body.expiresAt};
  }

  /** Cheap token check (a settings GET): true if accepted, false on 401. */
  async validate(token: string): Promise<boolean> {
    try {
      await this.getSettings(token);
      return true;
    } catch (err) {
      if (err instanceof AccountError && err.status === 401) return false;
      throw err;
    }
  }
}
