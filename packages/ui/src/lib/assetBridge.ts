/**
 * Bridge between the (provider-less) block editor and the app's data client for
 * binary assets — the same singleton pattern as `aiBridge` / `pageLinks`. The
 * block editor mounts its own React root outside providers, so an image block
 * can't `useData()`; instead the app installs this bridge once (AssetBridgeHost),
 * and the image block's ingest / view call through it to upload + resolve assets.
 *
 * When no bridge is installed (the editor rendered standalone, or a test without
 * a data client) the actions degrade gracefully: `ready()` is false, so ingest
 * falls back to an inline data-URL, and `getAsset` resolves `null`.
 */

export interface AssetBridgeImpl {
  /** Upload bytes → the content-addressed store, ref'd to `pageId`; resolves `{id}`. */
  putAsset: (bytes: Uint8Array, mime: string, pageId: string) => Promise<{id: string}>;
  /** Resolve an asset's bytes + mime by content-hash id (or `null` if unreachable). */
  getAsset: (id: string) => Promise<{bytes: Uint8Array; mime: string} | null>;
}

let bridge: AssetBridgeImpl | null = null;

/** Install (or clear) the live asset bridge. The app calls this from a client-aware host. */
export const setAssetBridge = (next: AssetBridgeImpl | null): void => {
  bridge = next;
};

/** The bridge actions, safe to call before the host mounts (upload rejects; get resolves null). */
export const assetBridge = {
  /** Whether an asset store is wired up (⇒ ingest can upload rather than inline a data-URL). */
  ready: (): boolean => bridge != null,
  putAsset: (bytes: Uint8Array, mime: string, pageId: string): Promise<{id: string}> =>
    bridge ? bridge.putAsset(bytes, mime, pageId) : Promise.reject(new Error('asset store not available')),
  getAsset: (id: string): Promise<{bytes: Uint8Array; mime: string} | null> =>
    bridge ? bridge.getAsset(id) : Promise.resolve(null),
};
