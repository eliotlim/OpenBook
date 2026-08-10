import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {LOCAL_OWNER_HEADER, type PluginPackage} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore, PluginDowngradeError} from './store';
import {createApp} from './app';

/**
 * OB-641 (ST-6) — the plugin UPGRADE path. An upgrade must behave like an
 * update, not a re-install: the user's enabled choice and the original
 * install time survive, and a downgrade (which can silently reopen holes a
 * newer version fixed) is refused unless explicitly forced.
 */

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshStore(): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-st6-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const pkg = (version: string, extra: Partial<PluginPackage> = {}): PluginPackage => ({
  manifest: {id: 'acme.widget', name: 'Widget', version, main: 'index.ts'},
  files: {'index.ts': `export {}; // v${version}`},
  ...extra,
});

describe('store.upsertPlugin upgrade semantics', () => {
  it('a fresh install lands enabled', async () => {
    const store = await freshStore();
    const installed = await store.upsertPlugin(pkg('1.0.0'));
    expect(installed.enabled).toBe(true);
    expect(installed.manifest.version).toBe('1.0.0');
  });

  it('an upgrade preserves a user-disabled state and the original installed_at', async () => {
    const store = await freshStore();
    const first = await store.upsertPlugin(pkg('1.0.0'));
    await store.setPluginEnabled('acme.widget', false);

    const upgraded = await store.upsertPlugin(pkg('1.1.0'));
    expect(upgraded.manifest.version).toBe('1.1.0');
    expect(upgraded.enabled).toBe(false); // never force-enabled
    expect(upgraded.installedAt).toBe(first.installedAt); // an upgrade is not a re-install
    expect(upgraded.files['index.ts']).toContain('v1.1.0');
  });

  it('an upgrade keeps an enabled plugin enabled', async () => {
    const store = await freshStore();
    await store.upsertPlugin(pkg('1.0.0'));
    const upgraded = await store.upsertPlugin(pkg('2.0.0'));
    expect(upgraded.enabled).toBe(true);
  });

  it('rejects a downgrade unless allowDowngrade is explicit', async () => {
    const store = await freshStore();
    await store.upsertPlugin(pkg('1.2.0'));
    await expect(store.upsertPlugin(pkg('1.1.9'))).rejects.toBeInstanceOf(PluginDowngradeError);
    // Still on the newer version.
    expect((await store.getPlugin('acme.widget'))?.manifest.version).toBe('1.2.0');

    const forced = await store.upsertPlugin(pkg('1.1.9'), {allowDowngrade: true});
    expect(forced.manifest.version).toBe('1.1.9');
  });

  it('an equal-version re-install is allowed and replaces content (repair/re-sign path)', async () => {
    const store = await freshStore();
    await store.upsertPlugin(pkg('1.0.0'));
    await store.setPluginEnabled('acme.widget', false);
    const again = await store.upsertPlugin(pkg('1.0.0', {files: {'index.ts': 'export {}; // repaired'}}));
    expect(again.files['index.ts']).toContain('repaired');
    expect(again.enabled).toBe(false); // still the user's choice
  });

  it('non-semver versions are not comparable and pass through', async () => {
    const store = await freshStore();
    await store.upsertPlugin({manifest: {id: 'acme.widget', name: 'W', version: 'dev', main: 'index.ts'}, files: {'index.ts': ''}});
    const next = await store.upsertPlugin(pkg('0.0.1'));
    expect(next.manifest.version).toBe('0.0.1');
  });
});

describe('POST /api/plugins downgrade mapping', () => {
  it('409s a downgrade; ?allowDowngrade=1 forces it through', async () => {
    const store = await freshStore();
    const localOwnerSecret = 'plugin-upgrade-local-owner-secret';
    const app = createApp(store, undefined, undefined, {localOwnerSecret});
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-OpenBook-Client': '1',
          [LOCAL_OWNER_HEADER]: localOwnerSecret,
        },
        body: JSON.stringify(body),
      });

    expect((await post('/api/plugins', pkg('2.0.0'))).status).toBe(201);
    const denied = await post('/api/plugins', pkg('1.0.0'));
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as {error: string}).error).toContain('downgrade');
    expect((await store.getPlugin('acme.widget'))?.manifest.version).toBe('2.0.0');

    expect((await post('/api/plugins?allowDowngrade=1', pkg('1.0.0'))).status).toBe(201);
    expect((await store.getPlugin('acme.widget'))?.manifest.version).toBe('1.0.0');
  });
});
