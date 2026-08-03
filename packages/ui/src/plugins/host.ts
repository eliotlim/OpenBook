import {
  verifyPlugin,
  pluginApiVersionError,
  OPENBOOK_REGISTRY,
  type DataClient,
  type PluginPackage,
  type StoredPlugin,
} from '@book.dev/sdk';
import {executePlugin} from './loader';
import {buildPluginApi, hostModulesFor, type PluginModule} from './api';
import {BUNDLED_PLUGINS} from './bundled.gen';

/**
 * The plugin host: loads the library's enabled plugins, activates each in
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

/** Persist a user-trusted registry key (and re-verify on next sync). */
export function addTrustedRegistry(name: string, publicKey: string): void {
  const key = publicKey.trim();
  if (key === OPENBOOK_REGISTRY.publicKey) return;
  const list = trustedRegistryKeys().filter((k) => k.publicKey !== OPENBOOK_REGISTRY.publicKey);
  if (list.some((k) => k.publicKey === key)) return;
  localStorage.setItem(TRUSTED_KEYS_STORAGE, JSON.stringify([...list, {name: name.trim(), publicKey: key}]));
}

export function removeTrustedRegistry(publicKey: string): void {
  const list = trustedRegistryKeys().filter((k) => k.publicKey !== OPENBOOK_REGISTRY.publicKey && k.publicKey !== publicKey);
  localStorage.setItem(TRUSTED_KEYS_STORAGE, JSON.stringify(list));
}

function activate(plugin: StoredPlugin, client: DataClient): {error?: string} {
  // API-version gate first: a plugin built against a newer PluginApi gets a
  // clear "update the app" error instead of crashing on a missing surface.
  // Plugins without `apiVersion` (all pre-gate plugins) pass unchanged.
  const versionError = pluginApiVersionError(plugin.manifest);
  if (versionError) return {error: versionError};
  let disposed = false;
  const disposables: Array<() => void> = [];
  // Registrations made AFTER dispose (a retained setTimeout/event handler
  // calling back into the api) are torn down immediately instead of leaking
  // into the already-emptied disposables array.
  const track = (d: () => void): void => {
    if (disposed) {
      try {
        d();
      } catch {
        // late teardown must not throw into plugin code
      }
      return;
    }
    disposables.push(d);
  };
  try {
    const api = buildPluginApi(plugin.manifest, client, track);
    const mod = executePlugin(plugin, hostModulesFor(api)) as PluginModule;
    const entry = mod.default ?? mod.activate;
    if (typeof entry !== 'function') throw new Error('the entry file must export an activate function (default export)');
    const result = entry(api);
    if (result && typeof result.deactivate === 'function') disposables.push(result.deactivate);
    active.set(plugin.manifest.id, {
      dispose: () => {
        disposed = true;
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
    disposed = true;
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

// ── Bundled plugin auto-install ───────────────────────────────────────────────

/**
 * localStorage key that records bundled plugins the user has explicitly removed.
 * Value is a JSON array of plugin ids. Once an id is in this list, syncPlugins
 * will not re-install it — the user's choice to remove wins over the bundle.
 */
const DISMISSED_BUNDLED_KEY = 'openbook.bundledPluginsDismissed';

function getDismissedBundled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_BUNDLED_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(list) ? (list as string[]).filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Mark a bundled plugin as dismissed so auto-install won't re-add it. */
export function dismissBundledPlugin(id: string): void {
  const set = getDismissedBundled();
  set.add(id);
  try {
    localStorage.setItem(DISMISSED_BUNDLED_KEY, JSON.stringify([...set]));
  } catch {
    // storage quota / private mode — best effort
  }
}

const bundledIds = new Set(BUNDLED_PLUGINS.map((p) => p.manifest.id));

/** Whether `id` is a first-party bundled plugin. */
export function isBundledPlugin(id: string): boolean {
  return bundledIds.has(id);
}

/**
 * Install any bundled first-party plugins that are not yet on the server and
 * have not been explicitly dismissed by the user. Returns the list of newly
 * installed StoredPlugins (empty when nothing was needed).
 */
async function seedBundledPlugins(client: DataClient, existing: StoredPlugin[]): Promise<StoredPlugin[]> {
  const installed = new Set(existing.map((p) => p.manifest.id));
  const dismissed = getDismissedBundled();
  const toInstall: PluginPackage[] = [];
  for (const pkg of BUNDLED_PLUGINS) {
    if (!installed.has(pkg.manifest.id) && !dismissed.has(pkg.manifest.id)) {
      toInstall.push(pkg);
    }
  }
  const results: StoredPlugin[] = [];
  for (const pkg of toInstall) {
    try {
      results.push(await client.installPlugin(pkg));
    } catch {
      // Network/permission failure — skip silently; next sync will retry.
    }
  }
  return results;
}

/**
 * Reconcile the running set against the server's list: activate newly
 * enabled plugins, dispose disabled/removed ones, verify signatures against
 * the user's trusted keys. Safe to call repeatedly (boot + after changes).
 */
export async function syncPlugins(client: DataClient): Promise<PluginStatus[]> {
  let plugins = await client.listPlugins();

  // Auto-install bundled first-party plugins that are missing and not dismissed.
  const seeded = await seedBundledPlugins(client, plugins);
  if (seeded.length > 0) {
    plugins = await client.listPlugins();
  }
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
