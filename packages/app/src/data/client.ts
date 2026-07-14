import {invoke} from '@tauri-apps/api/core';
import {
  HttpDataClient,
  LOCAL_OWNER_HEADER,
  getServerUrlOverride,
  getServerTokenOverride,
  getIdentityCredential,
  onIdentityChange,
  type DataClient,
  type FetchLike,
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
    // Remote/different data-server: rebuild the live nav stream when the account
    // identity refreshes or lapses, so the streamed list can't keep asserting a
    // stale identity while one-shot content fetches use the current one
    // (cross-server "titles show, content blank").
    return new HttpDataClient(override, getServerTokenOverride() ?? undefined, {
      getIdentity: getIdentityCredential,
      subscribeIdentity: onIdentityChange,
    });
  }

  let info: ServerInfo | null = null;
  try {
    info = await invoke<ServerInfo>('server_info');
  } catch {
    // Not on the desktop host — fall back to the dev server below.
  }

  if (info?.managed) {
    // Portless local server over host IPC (requests + live feed are tunnelled).
    // The host's IPC bridge stamps the local-owner secret on these requests, so
    // the webview never holds it in release.
    return new HttpDataClient('', undefined, {
      fetchImpl: tauriFetch,
      createLiveSource: createTauriLiveSource,
      getIdentity: getIdentityCredential,
      subscribeIdentity: onIdentityChange,
    });
  }

  // Dev (unmanaged): no host bridge to stamp the local-owner secret, so attach it
  // here when the dev setup shares one (export OPENBOOK_LOCAL_OWNER_SECRET to the
  // `pnpm dev` server and the same value as VITE_OPENBOOK_LOCAL_OWNER_SECRET to
  // this app). Absent, dev behaves as before (guest until signed in).
  const devSecret = import.meta.env.VITE_OPENBOOK_LOCAL_OWNER_SECRET as string | undefined;
  const devFetch: FetchLike | undefined = devSecret
    ? (input, init = {}) => {
      const headers = new Headers(init.headers as HeadersInit | undefined);
      headers.set(LOCAL_OWNER_HEADER, devSecret);
      return fetch(input, {...init, headers});
    }
    : undefined;
  return new HttpDataClient(DEV_SERVER_URL, undefined, {
    getIdentity: getIdentityCredential,
    subscribeIdentity: onIdentityChange,
    fetchImpl: devFetch,
  });
};
