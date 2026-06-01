import {HttpDataClient, type DataClient} from '@open-book/sdk';

const SERVER_URL_KEY = 'openbook.serverUrl';

/**
 * The desktop's bundled server. The Tauri host spawns `@open-book/server` (with
 * embedded Postgres) on this address; in dev it's run via `pnpm dev`. Either
 * way the frontend just talks HTTP to it — the same client the web shell uses.
 */
export const LOCAL_SERVER_URL = 'http://127.0.0.1:4319';

/**
 * Build the data client for this desktop session: the local bundled server by
 * default, or an external server if one has been configured
 * (`localStorage['openbook.serverUrl']`). This is the local-vs-remote switch.
 */
export const createDesktopClient = (): DataClient =>
  new HttpDataClient(getServerUrl() ?? LOCAL_SERVER_URL);

/** Read the configured external server URL, if any. */
export const getServerUrl = (): string | null => {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(SERVER_URL_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
};

/**
 * Point the app at an external server (`url`), or pass `null` to revert to the
 * local bundled server. Takes effect on next load.
 */
export const setServerUrl = (url: string | null): void => {
  if (typeof localStorage === 'undefined') return;
  if (url && url.trim().length > 0) {
    localStorage.setItem(SERVER_URL_KEY, url.trim());
  } else {
    localStorage.removeItem(SERVER_URL_KEY);
  }
};
