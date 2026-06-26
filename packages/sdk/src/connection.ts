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

/**
 * The caller's identity, sent on every data-server request (OB-165). Distinct
 * from the access token above: that's the instance reachability secret, this is
 * *who you are*. Two INDEPENDENT parts, owned by different providers, so neither
 * clobbers the other:
 *  - the **JWS** — a live, short-lived verified assertion held in memory
 *    (AccountProvider sets it on sign-in, refreshes it before expiry, clears it
 *    on sign-out);
 *  - the **guest name** — persisted so even anonymous edits carry a label across
 *    reloads (PreferencesProvider mirrors the profile display name).
 * The data client reads both fresh per request via {@link getIdentityCredential}.
 */
import type {IdentityCredential} from './client';

let identityJws: string | null = null;
let guestName: string | null = null;
const GUEST_NAME_KEY = 'openbook.guestName';

/** The identity to attach to the next request (verified JWS + guest label). */
export function getIdentityCredential(): IdentityCredential {
  const name =
    guestName ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(GUEST_NAME_KEY) : null);
  return {
    jws: identityJws ?? undefined,
    guestName: name && name.trim() ? name.trim() : undefined,
  };
}

/** Set the verified identity assertion (JWS), or `null` to act as a guest. */
export function setIdentityToken(jws: string | null): void {
  identityJws = jws && jws.length > 0 ? jws : null;
}

/** Set the guest display label, persisted so anonymous edits stay attributed. */
export function setGuestName(name: string | null): void {
  guestName = name && name.trim() ? name.trim() : null;
  if (typeof localStorage === 'undefined') return;
  if (guestName) localStorage.setItem(GUEST_NAME_KEY, guestName);
  else localStorage.removeItem(GUEST_NAME_KEY);
}
