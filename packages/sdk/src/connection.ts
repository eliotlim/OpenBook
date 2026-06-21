/**
 * Connection override stored in the browser. When set, clients connect to this
 * external server instead of the local/default one. Used by the desktop's
 * "connect to a remote server" flow and readable by the web shell.
 */
const SERVER_URL_KEY = 'openbook.serverUrl';

/** The configured external server URL, or `null` if none is set. */
export function getServerUrlOverride(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(SERVER_URL_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Set (or clear, with `null`) the external server URL. Takes effect on reload. */
export function setServerUrlOverride(url: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (url && url.trim().length > 0) {
    localStorage.setItem(SERVER_URL_KEY, url.trim());
  } else {
    localStorage.removeItem(SERVER_URL_KEY);
  }
}

/**
 * Whether fetching `url` from a page on `pageProtocol` would be blocked by the
 * browser as **mixed content** — an `https:` page cannot load a plain `http:`
 * subresource, so a hosted app (e.g. https://app.book.pub) can never reach a
 * `http://192.168.x.x:port` LAN server, no matter what CORS headers it sends.
 * `http://localhost` (and `127.0.0.1` / `[::1]`) are "potentially trustworthy"
 * and exempt. `pageProtocol` defaults to the current page's protocol.
 *
 * The fix for a blocked URL is an HTTPS origin — the device's `✦.book.pub`
 * forwarding address, or running the app on the same machine.
 */
export function isMixedContentBlocked(url: string, pageProtocol?: string): boolean {
  const proto = pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : 'http:');
  if (proto !== 'https:') return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false; // not an absolute URL — nothing to block (or a relative path)
  }
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  const trustworthy = h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
  return !trustworthy;
}

/**
 * Access token for a published (LAN) server connection. Paired with
 * {@link getServerUrlOverride} when connecting to another machine's published
 * workspace — that server requires the token on every request.
 */
const SERVER_TOKEN_KEY = 'openbook.serverToken';

/** The configured access token for the external server, or `null`. */
export function getServerTokenOverride(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(SERVER_TOKEN_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Set (or clear, with `null`) the access token. Takes effect on reload. */
export function setServerTokenOverride(token: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (token && token.trim().length > 0) {
    localStorage.setItem(SERVER_TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(SERVER_TOKEN_KEY);
  }
}
