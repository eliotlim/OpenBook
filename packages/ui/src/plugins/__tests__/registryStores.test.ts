import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {canonicalDigest, canonicalJson, signPlugin, generateRegistryKeys, RegistryError, type DataClient, type PluginPackage} from '@book.dev/sdk';
import {
  addPluginStore,
  listPluginStores,
  refreshRevocations,
  removePluginStore,
  resolvePlugin,
  revokedEntryFor,
  storeProvenanceChanged,
  verifyFromStore,
  installVerified,
} from '../registryStores';

/**
 * OB-641 (ST-6) — the pinned-stores module: pin persistence, the append-only
 * revocation cache, resolution across stores, and the verified-install path's
 * revocation refusal (a revoked version must never install).
 */

const te = new TextEncoder();
const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

interface FakeState {
  pkg: PluginPackage;
  digest: string;
  pinnedKey: string;
  revocations: Array<Record<string, unknown>>;
  maxSeq: number;
  downloadRevoked?: boolean;
  revocationsUnavailable?: boolean;
}

/** A minimal openbook-registry/1 fake behind globalThis.fetch (no notary key). */
function serveFake(state: FakeState): void {
  vi.stubGlobal('fetch', async (rawUrl: string | URL | Request): Promise<Response> => {
    const url = new URL(String(rawUrl instanceof Request ? rawUrl.url : rawUrl));
    const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
    if (url.pathname === '/api/v1/registry') {
      return json({
        protocol: 'openbook-registry/1',
        name: 'Fake Store',
        baseUrl: url.origin,
        apiVersion: 1,
        algorithms: ['ed25519'],
        notaryPublicKey: null,
        registryPublicKey: null,
        fingerprints: {notary: null, registry: null},
        endpoints: {},
      });
    }
    if (url.pathname === '/api/v1/index') {
      const m = state.pkg.manifest;
      return json({
        plugins: [
          {id: m.id, name: m.name, description: m.description ?? '', icon: m.icon ?? null, category: null, publisher: 'Acme Corp', pinnedKey: state.pinnedKey, latestVersion: m.version, digest: state.digest, artifactSha256: 'x'},
        ],
        limit: 50,
        nextCursor: null,
        hasMore: false,
      });
    }
    if (/\/download$/.test(url.pathname)) {
      if (state.downloadRevoked) return json({error: 'revoked', message: 'revoked'}, {status: 410});
      const bytes = te.encode(JSON.stringify(state.pkg));
      return new Response(bytes as BodyInit, {headers: {etag: `"${await sha256Hex(bytes)}"`, 'x-canonical-digest': state.digest}});
    }
    if (url.pathname === '/api/v1/revocations') {
      if (state.revocationsUnavailable) throw new Error('revocation feed offline');
      const since = Number(url.searchParams.get('since') ?? '0');
      return json({maxSeq: state.maxSeq, revocations: state.revocations.filter((r) => (r.seq as number) > since)});
    }
    return json({error: 'not_found', message: url.pathname}, {status: 404});
  });
}

async function fixture(): Promise<FakeState> {
  const keys = await generateRegistryKeys();
  const manifest = {id: 'acme.widget', name: 'Widget', version: '1.2.0', main: 'src/index.ts'};
  const files = {'src/index.ts': 'export default () => {};'};
  const signature = await signPlugin({manifest, files}, keys.privateKey, 'Fake Store', keys.publicKey);
  return {
    pkg: {manifest, files, signature},
    digest: await canonicalDigest(manifest, files),
    pinnedKey: keys.publicKey,
    revocations: [],
    maxSeq: 0,
  };
}

const unsignedEntry = (seq: number, pluginId: string, version: string | null) => ({
  id: `rev${seq}`,
  seq,
  pluginId,
  version,
  reason: 'compromised build',
  signerPublicKey: null,
  signature: null,
  createdAt: new Date(0).toISOString(),
});

async function signMessage(privateKeyB64: string, message: string): Promise<string> {
  const bytes = Uint8Array.from(atob(privateKeyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bytes as BufferSource, 'Ed25519', false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, te.encode(message) as BufferSource));
  return btoa(String.fromCharCode(...signature));
}

beforeEach(() => {
  localStorage.clear();
  addPluginStore({name: 'Fake Store', baseUrl: 'https://store.test', notaryPublicKey: null, registryPublicKey: null});
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('pin persistence', () => {
  it('adds, dedupes by baseUrl, and removes', () => {
    addPluginStore({name: 'Renamed', baseUrl: 'https://store.test', notaryPublicKey: null, registryPublicKey: null});
    expect(listPluginStores()).toHaveLength(1);
    expect(listPluginStores()[0].name).toBe('Renamed');
    removePluginStore('https://store.test');
    expect(listPluginStores()).toHaveLength(0);
  });

  it('clears that store\'s cached revocations when unpinned', () => {
    localStorage.setItem('openbook.storeRevocations', JSON.stringify({
      'https://store.test': {maxSeq: 1, entries: [unsignedEntry(1, 'acme.widget', null)], fetchedAt: new Date().toISOString(), generatedAt: null},
    }));
    removePluginStore('https://store.test');
    expect(JSON.parse(localStorage.getItem('openbook.storeRevocations') ?? '{}')).toEqual({});
  });
});

describe('revocation cache', () => {
  it('is append-only: entries survive a later response that omits them', async () => {
    const state = await fixture();
    serveFake(state);
    state.revocations = [unsignedEntry(1, 'acme.widget', '1.2.0')];
    state.maxSeq = 1;
    await refreshRevocations({force: true});
    expect((await revokedEntryFor('acme.widget', '1.2.0'))?.reason).toBe('compromised build');

    // The feed "forgets" the entry (or the since-window excludes it) — the
    // cached copy keeps being honoured.
    state.revocations = [];
    await refreshRevocations({force: true});
    expect(await revokedEntryFor('acme.widget', '1.2.0')).not.toBeNull();
  });

  it('an unreachable feed keeps the last-known-good copy', async () => {
    const state = await fixture();
    serveFake(state);
    state.revocations = [unsignedEntry(1, 'acme.widget', null)];
    state.maxSeq = 1;
    await refreshRevocations({force: true});

    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await refreshRevocations({force: true});
    expect(await revokedEntryFor('acme.widget', '9.9.9')).not.toBeNull();
  });

  it('re-verifies cached signatures against the pinned notary key on read', async () => {
    const notary = await generateRegistryKeys();
    addPluginStore({name: 'Fake Store', baseUrl: 'https://store.test', notaryPublicKey: notary.publicKey, registryPublicKey: null});
    const entry = unsignedEntry(1, 'acme.widget', '1.2.0');
    const payload = canonicalJson({
      id: entry.id,
      pluginId: entry.pluginId,
      reason: entry.reason,
      revokedAt: entry.createdAt,
      seq: entry.seq,
      version: entry.version,
    });
    const signed = {...entry, signerPublicKey: notary.publicKey, signature: await signMessage(notary.privateKey, payload)};
    localStorage.setItem('openbook.storeRevocations', JSON.stringify({
      'https://store.test': {maxSeq: 1, entries: [signed], fetchedAt: new Date().toISOString(), generatedAt: new Date().toISOString()},
    }));
    expect(await revokedEntryFor('acme.widget', '1.2.0')).not.toBeNull();

    localStorage.setItem('openbook.storeRevocations', JSON.stringify({
      'https://store.test': {maxSeq: 1, entries: [{...signed, reason: 'localStorage forgery'}], fetchedAt: new Date().toISOString(), generatedAt: new Date().toISOString()},
    }));
    expect(await revokedEntryFor('acme.widget', '1.2.0')).toBeNull();
  });
});

describe('resolve + verified install', () => {
  it('resolves a plugin id across pinned stores and verifies the download', async () => {
    const state = await fixture();
    serveFake(state);
    const res = await resolvePlugin('acme.widget');
    expect(res?.entry.publisher).toBe('Acme Corp');
    const download = await verifyFromStore(res!);
    expect(download.pkg.manifest.id).toBe('acme.widget');
    expect(download.trust).toEqual({firstParty: false, notarised: false});

    const installed: PluginPackage[] = [];
    const client = {installPlugin: async (pkg: PluginPackage) => (installed.push(pkg), {...pkg, enabled: true, installedAt: ''})} as unknown as DataClient;
    await installVerified(client, download);
    expect(installed).toHaveLength(1);
  });

  it('NEVER installs a revoked version: refused at verify time…', async () => {
    const state = await fixture();
    serveFake(state);
    state.revocations = [unsignedEntry(1, 'acme.widget', '1.2.0')];
    state.maxSeq = 1;
    const res = await resolvePlugin('acme.widget');
    await expect(verifyFromStore(res!)).rejects.toMatchObject({code: 'revoked'});
  });

  it('fails closed when a fresh cached feed becomes unreachable at install verification', async () => {
    const state = await fixture();
    serveFake(state);
    await refreshRevocations({force: true});
    state.revocationsUnavailable = true;
    const res = await resolvePlugin('acme.widget');
    await expect(verifyFromStore(res!)).rejects.toMatchObject({code: 'revocation_unavailable'});
  });

  it('fails closed when a stale cached feed is unreachable at install verification', async () => {
    const state = await fixture();
    serveFake(state);
    await refreshRevocations({force: true});
    const cache = JSON.parse(localStorage.getItem('openbook.storeRevocations') ?? '{}') as Record<string, Record<string, unknown>>;
    cache['https://store.test']!.fetchedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    localStorage.setItem('openbook.storeRevocations', JSON.stringify(cache));
    state.revocationsUnavailable = true;
    const res = await resolvePlugin('acme.widget');
    await expect(verifyFromStore(res!)).rejects.toMatchObject({code: 'revocation_unavailable'});
  });

  it('…and again at install time, even for an already-verified download', async () => {
    const state = await fixture();
    serveFake(state);
    const res = await resolvePlugin('acme.widget');
    const download = await verifyFromStore(res!);

    // The revocation lands between verify and consent.
    state.revocations = [unsignedEntry(1, 'acme.widget', '1.2.0')];
    state.maxSeq = 1;
    await refreshRevocations({force: true});

    const client = {installPlugin: vi.fn()} as unknown as DataClient;
    await expect(installVerified(client, download)).rejects.toBeInstanceOf(RegistryError);
    expect((client.installPlugin as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('a 410 download is refused even if the revocation feed is silent', async () => {
    const state = await fixture();
    serveFake(state);
    state.downloadRevoked = true;
    const res = await resolvePlugin('acme.widget');
    await expect(verifyFromStore(res!)).rejects.toMatchObject({code: 'revoked'});
  });

  it('persists first-seen store/key provenance and warns when an update changes it', async () => {
    const state = await fixture();
    serveFake(state);
    const resolution = (await resolvePlugin('acme.widget'))!;
    const download = await verifyFromStore(resolution);
    const client = {
      installPlugin: async (pkg: PluginPackage) => ({...pkg, enabled: true, installedAt: ''}),
    } as unknown as DataClient;
    await installVerified(client, download);

    expect(storeProvenanceChanged(download)).toBe(false);
    expect(storeProvenanceChanged({
      ...download,
      provenance: {...download.provenance, baseUrl: 'https://other-store.test'},
    })).toBe(true);
    expect(storeProvenanceChanged({
      ...download,
      provenance: {...download.provenance, pinnedKeys: [...download.provenance.pinnedKeys, 'rotated-key']},
    })).toBe(true);
  });
});
