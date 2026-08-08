import {describe, expect, it} from 'vitest';
import {generateRegistryKeys, verifyPlugin, OPENBOOK_REGISTRY, OPENBOOK_REGISTRY_KEYS, type PluginManifest} from '@book.dev/sdk';
import {derivePublicKey, resolveSigningKey, signBundledPackage, TEST_REGISTRY_KEY_PATH} from './bundleSigning';
import {BUNDLED_PLUGINS} from '../src/plugins/bundled.gen';

const manifest: PluginManifest = {id: 'acme.bundled', name: 'Bundled', version: '1.0.0', main: 'src/index.ts'};
const files = {'src/index.ts': 'export default function activate() {}'};

describe('resolveSigningKey', () => {
  it('uses OPENBOOK_REGISTRY_PRIVATE_KEY when set, deriving the public half', async () => {
    const pair = await generateRegistryKeys();
    const key = resolveSigningKey({OPENBOOK_REGISTRY_PRIVATE_KEY: pair.privateKey});
    expect(key.source).toBe('env');
    expect(key.registry).toBe('OpenBook Registry');
    expect(key.privateKey).toBe(pair.privateKey);
    // The derived raw public key matches the one WebCrypto exported alongside.
    expect(key.publicKey).toBe(pair.publicKey);
    expect(derivePublicKey(pair.privateKey)).toBe(pair.publicKey);
  });

  it('falls back to the committed TEST-ONLY key when the env var is unset', () => {
    const key = resolveSigningKey({}, TEST_REGISTRY_KEY_PATH);
    expect(key.source).toBe('test');
    expect(key.registry).toBe('OpenBook Test Registry');
    // Self-consistency of the committed file: publicKey really is privateKey's.
    expect(derivePublicKey(key.privateKey)).toBe(key.publicKey);
  });

  it('NEVER pins the test key as production: no OPENBOOK_REGISTRY_KEYS entry may equal it', () => {
    // The committed test key's private half is public — if this fails, every
    // build would trust signatures anyone can mint. Release CI guards every
    // entry too; the unit test catches it at development time.
    const test = resolveSigningKey({}, TEST_REGISTRY_KEY_PATH);
    expect(OPENBOOK_REGISTRY_KEYS.length).toBeGreaterThan(0);
    for (const pinned of OPENBOOK_REGISTRY_KEYS) {
      expect(pinned.publicKey).not.toBe(test.publicKey);
    }
    // The deprecated alias stays wired to entry [0].
    expect(OPENBOOK_REGISTRY).toBe(OPENBOOK_REGISTRY_KEYS[0]);
  });

  it('rotation overlap: packages signed by EITHER of two pinned-style keys verify as first-party', async () => {
    // The mechanism behind docs/plugin-signing.md's add-then-remove rotation:
    // OPENBOOK_REGISTRY_KEYS is a list, and verification accepts any entry —
    // so during the overlap window (old key still signing, new key already
    // pinned) both generations of bundle verify.
    const oldKey = await generateRegistryKeys();
    const newKey = await generateRegistryKeys();
    const pinned = [
      {name: 'OpenBook Registry', publicKey: oldKey.publicKey},
      {name: 'OpenBook Registry (2027)', publicKey: newKey.publicKey},
    ];
    const signedByOld = await signBundledPackage({manifest, files}, resolveSigningKey({OPENBOOK_REGISTRY_PRIVATE_KEY: oldKey.privateKey}));
    const signedByNew = await signBundledPackage({manifest, files}, resolveSigningKey({OPENBOOK_REGISTRY_PRIVATE_KEY: newKey.privateKey}));

    expect(await verifyPlugin({manifest, files, signature: signedByOld}, pinned)).toEqual({registry: 'OpenBook Registry'});
    expect(await verifyPlugin({manifest, files, signature: signedByNew}, pinned)).toEqual({registry: 'OpenBook Registry (2027)'});
    // A key pinned in NEITHER slot still fails.
    const stranger = await generateRegistryKeys();
    const signedByStranger = await signBundledPackage({manifest, files}, resolveSigningKey({OPENBOOK_REGISTRY_PRIVATE_KEY: stranger.privateKey}));
    expect(await verifyPlugin({manifest, files, signature: signedByStranger}, pinned)).toBeNull();
  });

  it('refuses the test fallback when OPENBOOK_REGISTRY_REQUIRE_KEY=1', () => {
    expect(() => resolveSigningKey({OPENBOOK_REGISTRY_REQUIRE_KEY: '1'})).toThrow(/OPENBOOK_REGISTRY_PRIVATE_KEY/);
  });
});

describe('signBundledPackage', () => {
  it('signs so the package verifies against the key, and tampering fails', async () => {
    const pair = await generateRegistryKeys();
    const key = resolveSigningKey({OPENBOOK_REGISTRY_PRIVATE_KEY: pair.privateKey});
    const signature = await signBundledPackage({manifest, files}, key);
    const trusted = [{name: key.registry, publicKey: key.publicKey}];

    expect(await verifyPlugin({manifest, files, signature}, trusted)).toEqual({registry: key.registry});
    expect(await verifyPlugin({manifest, files: {'src/index.ts': 'evil()'}, signature}, trusted)).toBeNull();
  });
});

describe('bundled.gen.ts (the generated module the app ships)', () => {
  it('every bundled first-party plugin carries a signature that verifies', async () => {
    expect(BUNDLED_PLUGINS.length).toBeGreaterThan(0);
    for (const pkg of BUNDLED_PLUGINS) {
      expect(pkg.signature, `${pkg.manifest.id} must ship signed`).toBeDefined();
      const verdict = await verifyPlugin(pkg, [{name: pkg.signature!.registry, publicKey: pkg.signature!.publicKey}]);
      expect(verdict, `${pkg.manifest.id}'s signature must match its content`).toEqual({registry: pkg.signature!.registry});
    }
  });
});
