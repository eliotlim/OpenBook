import {
  verifyPlugin,
  OPENBOOK_REGISTRY,
  type DataClient,
  type StoredPlugin,
} from '@open-book/sdk';
import {executePlugin} from './loader';
import {buildPluginApi, hostModulesFor, type PluginModule} from './api';

/**
 * The plugin host: loads the workspace's enabled plugins, activates each in
 * isolation (one plugin's crash never takes down another, or the app), and
 * tears contributions down on disable/remove. A module singleton — the same
 * set of plugins serves every editor on the page.
 */

export interface PluginStatus {
  plugin: StoredPlugin;
  state: 'active' | 'disabled' | 'error';
  error?: string;
  /** The trusted registry that vouches for this exact content, if any. */
  verifiedBy?: string;
}

interface ActivePlugin {
  dispose: () => void;
}

const active = new Map<string, ActivePlugin>();
let statuses: PluginStatus[] = [];
const subscribers = new Set<() => void>();

const notify = (): void => subscribers.forEach((cb) => cb());

export const pluginStatuses = (): PluginStatus[] => statuses;

export const subscribePlugins = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

const TRUSTED_KEYS_STORAGE = 'openbook.trustedRegistries';

/** First-party key + any registries the user has chosen to trust. */
export function trustedRegistryKeys(): Array<{name: string; publicKey: string}> {
  const extra = (() => {
    try {
      const raw = localStorage.getItem(TRUSTED_KEYS_STORAGE);
      const list = raw ? (JSON.parse(raw) as Array<{name: string; publicKey: string}>) : [];
      return Array.isArray(list) ? list.filter((k) => k && typeof k.name === 'string' && typeof k.publicKey === 'string') : [];
    } catch {
      return [];
    }
  })();
  return [OPENBOOK_REGISTRY, ...extra];
}

function activate(plugin: StoredPlugin, client: DataClient): {error?: string} {
  const disposables: Array<() => void> = [];
  try {
    const api = buildPluginApi(plugin.manifest, client, disposables);
    const mod = executePlugin(plugin, hostModulesFor(api)) as PluginModule;
    const entry = mod.default ?? mod.activate;
    if (typeof entry !== 'function') throw new Error('the entry file must export an activate function (default export)');
    const result = entry(api);
    if (result && typeof result.deactivate === 'function') disposables.push(result.deactivate);
    active.set(plugin.manifest.id, {
      dispose: () => {
        for (const d of disposables.splice(0).reverse()) {
          try {
            d();
          } catch {
            // a failing teardown must not block the rest
          }
        }
      },
    });
    return {};
  } catch (err) {
    for (const d of disposables.splice(0).reverse()) {
      try {
        d();
      } catch {
        // best-effort rollback
      }
    }
    return {error: err instanceof Error ? err.message : String(err)};
  }
}

/**
 * Reconcile the running set against the server's list: activate newly
 * enabled plugins, dispose disabled/removed ones, verify signatures against
 * the user's trusted keys. Safe to call repeatedly (boot + after changes).
 */
export async function syncPlugins(client: DataClient): Promise<PluginStatus[]> {
  const plugins = await client.listPlugins();
  const seen = new Set<string>();
  const next: PluginStatus[] = [];

  for (const plugin of plugins) {
    const id = plugin.manifest.id;
    seen.add(id);
    const verdict = await verifyPlugin(plugin, trustedRegistryKeys());
    if (!plugin.enabled) {
      active.get(id)?.dispose();
      active.delete(id);
      next.push({plugin, state: 'disabled', verifiedBy: verdict?.registry});
      continue;
    }
    if (!active.has(id)) {
      const {error} = activate(plugin, client);
      next.push({plugin, state: error ? 'error' : 'active', error, verifiedBy: verdict?.registry});
    } else {
      const previous = statuses.find((s) => s.plugin.manifest.id === id);
      next.push({plugin, state: previous?.state === 'error' ? 'error' : 'active', error: previous?.error, verifiedBy: verdict?.registry});
    }
  }

  // Removed plugins: dispose anything no longer listed.
  for (const [id, instance] of [...active]) {
    if (!seen.has(id)) {
      instance.dispose();
      active.delete(id);
    }
  }

  statuses = next;
  notify();
  return next;
}

/** Dispose + re-activate one plugin (after an update/re-install). */
export async function reloadPlugin(id: string, client: DataClient): Promise<PluginStatus[]> {
  active.get(id)?.dispose();
  active.delete(id);
  return syncPlugins(client);
}
