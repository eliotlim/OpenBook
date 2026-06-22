import {invoke} from '@tauri-apps/api/core';
import {
  HttpDataClient,
  getServerUrlOverride,
  getServerTokenOverride,
  type DataClient,
  type ServerInfo,
} from '@book.dev/sdk';
import {tauriFetch, createTauriLiveSource} from './ipc';

/**
 * Build the data client for this desktop session.
 *
 *  - An explicit remote override (Server settings) → that server over HTTP.
 *  - Release build → the durable local `@book.dev/server`, reached over the
 *    host IPC bridge (it listens on a Unix socket — no TCP port). Publishing
 *    only adds a LAN bind; the local UI keeps using this same IPC client.
 *  - Dev (unmanaged) → the external `pnpm dev` server on loopback TCP.
 */
export const DEV_SERVER_URL = 'http://127.0.0.1:4319';

export const createDesktopClient = async (): Promise<DataClient> => {
  const override = getServerUrlOverride();
  if (override) {
    return new HttpDataClient(override, getServerTokenOverride() ?? undefined);
  }

  let info: ServerInfo | null = null;
  try {
    info = await invoke<ServerInfo>('server_info');
  } catch {
    // Not on the desktop host — fall back to the dev server below.
  }

  if (info?.managed) {
    // Portless local server over host IPC (requests + live feed are tunnelled).
    return new HttpDataClient('', undefined, {fetchImpl: tauriFetch, createLiveSource: createTauriLiveSource});
  }

  return new HttpDataClient(DEV_SERVER_URL);
};
