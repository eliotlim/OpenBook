import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DataClient, PluginPackage, StoredPlugin} from '@book.dev/sdk';
import {syncPlugins, pluginStatuses} from '../host';
import {BUNDLED_PLUGINS} from '../bundled.gen';

/**
 * OB-641 (ST-6) — the host's upgrade + revocation behaviour:
 *
 * - seedBundledPlugins version-compares instead of presence-checking, so a
 *   build that ships a newer bundled plugin upgrades an older install —
 *   through the normal install path, which preserves the user's enabled
 *   choice server-side — and a build older than the install leaves it alone.
 * - syncPlugins honours the cached revocation list: a revoked version is
 *   disposed and never activated, regardless of its enabled flag.
 */

const bundled = BUNDLED_PLUGINS[0]; // openbook.ledger, signed at build

const asStored = (pkg: PluginPackage, over: Partial<StoredPlugin> = {}): StoredPlugin => ({
  ...pkg,
  enabled: true,
  installedAt: new Date(0).toISOString(),
  ...over,
});

/** A stub client that records installs and serves a mutable plugin list. */
function stubClient(initial: StoredPlugin[]): {client: DataClient; installs: PluginPackage[]; list: StoredPlugin[]} {
  const list = [...initial];
  const installs: PluginPackage[] = [];
  const client = {
    listPlugins: async () => [...list],
    installPlugin: async (pkg: PluginPackage) => {
      installs.push(pkg);
      // Mirror the server: upgrades preserve the enabled flag; fresh installs enable.
      const at = list.findIndex((p) => p.manifest.id === pkg.manifest.id);
      const stored = asStored(pkg, {enabled: at >= 0 ? list[at].enabled : true});
      if (at >= 0) list[at] = stored;
      else list.push(stored);
      return stored;
    },
    setPluginEnabled: vi.fn(),
  } as unknown as DataClient;
  return {client, installs, list};
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  // Drain the module-singleton host state so files don't leak into each other.
  await syncPlugins({listPlugins: async () => [], installPlugin: async (p: PluginPackage) => asStored(p)} as unknown as DataClient).catch(() => undefined);
  localStorage.clear();
});

describe('bundled plugin upgrade seeding', () => {
  it('upgrades an older installed copy without touching the enabled flag', async () => {
    const old = asStored(
      {...bundled, manifest: {...bundled.manifest, version: '0.0.1'}},
      {enabled: false}, // the user turned it off — the upgrade must not turn it on
    );
    const {client, installs, list} = stubClient([old]);

    await syncPlugins(client);

    expect(installs.map((p) => p.manifest.id)).toContain(bundled.manifest.id);
    const upgraded = list.find((p) => p.manifest.id === bundled.manifest.id)!;
    expect(upgraded.manifest.version).toBe(bundled.manifest.version);
    expect(upgraded.enabled).toBe(false); // preserved, not forced
    expect((client.setPluginEnabled as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // A disabled plugin stays disabled in the status list too.
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === bundled.manifest.id)?.state).toBe('disabled');
  });

  it('does not reinstall when the installed version is current', async () => {
    const {client, installs} = stubClient([asStored(bundled)]);
    await syncPlugins(client);
    expect(installs.map((p) => p.manifest.id)).not.toContain(bundled.manifest.id);
  });

  it('never downgrades: an installed copy NEWER than the bundle is left alone', async () => {
    const newer = asStored({...bundled, manifest: {...bundled.manifest, version: '999.0.0'}});
    const {client, installs} = stubClient([newer]);
    await syncPlugins(client);
    expect(installs.map((p) => p.manifest.id)).not.toContain(bundled.manifest.id);
  });

  it('still respects an explicit dismissal for fresh installs', async () => {
    localStorage.setItem('openbook.bundledPluginsDismissed', JSON.stringify([bundled.manifest.id]));
    const {client, installs} = stubClient([]);
    await syncPlugins(client);
    expect(installs.map((p) => p.manifest.id)).not.toContain(bundled.manifest.id);
  });
});

describe('revocation enforcement in syncPlugins', () => {
  beforeEach(() => {
    localStorage.setItem('openbook.pluginStores', JSON.stringify([
      {name: 'Test Store', baseUrl: 'https://store.test', notaryPublicKey: null, registryPublicKey: null},
    ]));
  });

  const revokedCache = (pluginId: string, version: string | null) =>
    JSON.stringify({
      'https://store.test': {
        maxSeq: 1,
        fetchedAt: new Date().toISOString(),
        entries: [
          {id: 'rev1', seq: 1, pluginId, version, reason: 'compromised build', signerPublicKey: null, signature: null, createdAt: new Date(0).toISOString()},
        ],
      },
    });

  const plugin = (id: string, version: string): StoredPlugin =>
    asStored({manifest: {id, name: id, version, main: 'src/index.ts'}, files: {'src/index.ts': 'export default () => {};'}});

  it('a revoked version is disposed and never activated, enabled or not', async () => {
    localStorage.setItem('openbook.storeRevocations', revokedCache('acme.revoked', '1.0.0'));
    const {client} = stubClient([asStored(bundled), plugin('acme.revoked', '1.0.0')]);
    await syncPlugins(client);

    const status = pluginStatuses().find((s) => s.plugin.manifest.id === 'acme.revoked');
    expect(status?.state).toBe('revoked');
    expect(status?.error).toContain('compromised');
  });

  it('a version:null entry covers every version of the plugin', async () => {
    localStorage.setItem('openbook.storeRevocations', revokedCache('acme.revoked', null));
    const {client} = stubClient([plugin('acme.revoked', '3.2.1')]);
    await syncPlugins(client);
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'acme.revoked')?.state).toBe('revoked');
  });

  it('other versions of a version-scoped revocation still run', async () => {
    localStorage.setItem('openbook.storeRevocations', revokedCache('acme.revoked', '1.0.0'));
    const {client} = stubClient([plugin('acme.revoked', '1.0.1')]);
    await syncPlugins(client);
    expect(pluginStatuses().find((s) => s.plugin.manifest.id === 'acme.revoked')?.state).toBe('active');
  });
});
