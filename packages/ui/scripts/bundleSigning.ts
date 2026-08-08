/**
 * Signing-key resolution for the bundled first-party plugins (build-time,
 * node-only — used by bundlePlugins.ts and its tests, never shipped).
 *
 * Two sources, in order:
 *  1. `OPENBOOK_REGISTRY_PRIVATE_KEY` (base64 PKCS#8 Ed25519) — the production
 *     path. Release CI sets it from the GitHub Actions secret of the same
 *     name; the public half is derived from it and must match the pinned
 *     `OPENBOOK_REGISTRY.publicKey` for installs to show Verified.
 *  2. scripts/test-registry-key.json — the committed TEST-ONLY fallback, so
 *     dev/test builds still exercise the whole signing pipeline. Its private
 *     half is public by definition, so nothing trusts it by default; e2e
 *     trusts it explicitly per-test. It must never be pinned as production
 *     (release CI guards that).
 */
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {signPlugin, type PluginManifest, type PluginSignature} from '@book.dev/sdk';

export interface RegistrySigningKey {
  /** Registry display name embedded in the signature (what "Verified by …" shows). */
  registry: string;
  /** base64 raw Ed25519 public key (derived from the private half for env keys). */
  publicKey: string;
  /** base64 PKCS#8 Ed25519 private key. */
  privateKey: string;
  /** Where the key came from: the CI secret env var, or the committed test key. */
  source: 'env' | 'test';
}

/** The committed TEST-ONLY key (repo-root scripts/test-registry-key.json). */
export const TEST_REGISTRY_KEY_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'test-registry-key.json',
);

/** Raw (32-byte) base64 Ed25519 public key derived from a base64 PKCS#8 private key. */
export function derivePublicKey(privateKeyBase64: string): string {
  const priv = createPrivateKey({key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8'});
  const spki = createPublicKey(priv).export({format: 'der', type: 'spki'});
  return spki.subarray(spki.length - 32).toString('base64'); // SPKI = constant 12-byte DER prefix + raw key
}

/**
 * Resolve the key the bundled plugins get signed with: the
 * OPENBOOK_REGISTRY_PRIVATE_KEY env var when set (production/CI — public half
 * derived, name overridable via OPENBOOK_REGISTRY_NAME), else the committed
 * test key. Throws when OPENBOOK_REGISTRY_REQUIRE_KEY=1 and the env key is
 * absent, so a wired-up release can refuse to fall back silently.
 */
export function resolveSigningKey(
  env: Record<string, string | undefined> = process.env,
  testKeyPath: string = TEST_REGISTRY_KEY_PATH,
): RegistrySigningKey {
  const envKey = env.OPENBOOK_REGISTRY_PRIVATE_KEY?.trim();
  if (envKey) {
    return {
      registry: env.OPENBOOK_REGISTRY_NAME?.trim() || 'OpenBook Registry',
      publicKey: derivePublicKey(envKey),
      privateKey: envKey,
      source: 'env',
    };
  }
  if (env.OPENBOOK_REGISTRY_REQUIRE_KEY === '1') {
    throw new Error(
      'OPENBOOK_REGISTRY_REQUIRE_KEY=1 but OPENBOOK_REGISTRY_PRIVATE_KEY is unset — refusing to fall back to the test-only registry key. Set the secret (docs/plugin-signing.md).',
    );
  }
  const test = JSON.parse(readFileSync(testKeyPath, 'utf8')) as {registry: string; publicKey: string; privateKey: string};
  return {registry: test.registry, publicKey: test.publicKey, privateKey: test.privateKey, source: 'test'};
}

/** Sign a bundled package with the resolved key (Ed25519 — deterministic, so regeneration is byte-stable). */
export async function signBundledPackage(
  pkg: {manifest: PluginManifest; files: Record<string, string>},
  key: RegistrySigningKey,
): Promise<PluginSignature> {
  return signPlugin(pkg, key.privateKey, key.registry, key.publicKey);
}
