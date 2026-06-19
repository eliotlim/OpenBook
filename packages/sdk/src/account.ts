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
