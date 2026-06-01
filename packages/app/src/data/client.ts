import {HttpDataClient, getServerUrlOverride, type DataClient} from '@open-book/sdk';

/**
 * The desktop's bundled server. The Tauri host spawns `@open-book/server` (with
 * embedded PGlite) on this address; in dev it's run via `pnpm dev`.
 */
export const LOCAL_SERVER_URL = 'http://127.0.0.1:4319';

/**
 * Build the data client for this desktop session: the local bundled server by
 * default, or an external server if one has been configured via the Server
 * settings (`getServerUrlOverride`). This is the local-vs-remote switch.
 */
export const createDesktopClient = (): DataClient =>
  new HttpDataClient(getServerUrlOverride() ?? LOCAL_SERVER_URL);
