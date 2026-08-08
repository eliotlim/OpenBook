import {describe, expect, it} from 'vitest';
import {canonicalDigest, canonicalJson, signPlugin, generateRegistryKeys, type PluginManifest, type PluginPackage} from './plugins';
import {
  RegistryClient,
  compareSemver,
  fetchRegistryDocument,
  isSemver,
  registryBaseUrlProblem,
  registryKeyFingerprint,
  revocationMatches,
  type FetchLike,
  type RegistryRevocation,
} from './registryClient';

// ── An in-memory openbook-registry/1 fake (PROTOCOL.md is the contract) ──────

interface FakeVersion {
  pkg: PluginPackage;
  digest: string;
  status: string;
  notarize?: boolean;
  revoked?: boolean;
}

interface FakeRegistry {
  name: string;
  notary: {publicKey: string; privateKey: string} | null;
  registryKeys: {publicKey: string; privateKey: string} | null;
  plugins: Map<string, {pinnedKey: string; publisher: string; versions: FakeVersion[]}>;
  revocations: RegistryRevocation[];
  /** Corrupt the served download bytes (transport tampering). */
  corruptDownloads?: boolean;
  /** Lie in the ETag (should be caught by the hash check). */
  badEtag?: boolean;
  protocol?: string;
}

const te = new TextEncoder();

async function signMessage(privateKeyB64: string, message: string): Promise<string> {
  const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', fromB64(privateKeyB64) as BufferSource, 'Ed25519', false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, te.encode(message) as BufferSource));
  return btoa(String.fromCharCode(...sig));
}

const sha256HexOf = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const latestApproved = (versions: FakeVersion[]): FakeVersion | null => {
  const ok = versions.filter((v) => v.status === 'approved');
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => (compareSemver(a.pkg.manifest.version, b.pkg.manifest.version) >= 0 ? a : b));
};

function fakeFetch(reg: FakeRegistry, base = 'https://store.test'): FetchLike {
  const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {headers: {'content-type': 'application/json; charset=utf-8'}, ...init});

  return async (rawUrl: string): Promise<Response> => {
    const url = new URL(rawUrl);
    if (!rawUrl.startsWith(base)) return json({error: 'not_found', message: 'wrong host'}, {status: 404});
    const path = url.pathname;

    if (path === '/api/v1/registry') {
      return json({
        protocol: reg.protocol ?? 'openbook-registry/1',
        name: reg.name,
        baseUrl: base,
        apiVersion: 1,
        algorithms: ['ed25519'],
        notaryPublicKey: reg.notary?.publicKey ?? null,
        registryPublicKey: reg.registryKeys?.publicKey ?? null,
        fingerprints: {notary: null, registry: null},
        endpoints: {
          index: '/api/v1/index',
          plugin: '/api/v1/plugins/{id}',
          download: '/api/v1/plugins/{id}/versions/{version}/download',
          revocations: '/api/v1/revocations',
        },
      });
    }

    if (path === '/api/v1/index') {
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      const rows = [...reg.plugins.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, p]) => ({id, p, latest: latestApproved(p.versions)}))
        .filter((r) => r.latest !== null)
        .filter((r) => !q || r.id.toLowerCase().includes(q) || r.latest!.pkg.manifest.name.toLowerCase().includes(q))
        .map(({id, p, latest}) => ({
          id,
          name: latest!.pkg.manifest.name,
          description: latest!.pkg.manifest.description ?? '',
          icon: latest!.pkg.manifest.icon ?? null,
          category: null,
          publisher: p.publisher,
          pinnedKey: p.pinnedKey,
          latestVersion: latest!.pkg.manifest.version,
          digest: latest!.digest,
          artifactSha256: 'unused',
        }));
      // Two-row pages exercise the cursor walk.
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
      const page = rows.slice(start, start + 2);
      const nextCursor = start + 2 < rows.length ? page[page.length - 1]!.id : null;
      return json({plugins: page, limit: 2, nextCursor, hasMore: nextCursor !== null});
    }

    const pluginMatch = /^\/api\/v1\/plugins\/([^/]+)$/.exec(path);
    if (pluginMatch) {
      const id = decodeURIComponent(pluginMatch[1]!);
      const p = reg.plugins.get(id);
      if (!p) return json({error: 'not_found', message: 'unknown plugin'}, {status: 404});
      return json({
        id,
        pinnedKey: p.pinnedKey,
        createdAt: new Date(0).toISOString(),
        versions: await Promise.all(
          p.versions.map(async (v) => ({
            version: v.pkg.manifest.version,
            digest: v.digest,
            artifactSha256: 'unused',
            status: v.status,
            createdAt: new Date(0).toISOString(),
            manifest: v.pkg.manifest,
            notarization: v.notarize && reg.notary
              ? {registry: reg.name, publicKey: reg.notary.publicKey, signature: await signMessage(reg.notary.privateKey, v.digest), algorithm: 'ed25519', timestamp: new Date(0).toISOString()}
              : null,
          })),
        ),
      });
    }

    const dlMatch = /^\/api\/v1\/plugins\/([^/]+)\/versions\/([^/]+)\/download$/.exec(path);
    if (dlMatch) {
      const id = decodeURIComponent(dlMatch[1]!);
      const version = decodeURIComponent(dlMatch[2]!);
      const p = reg.plugins.get(id);
      const v = p?.versions.find((x) => x.pkg.manifest.version === version);
      if (!p || !v || v.status !== 'approved') return json({error: 'not_found', message: 'unknown version'}, {status: 404});
      if (v.revoked) return json({error: 'revoked', message: 'revoked'}, {status: 410});
      const doc: Record<string, unknown> = {...v.pkg};
      if (v.notarize && reg.notary) {
        doc.notarization = {
          registry: reg.name,
          publicKey: reg.notary.publicKey,
          signature: await signMessage(reg.notary.privateKey, v.digest),
          algorithm: 'ed25519',
          timestamp: new Date(0).toISOString(),
        };
      }
      let bytes = te.encode(JSON.stringify(doc));
      const etag = `"${await sha256HexOf(bytes)}"`;
      if (reg.corruptDownloads) bytes = te.encode(JSON.stringify({...doc, files: {...v.pkg.files, 'evil.ts': '// injected'}}));
      return new Response(bytes as BodyInit, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          etag: reg.badEtag ? '"0000"' : etag,
          'x-canonical-digest': v.digest,
        },
      });
    }

    if (path === '/api/v1/revocations') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const list = reg.revocations.filter((r) => r.seq > since);
      const maxSeq = reg.revocations.reduce((n, r) => Math.max(n, r.seq), 0);
      return json({policy: 'test', maxSeq, revocations: list});
    }

    return json({error: 'not_found', message: path}, {status: 404});
  };
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

const manifestOf = (version: string): PluginManifest => ({
  id: 'acme.sparkline',
  name: 'Sparkline',
  version,
  description: 'A tiny inline chart.',
  icon: '📈',
  main: 'src/index.ts',
});

async function makeRegistry(opts: {notarize?: boolean; withNotary?: boolean; firstParty?: boolean} = {}): Promise<{
  reg: FakeRegistry;
  fetchImpl: FetchLike;
  publisher: {publicKey: string; privateKey: string};
  client: RegistryClient;
}> {
  const notary = opts.withNotary === false ? null : await generateRegistryKeys();
  const registryKeys = await generateRegistryKeys();
  const publisher = opts.firstParty ? registryKeys : await generateRegistryKeys();

  const mk = async (version: string): Promise<FakeVersion> => {
    const manifest = manifestOf(version);
    const files = {'src/index.ts': `export default () => {}; // v${version}`};
    const signature = await signPlugin({manifest, files}, publisher.privateKey, 'Fake Store', publisher.publicKey);
    return {pkg: {manifest, files, signature}, digest: await canonicalDigest(manifest, files), status: 'approved', notarize: opts.notarize};
  };

  const reg: FakeRegistry = {
    name: 'Fake Store',
    notary,
    registryKeys,
    plugins: new Map([
      ['acme.sparkline', {pinnedKey: publisher.publicKey, publisher: 'Acme Corp', versions: [await mk('1.0.0'), await mk('1.2.3')]}],
    ]),
    revocations: [],
  };
  const fetchImpl = fakeFetch(reg);
  const client = new RegistryClient(
    {baseUrl: 'https://store.test', name: reg.name, notaryPublicKey: notary?.publicKey ?? null, registryPublicKey: registryKeys.publicKey},
    {fetch: fetchImpl},
  );
  return {reg, fetchImpl, publisher, client};
}

async function signedRevocation(
  notaryPrivateKey: string,
  notaryPublicKey: string,
  entry: {id: string; seq: number; pluginId: string; version: string | null; reason: string; createdAt: string},
): Promise<RegistryRevocation> {
  const payload = canonicalJson({
    id: entry.id,
    pluginId: entry.pluginId,
    reason: entry.reason,
    revokedAt: entry.createdAt,
    seq: entry.seq,
    version: entry.version,
  });
  return {...entry, signerPublicKey: notaryPublicKey, signature: await signMessage(notaryPrivateKey, payload)};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('semver', () => {
  it('accepts and orders semver per spec', () => {
    expect(isSemver('1.2.3')).toBe(true);
    expect(isSemver('1.2')).toBe(false);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0-alpha', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('2.0.0-alpha.2', '2.0.0-alpha.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0+build.9', '1.0.0+build.1')).toBe(0);
  });
});

describe('registry document', () => {
  it('refuses a non-https base URL (localhost excepted)', async () => {
    expect(registryBaseUrlProblem('http://evil.example')).toBeTruthy();
    expect(registryBaseUrlProblem('https://store.test')).toBeNull();
    expect(registryBaseUrlProblem('http://localhost:8788')).toBeNull();
    await expect(fetchRegistryDocument('http://evil.example', async () => new Response('{}'))).rejects.toMatchObject({code: 'insecure_base_url'});
  });

  it('refuses an unknown protocol major', async () => {
    const {reg, fetchImpl} = await makeRegistry();
    reg.protocol = 'openbook-registry/2';
    await expect(fetchRegistryDocument('https://store.test', fetchImpl)).rejects.toMatchObject({code: 'unsupported_protocol'});
  });

  it('refuses a registry whose keys stopped matching the pin', async () => {
    const {reg, fetchImpl} = await makeRegistry();
    const rogue = await generateRegistryKeys();
    const pinned = new RegistryClient(
      {baseUrl: 'https://store.test', notaryPublicKey: rogue.publicKey, registryPublicKey: reg.registryKeys!.publicKey},
      {fetch: fetchImpl},
    );
    await expect(pinned.document()).rejects.toMatchObject({code: 'unsupported_protocol'});
  });

  it('renders a stable human fingerprint', async () => {
    const {publicKey} = await generateRegistryKeys();
    const fp = await registryKeyFingerprint(publicKey);
    expect(fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
    expect(await registryKeyFingerprint(publicKey)).toBe(fp);
  });
});

describe('index', () => {
  it('walks cursors sequentially and finds an exact id', async () => {
    const {client} = await makeRegistry();
    const all = await client.indexAll();
    expect(all.map((p) => p.id)).toEqual(['acme.sparkline']);
    expect(all[0]!.latestVersion).toBe('1.2.3'); // semver max, not publish order
    const found = await client.findIndexEntry('acme.sparkline');
    expect(found?.publisher).toBe('Acme Corp');
    expect(await client.findIndexEntry('acme.nope')).toBeNull();
  });
});

describe('download verification', () => {
  it('verifies an approved notarised download end to end', async () => {
    const {client} = await makeRegistry({notarize: true});
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    const got = await client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey});
    expect(got.pkg.manifest.version).toBe('1.2.3');
    expect(got.trust.notarised).toBe(true);
    expect(got.trust.firstParty).toBe(false);
    expect(got.digest).toBe(entry.digest);
  });

  it('recognises a first-party package (publisher key IS the registry key)', async () => {
    const {client} = await makeRegistry({firstParty: true, notarize: true});
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    const got = await client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey});
    expect(got.trust.firstParty).toBe(true);
    expect(got.trust.notarised).toBe(true);
  });

  it('hard-fails on tampered bytes (digest mismatch)', async () => {
    const {reg, client} = await makeRegistry();
    reg.corruptDownloads = true;
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    await expect(client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey})).rejects.toMatchObject({
      code: 'etag_mismatch',
    });
  });

  it('hard-fails when the ETag does not match the served bytes', async () => {
    const {reg, client} = await makeRegistry();
    reg.badEtag = true;
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    await expect(client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey})).rejects.toMatchObject({
      code: 'etag_mismatch',
    });
  });

  it('rejects a signature that does not verify against the PINNED publisher key', async () => {
    const {client} = await makeRegistry();
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    const stranger = await generateRegistryKeys();
    await expect(client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: stranger.publicKey})).rejects.toMatchObject({
      code: 'signature_invalid',
    });
  });

  it('treats a present-but-invalid notarization as a hard failure', async () => {
    const {reg, client} = await makeRegistry({notarize: true});
    // Re-point the pinned notary key: the served countersignature no longer verifies.
    const other = await generateRegistryKeys();
    const client2 = new RegistryClient(
      {baseUrl: 'https://store.test', notaryPublicKey: other.publicKey, registryPublicKey: null},
      {fetch: fakeFetch(reg)},
    );
    const entry = (await client2.findIndexEntry('acme.sparkline'))!;
    await expect(client2.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey})).rejects.toMatchObject({
      code: 'notarization_invalid',
    });
    void client;
  });

  it('surfaces a revoked download as its own failure code', async () => {
    const {reg, client} = await makeRegistry();
    reg.plugins.get('acme.sparkline')!.versions[1]!.revoked = true;
    const entry = (await client.findIndexEntry('acme.sparkline'))!;
    await expect(client.download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey})).rejects.toMatchObject({
      code: 'revoked',
    });
  });
});

describe('revocations', () => {
  const entryBase = {id: 'rev1', seq: 1, pluginId: 'acme.sparkline', version: '1.2.3' as string | null, reason: 'compromised build', createdAt: new Date(0).toISOString()};

  it('honours signed entries and reports maxSeq', async () => {
    const {reg, client} = await makeRegistry();
    reg.revocations = [await signedRevocation(reg.notary!.privateKey, reg.notary!.publicKey, entryBase)];
    const {maxSeq, entries} = await client.revocations();
    expect(maxSeq).toBe(1);
    expect(entries).toHaveLength(1);
    expect(revocationMatches(entries[0]!, 'acme.sparkline', '1.2.3')).toBe(true);
    expect(revocationMatches(entries[0]!, 'acme.sparkline', '1.0.0')).toBe(false);
    expect(revocationMatches({...entries[0]!, version: null}, 'acme.sparkline', '0.0.1')).toBe(true);
  });

  it('IGNORES unsigned or forged entries on a registry that advertises a notary key', async () => {
    const {reg, client} = await makeRegistry();
    const forged = {...entryBase, id: 'forged', seq: 2, signerPublicKey: reg.notary!.publicKey, signature: btoa('x'.repeat(64))};
    const unsigned = {...entryBase, id: 'unsigned', seq: 3, signerPublicKey: null, signature: null};
    const good = await signedRevocation(reg.notary!.privateKey, reg.notary!.publicKey, {...entryBase, id: 'good', seq: 4});
    reg.revocations = [forged, unsigned, good];
    const {entries, maxSeq} = await client.revocations();
    expect(entries.map((e) => e.id)).toEqual(['good']);
    expect(maxSeq).toBe(4);
  });

  it('honours unsigned entries only when the registry has NO notary key', async () => {
    const {reg} = await makeRegistry({withNotary: false});
    reg.revocations = [{...entryBase, signerPublicKey: null, signature: null}];
    const client = new RegistryClient({baseUrl: 'https://store.test', notaryPublicKey: null, registryPublicKey: null}, {fetch: fakeFetch(reg)});
    const {entries} = await client.revocations();
    expect(entries).toHaveLength(1);
  });

  it('passes `since` through and filters strictly greater', async () => {
    const {reg, client} = await makeRegistry();
    reg.revocations = [
      await signedRevocation(reg.notary!.privateKey, reg.notary!.publicKey, {...entryBase, id: 'a', seq: 1}),
      await signedRevocation(reg.notary!.privateKey, reg.notary!.publicKey, {...entryBase, id: 'b', seq: 2}),
    ];
    const {entries, maxSeq} = await client.revocations(1);
    expect(entries.map((e) => e.id)).toEqual(['b']);
    expect(maxSeq).toBe(2);
  });
});
