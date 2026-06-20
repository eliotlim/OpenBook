import {invoke} from '@tauri-apps/api/core';
import {
  HttpDataClient,
  getServerUrlOverride,
  getServerTokenOverride,
  type DataClient,
  type ServerInfo,
} from '@open-book/sdk';
import {createLocalDataClient, type LocalDataClient} from '@open-book/server/browser';

/**
 * The desktop is **in-app by default**: the data layer runs inside this webview
 * on an embedded PGlite store (IndexedDB, durable across launches) — no local
 * server, no open port. A port is opened only when the user *publishes* their
 * instance on the LAN; the bundled `@open-book/server` sidecar is then spawned
 * (token-gated) and this UI connects to it over HTTP instead.
 *
 * Switching between the two is a whole-space hand-off (`exportSpace` →
 * `importSpace`) done before the app reloads onto the new target, so the
 * published server and the in-app store stay in sync across the transition.
 */

/** The live client for this session, tracked so the publish bridge can hand its
 *  data to the other store. Set by {@link createDesktopClient}. */
let currentClient: DataClient | null = null;

/**
 * Build the data client for this desktop session.
 *  - An explicit remote override (Server settings) → that server over HTTP.
 *  - Published → the LAN sidecar over HTTP (with its access token).
 *  - Otherwise (the default) → the in-app embedded store.
 */
export const createDesktopClient = async (): Promise<DataClient> => {
  const override = getServerUrlOverride();
  if (override) {
    currentClient = new HttpDataClient(override, getServerTokenOverride() ?? undefined);
    return currentClient;
  }

  let info: ServerInfo | null = null;
  try {
    info = await invoke<ServerInfo>('server_info');
  } catch {
    // Not on the desktop host (e.g. a `tauri dev` quirk) — fall back to in-app.
  }

  if (info?.published && info.address) {
    currentClient = new HttpDataClient(info.address, info.accessToken ?? undefined);
    return currentClient;
  }

  currentClient = await createLocalDataClient();
  return currentClient;
};

/** Poll a (re)started server's /health so the reconnecting client lands cleanly. */
async function waitForHealth(address: string | null | undefined, timeoutMs = 15000): Promise<void> {
  if (!address) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${address}/health`, {cache: 'no-store'})).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Publish (or unpublish) this instance, carrying the workspace across the move.
 *
 * Enabling: export the in-app store, spawn the LAN sidecar, then import the
 * snapshot into it so the published server serves the same books. Disabling:
 * export the sidecar's current state back into the in-app store before stopping
 * it, so edits made while published are kept. The caller reloads afterwards;
 * {@link createDesktopClient} then connects to the right target.
 */
export const togglePublish = async (enabled: boolean): Promise<ServerInfo> => {
  if (enabled) {
    // Snapshot the in-app store before anything changes.
    const bundle = currentClient ? await currentClient.exportSpace() : {pages: [], databases: []};
    const info = await invoke<ServerInfo>('publish_server', {enabled: true});
    if (info.address) {
      await waitForHealth(info.address);
      const sidecar = new HttpDataClient(info.address, info.accessToken ?? undefined);
      // Overwrite-by-id: the export is the full current space, so the published
      // store becomes a faithful copy. The in-app IndexedDB is left untouched.
      await sidecar.importSpace({pages: bundle.pages, databases: bundle.databases, mode: 'overwrite'});
    }
    return info;
  }

  // Disabling: pull the sidecar's latest state back into the in-app store first.
  if (currentClient) {
    const bundle = await currentClient.exportSpace();
    const local = await createLocalDataClient();
    try {
      await local.importSpace({pages: bundle.pages, databases: bundle.databases, mode: 'overwrite'});
    } finally {
      await local.close();
    }
  }
  return invoke<ServerInfo>('publish_server', {enabled: false});
};

/** The current client, for callers that need to read/write outside React (e.g.
 *  the book-folder export gathers the space from here). */
export const getCurrentClient = (): DataClient | null => currentClient;

export type {LocalDataClient};
