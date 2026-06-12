import {describe, expect, it} from 'vitest';
import {OPENBOOK_REGISTRY, type DataClient, type StoredPlugin} from '@open-book/sdk';
import {syncPlugins, pluginStatuses, trustedRegistryKeys, addTrustedRegistry, removeTrustedRegistry} from '../host';
import {pluginCommands} from '../commandRegistry';
import {getCustomBlock} from '../../blockeditor/registry';

const plugin = (id: string, entry: string, enabled = true): StoredPlugin => ({
  manifest: {id, name: id, version: '1.0.0', main: 'src/index.ts'},
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
      import {api} from '@open-book/plugin-sdk';
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
