/**
 * Provider-less standalone viewers cannot install or execute plugins. Keeping
 * this tiny surface instead of the app plugin host excludes Sucrase and its
 * dynamic module compiler from the exported bundle; unknown blocks remain the
 * same honest informational cards.
 */
export interface StoreResolution {
  entry: {name: string; icon?: string; publisher?: string; latestVersion: string};
  store: {name: string};
}

export interface VerifiedStoreDownload {
  trust: {firstParty: boolean; notarised: boolean};
}

export interface BundledPluginInfo {
  name: string;
  icon?: string;
  package: unknown;
}

export const getBundledPlugin = (pluginId: string): BundledPluginInfo | undefined => {
  void pluginId;
  return undefined;
};
export const listPluginStores = (): [] => [];
export const resolvePlugin = (pluginId: string): Promise<StoreResolution> => {
  void pluginId;
  return Promise.reject(new Error('Plugin stores are unavailable in standalone exports'));
};
export const verifyFromStore = (resolution: StoreResolution): Promise<VerifiedStoreDownload> => {
  void resolution;
  return Promise.reject(new Error('Plugin verification is unavailable in standalone exports'));
};
export const installVerified = (client: unknown, verified: VerifiedStoreDownload): Promise<void> => {
  void client;
  void verified;
  return Promise.reject(new Error('Plugin installation is unavailable in standalone exports'));
};
export const syncPlugins = (client: unknown): Promise<void> => {
  void client;
  return Promise.resolve();
};
