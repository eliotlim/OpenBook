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
 * library — that server requires the token on every request.
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

// ── Identity-change notification (cross-server blank-page fix) ────────────────
// The data client bakes the identity into its live-stream (`/api/live`) URL when
// the EventSource opens — an EventSource can't send headers, so the JWS rides the
// query — and that URL is then FROZEN for the life of the connection. One-shot
// content fetches (`getPage`) instead read the identity fresh per request. So
// after a sign-out / account switch / token refresh, the streamed nav list keeps
// asserting the OLD identity while content uses the NEW (or dropped) one: the
// list can outrank the content and show titles for pages whose bodies now 401/404
// (the "titles show, content blank" symptom on a lapsed remote-server identity).
// The client subscribes here so it can rebuild the live stream when the credential
// ACTUALLY changes, keeping both axes on the same identity.
type IdentityChangeListener = () => void;
const identityListeners = new Set<IdentityChangeListener>();

/**
 * Subscribe to identity-credential changes — a new/cleared verified JWS, or a
 * changed guest label. Returns an unsubscribe. Fires only on a real value change
 * (the setters below dedupe), so a caller can rebuild a baked-in connection
 * without churning it on every no-op set.
 */
export function onIdentityChange(listener: IdentityChangeListener): () => void {
  identityListeners.add(listener);
  return () => void identityListeners.delete(listener);
}

function notifyIdentityChange(): void {
  // Copy first: a listener that (un)subscribes during its own handler must not
  // perturb the fan-out, and one throwing must not starve the others.
  for (const listener of [...identityListeners]) {
    try {
      listener();
    } catch {
      /* a listener's own failure is its own problem */
    }
  }
}

/** Set the verified identity assertion (JWS), or `null` to act as a guest. */
export function setIdentityToken(jws: string | null): void {
  const next = jws && jws.length > 0 ? jws : null;
  if (next === identityJws) return; // no real change — don't churn the live stream
  identityJws = next;
  notifyIdentityChange();
}

/** Set the guest display label, persisted so anonymous edits stay attributed. */
export function setGuestName(name: string | null): void {
  const next = name && name.trim() ? name.trim() : null;
  const changed = next !== guestName;
  guestName = next;
  if (typeof localStorage !== 'undefined') {
    if (guestName) localStorage.setItem(GUEST_NAME_KEY, guestName);
    else localStorage.removeItem(GUEST_NAME_KEY);
  }
  if (changed) notifyIdentityChange();
}

/**
 * The canonical audience this instance is exposed under (OB-202). When forwarding
 * is on, the instance binds its identity `audience` to its `<prefix>.book.cloud`
 * host with `requireAudience` (OB-177) — so the edge-minted, aud-scoped viewer JWS
 * verifies, and a token for a *different* site is rejected. The catch: the local
 * owner reaches the SAME server over loopback/IPC, so their own identity token must
 * be minted for this same host (one shared audience — not the deferred
 * multi-audience case), or `requireAudience` would lock the owner out. The
 * forwarding flow records the host here; AccountProvider reads it to scope the
 * owner's token. Persisted so a relaunch scopes correctly *before* the tunnel
 * re-dials.
 */
const FORWARDING_AUDIENCE_KEY = 'openbook.forwarding.audience';

/** The site-forwarding root moved `*.book.pub` → `*.book.cloud`; an audience
 *  recorded before the move can never mint again (the issuer only allowlists the
 *  new root), so it must be healed on read — see {@link getForwardingAudience}. */
const STALE_AUDIENCE_SUFFIX = '.book.pub';
const CANONICAL_AUDIENCE_SUFFIX = '.book.cloud';

/**
 * The canonical forwarded host to scope identity tokens to, or `null` if off.
 *
 * Heals a stale pre-migration value in passing: an audience persisted as
 * `<prefix>.book.pub` (before the `*.book.cloud` root move) is rewritten to
 * `<prefix>.book.cloud` and stored back — mirroring the host heal in
 * `ForwardingClient.start()`, which adopts the account's fresh canonical host on
 * attach. Without this, every identity mint keeps asking for an audience the
 * issuer can no longer grant.
 */
export function getForwardingAudience(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(FORWARDING_AUDIENCE_KEY);
  const host = value && value.trim().length > 0 ? value.trim() : null;
  if (!host) return null;
  if (host.endsWith(STALE_AUDIENCE_SUFFIX)) {
    const healed = host.slice(0, -STALE_AUDIENCE_SUFFIX.length) + CANONICAL_AUDIENCE_SUFFIX;
    localStorage.setItem(FORWARDING_AUDIENCE_KEY, healed);
    return healed;
  }
  return host;
}

/** Set (or clear, with `null`) the forwarded host the owner's token is scoped to. */
export function setForwardingAudience(host: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (host && host.trim().length > 0) {
    localStorage.setItem(FORWARDING_AUDIENCE_KEY, host.trim());
  } else {
    localStorage.removeItem(FORWARDING_AUDIENCE_KEY);
  }
}
