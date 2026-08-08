import {describe, expect, it, vi} from 'vitest';
// The REAL hello-openbook example, byte-for-byte (vite `?raw`): the loader
// back-compat proof below runs the shipped sources, not a copy.
import helloManifestJson from '../../../../../examples/plugins/hello-openbook/openbook.json?raw';
import helloIndexTs from '../../../../../examples/plugins/hello-openbook/src/index.ts?raw';
import helloBlockTsx from '../../../../../examples/plugins/hello-openbook/src/block.tsx?raw';
import {OPENBOOK_REGISTRY, PLUGIN_API_VERSION, type DataClient, type PluginManifest, type PluginPackage, type StoredPlugin} from '@book.dev/sdk';
import {syncPlugins, pluginStatuses, trustedRegistryKeys, addTrustedRegistry, removeTrustedRegistry} from '../host';
import {BUNDLED_PLUGINS} from '../bundled.gen';
import {pluginCommands} from '../commandRegistry';
import {getCustomBlock} from '../../blockeditor/registry';

const plugin = (id: string, entry: string, enabled = true, manifest?: Partial<PluginManifest>): StoredPlugin => ({
  manifest: {id, name: id, version: '1.0.0', main: 'src/index.ts', ...manifest},
  files: {'src/index.ts': entry},
  enabled,
  installedAt: new Date(0).toISOString(),
});

/** A client stub whose plugin list we mutate between sync calls. */
const clientWith = (plugins: StoredPlugin[]): DataClient =>
  ({listPlugins: async () => plugins}) as unknown as DataClient;

describe('plugin host', () => {
  it('activates, contributes, and tears down across the lifecycle', async () => {
    const source = `
      import {api} from '@book.dev/plugin-sdk';
      export default function activate(a) {
        a.commands.register({id: 'wave', title: 'Wave hello', run: () => {}});
        a.blocks.register({type: 'widget', render: () => null});
        void api;
      }
    `;
    const list = [plugin('acme.lifecycle', source)];
    await syncPlugins(clientWith(list));
    expect(pluginCommands().some((c) => c.id === 'acme.lifecycle/wave')).toBe(true);
    expect(getCustomBlock('acme.lifecycle/widget')).toBeDefined();
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'acme.lifecycle')?.state).toBe('active');

    // Disable → contributions vanish.
    await syncPlugins(clientWith([{...list[0], enabled: false}]));
    expect(pluginCommands().some((c) => c.id === 'acme.lifecycle/wave')).toBe(false);
    expect(getCustomBlock('acme.lifecycle/widget')).toBeUndefined();

    // Removed entirely → no status row.
    await syncPlugins(clientWith([]));
    expect(pluginStatuses()).toHaveLength(0);
  });

  it('isolates a crashing plugin and rolls back its partial contributions', async () => {
    const bad = plugin(
      'acme.broken',
      `export default function activate(a) {
         a.commands.register({id: 'ghost', title: 'Ghost', run: () => {}});
         throw new Error('boom on activate');
       }`,
    );
    const good = plugin('acme.fine', 'export default (a) => { a.commands.register({id: \'ok\', title: \'Ok\', run: () => {}}); };');
    await syncPlugins(clientWith([bad, good]));

    const statuses = pluginStatuses();
    expect(statuses.find((s) => s.plugin.manifest.id === 'acme.broken')?.state).toBe('error');
    expect(statuses.find((s) => s.plugin.manifest.id === 'acme.broken')?.error).toContain('boom');
    // The crashed plugin's partial registration was rolled back…
    expect(pluginCommands().some((c) => c.id === 'acme.broken/ghost')).toBe(false);
    // …and its neighbour is unaffected.
    expect(pluginCommands().some((c) => c.id === 'acme.fine/ok')).toBe(true);
    await syncPlugins(clientWith([]));
  });

  it('loads the unmodified hello-openbook example (back-compat: no apiVersion field)', async () => {
    const hello: StoredPlugin = {
      manifest: JSON.parse(helloManifestJson) as PluginManifest,
      files: {'src/index.ts': helloIndexTs, 'src/block.tsx': helloBlockTsx},
      enabled: true,
      installedAt: new Date(0).toISOString(),
    };
    expect(hello.manifest.apiVersion).toBeUndefined();

    await syncPlugins(clientWith([hello]));
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'openbook.hello')?.state).toBe('active');
    expect(pluginCommands().some((c) => c.id === 'openbook.hello/new-greeting-page')).toBe(true);
    expect(getCustomBlock('openbook.hello/hello')).toBeDefined();
    await syncPlugins(clientWith([]));
  });

  it('gates activation on apiVersion: older/equal fine, newer refused with the plugin id', async () => {
    const source = 'export default () => {};';
    const older = plugin('acme.older', source, true, {apiVersion: 1});
    const equal = plugin('acme.equal', source, true, {apiVersion: PLUGIN_API_VERSION});
    const newer = plugin('acme.newer', source, true, {apiVersion: PLUGIN_API_VERSION + 1});
    await syncPlugins(clientWith([older, equal, newer]));

    const state = (id: string): {state?: string; error?: string} => pluginStatuses().find((s) => s.plugin.manifest.id === id) ?? {};
    expect(state('acme.older').state).toBe('active');
    expect(state('acme.equal').state).toBe('active');
    expect(state('acme.newer').state).toBe('error');
    expect(state('acme.newer').error).toContain('acme.newer');
    expect(state('acme.newer').error).toContain(`v${PLUGIN_API_VERSION + 1}`);
    await syncPlugins(clientWith([]));
  });

  it('tears down a plugin row subscription on deactivate', async () => {
    const stop = vi.fn();
    const client = {
      listPlugins: async (): Promise<StoredPlugin[]> => list,
      subscribeRows: vi.fn(() => stop),
    } as unknown as DataClient;
    let list = [
      plugin('acme.live', 'import {api} from \'@book.dev/plugin-sdk\'; export default (a) => { a.databases.subscribeRows(\'db1\', () => {}); void api; };'),
    ];

    await syncPlugins(client);
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'acme.live')?.state).toBe('active');
    expect(stop).not.toHaveBeenCalled();

    // Disable → the host disposes the subscription; no leaked handlers.
    list = [{...list[0], enabled: false}];
    await syncPlugins(client);
    expect(stop).toHaveBeenCalledTimes(1);
    list = [];
    await syncPlugins(client);
  });

  it('tears down a subscription made AFTER deactivate (retained plugin callback)', async () => {
    const stop = vi.fn();
    const client = {
      listPlugins: async (): Promise<StoredPlugin[]> => list,
      subscribeRows: vi.fn(() => stop),
    } as unknown as DataClient;
    // The plugin stashes a callback (as a retained setTimeout/event handler
    // would) that only calls subscribeRows when invoked later.
    let list = [
      plugin('acme.retained', 'export default (a) => { globalThis.__lgr4Late = () => a.databases.subscribeRows(\'db1\', () => {}); };'),
    ];
    await syncPlugins(client);
    const late = (globalThis as Record<string, unknown>).__lgr4Late as () => () => void;
    expect(typeof late).toBe('function');
    expect(client.subscribeRows).not.toHaveBeenCalled();

    // Disable → dispose runs. Then the retained callback fires anyway.
    list = [{...list[0], enabled: false}];
    await syncPlugins(client);
    expect(stop).not.toHaveBeenCalled();
    late();

    // The client subscription was created — and torn down synchronously; no
    // live handler survives past the plugin's deactivation.
    expect(client.subscribeRows).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);

    delete (globalThis as Record<string, unknown>).__lgr4Late;
    list = [];
    await syncPlugins(client);
  });

  it('auto-installs the signed bundled plugins; a fresh install verifies once its registry key is trusted', async () => {
    // A fresh library: no plugins installed. syncPlugins seeds the bundled
    // first-party packages (signed at build by bundlePlugins.ts) through the
    // normal install path.
    const installed: StoredPlugin[] = [];
    const client = {
      listPlugins: async (): Promise<StoredPlugin[]> => [...installed],
      installPlugin: async (pkg: PluginPackage): Promise<StoredPlugin> => {
        const stored: StoredPlugin = {...pkg, enabled: true, installedAt: new Date(0).toISOString()};
        installed.push(stored);
        return stored;
      },
    } as unknown as DataClient;

    await syncPlugins(client);
    const ledger = (): {verifiedBy?: string} | undefined => pluginStatuses().find((s) => s.plugin.manifest.id === 'openbook.ledger');
    expect(ledger()).toBeDefined();
    expect(installed.some((p) => p.manifest.id === 'openbook.ledger' && p.signature)).toBe(true);

    const sig = BUNDLED_PLUGINS.find((p) => p.manifest.id === 'openbook.ledger')!.signature!;
    if (sig.publicKey !== OPENBOOK_REGISTRY.publicKey) {
      // Dev/test tree: the bundle is signed by the (unpinned) test key, so it
      // starts Unverified — provenance only appears once the key is trusted.
      expect(ledger()!.verifiedBy).toBeUndefined();
    }

    // Trust the registry key that signed the bundle → Verified on the next
    // sync. In production the pinned OPENBOOK_REGISTRY key plays this role
    // and no user action is needed.
    addTrustedRegistry(sig.registry, sig.publicKey);
    await syncPlugins(client);
    expect(ledger()!.verifiedBy).toBe(sig.registry);

    removeTrustedRegistry(sig.publicKey);
    await syncPlugins(clientWith([]));
  });

  it('manages the trusted-registry list around the pinned first-party key', () => {
    expect(trustedRegistryKeys()).toEqual([OPENBOOK_REGISTRY]);

    addTrustedRegistry('Acme Registry', 'a'.repeat(43) + '=');
    expect(trustedRegistryKeys()).toHaveLength(2);
    expect(trustedRegistryKeys()[1]).toEqual({name: 'Acme Registry', publicKey: 'a'.repeat(43) + '='});

    // Re-adding the same key and re-adding the pinned key are both no-ops.
    addTrustedRegistry('Acme Again', 'a'.repeat(43) + '=');
    addTrustedRegistry('Sneaky', OPENBOOK_REGISTRY.publicKey);
    expect(trustedRegistryKeys()).toHaveLength(2);

    removeTrustedRegistry('a'.repeat(43) + '=');
    expect(trustedRegistryKeys()).toEqual([OPENBOOK_REGISTRY]);
    // The pinned key survives any removal attempt.
    removeTrustedRegistry(OPENBOOK_REGISTRY.publicKey);
    expect(trustedRegistryKeys()).toEqual([OPENBOOK_REGISTRY]);
  });
});
