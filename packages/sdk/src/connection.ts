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
