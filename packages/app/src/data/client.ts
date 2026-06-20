import {invoke} from '@tauri-apps/api/core';
import {
  HttpDataClient,
  getServerUrlOverride,
  getServerTokenOverride,
  type DataClient,
  type ServerInfo,
} from '@open-book/sdk';

/**
 * The desktop's bundled server. The Tauri host spawns `@open-book/server` (with
 * embedded PGlite) on this address; in dev it's run via `pnpm dev`.
 */
export const LOCAL_SERVER_URL = 'http://127.0.0.1:4319';

/**
 * Build the data client for this desktop session: the local bundled server by
 * default, or an external server if one has been configured via the Server
 * settings (`getServerUrlOverride`). This is the local-vs-remote switch.
 *
 * When pointed at the local server we ask the host for its status: the local UI
 * always connects over loopback, but when the server is *published* it requires
 * the access token, so we attach it here. (A remote connection uses the token
 * override the user pasted alongside the URL.)
 */
export const createDesktopClient = async (): Promise<DataClient> => {
  const override = getServerUrlOverride();
  let url = override ?? LOCAL_SERVER_URL;
  let token = getServerTokenOverride() ?? undefined;
  if (!override) {
    try {
      const info = await invoke<ServerInfo>('server_info');
      if (info.address) url = info.address;
      if (info.published && info.accessToken) token = info.accessToken;
    } catch {
      // Not on the desktop host (e.g. `tauri dev` quirks) — fall back to defaults.
    }
  }
  return new HttpDataClient(url, token);
};
