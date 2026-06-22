import {describe, expect, it} from 'vitest';
import {
  canonicalDigest,
  generateRegistryKeys,
  signPlugin,
  verifyPlugin,
  validateManifest,
  type PluginManifest,
} from '@book.dev/sdk';

const manifest: PluginManifest = {id: 'acme.demo', name: 'Demo', version: '1.0.0', main: 'src/index.ts'};
const files = {'src/index.ts': 'export default function activate() {}', 'src/util.ts': 'export const x = 1;'};

describe('canonicalDigest', () => {
  it('is stable across file-insertion order', async () => {
    const a = await canonicalDigest(manifest, files);
    const b = await canonicalDigest(manifest, {'src/util.ts': files['src/util.ts'], 'src/index.ts': files['src/index.ts']});
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any byte changes', async () => {
    const base = await canonicalDigest(manifest, files);
    expect(await canonicalDigest(manifest, {...files, 'src/util.ts': 'export const x = 2;'})).not.toBe(base);
    expect(await canonicalDigest({...manifest, version: '1.0.1'}, files)).not.toBe(base);
    // Boundary confusion: moving a byte between adjacent parts must differ.
    expect(await canonicalDigest(manifest, {a: 'xy', b: 'z'})).not.toBe(await canonicalDigest(manifest, {a: 'x', b: 'yz'}));
  });
});

describe('sign + verify', () => {
  it('verifies a signed package against its trusted key, and flags tampering', async () => {
    const keys = await generateRegistryKeys();
    const signature = await signPlugin({manifest, files}, keys.privateKey, 'Test Registry', keys.publicKey);
    const trusted = [{name: 'Test Registry', publicKey: keys.publicKey}];

    expect(await verifyPlugin({manifest, files, signature}, trusted)).toEqual({registry: 'Test Registry'});
    // Tampered content fails.
    expect(await verifyPlugin({manifest, files: {...files, 'src/index.ts': 'evil()'}, signature}, trusted)).toBeNull();
    // Untrusted key fails.
    expect(await verifyPlugin({manifest, files, signature}, [{name: 'Other', publicKey: (await generateRegistryKeys()).publicKey}])).toBeNull();
    // Unsigned is simply unverified.
    expect(await verifyPlugin({manifest, files}, trusted)).toBeNull();
  });
});

describe('validateManifest', () => {
  it('accepts well-formed manifests and names problems in bad ones', () => {
    expect(validateManifest(manifest)).toBeNull();
    expect(validateManifest({...manifest, id: 'NoDots'})).toContain('publisher.plugin-name');
    expect(validateManifest({...manifest, main: undefined})).toContain('main');
    expect(validateManifest(null)).toContain('openbook.json');
  });
});
