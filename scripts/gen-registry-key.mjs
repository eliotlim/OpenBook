#!/usr/bin/env node
/**
 * Generate the first-party plugin-registry signing keypair (the key ceremony).
 *
 *   node scripts/gen-registry-key.mjs [--out <key.json>]
 *
 * Prints the PUBLIC key (raw Ed25519, base64) — commit that as
 * `OPENBOOK_REGISTRY.publicKey` in packages/sdk/src/plugins.ts — and emits the
 * PRIVATE key (PKCS#8, base64) either to stdout or, with --out, to a
 * mode-0600 JSON key file (the shape `pack-plugin.mjs --sign --key` accepts).
 *
 * The private half must NEVER be committed: store it as the
 * `OPENBOOK_REGISTRY_PRIVATE_KEY` GitHub Actions secret (environment:
 * `publish`) so release builds sign the bundled first-party plugins with it,
 * then delete any local copy. Full runbook (including rotation with overlap):
 * docs/plugin-signing.md. CI greps the repo for private-key material and
 * fails if any is committed (scripts/check-no-private-keys.sh).
 */
import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outPath = outAt === -1 ? undefined : args[outAt + 1];
if (outAt !== -1 && !outPath) {
  console.error('usage: gen-registry-key.mjs [--out <key.json>]');
  process.exit(1);
}

const {publicKey, privateKey} = generateKeyPairSync('ed25519');
// Raw 32-byte public key = the SPKI DER minus its constant 12-byte prefix —
// the format the app pins and verifyPlugin imports ('raw').
const spki = publicKey.export({format: 'der', type: 'spki'});
const publicBase64 = spki.subarray(spki.length - 32).toString('base64');
// PKCS#8 DER, base64 — the format signPlugin imports ('pkcs8').
const privateBase64 = privateKey.export({format: 'der', type: 'pkcs8'}).toString('base64');

console.log('OpenBook plugin-registry keypair (Ed25519)');
console.log('');
console.log(`  Public key (raw, base64):  ${publicBase64}`);
console.log('');

if (outPath) {
  const keyFile = {
    __WARNING__:
      'PRIVATE registry signing key — do NOT commit. Store the privateKey as the OPENBOOK_REGISTRY_PRIVATE_KEY GitHub Actions secret, then delete this file. See docs/plugin-signing.md.',
    registry: 'OpenBook Registry',
    publicKey: publicBase64,
    privateKey: privateBase64,
  };
  writeFileSync(outPath, `${JSON.stringify(keyFile, null, 2)}\n`, {mode: 0o600});
  console.log(`  Private key written to ${outPath} (mode 0600).`);
} else {
  console.log(`  Private key (PKCS#8, base64):  ${privateBase64}`);
}

console.log(`
Key ceremony (docs/plugin-signing.md):
  1. Commit the PUBLIC key as OPENBOOK_REGISTRY.publicKey in packages/sdk/src/plugins.ts.
  2. Store the PRIVATE key as the OPENBOOK_REGISTRY_PRIVATE_KEY secret
     (GitHub → Settings → Environments → publish) — release builds sign the
     bundled first-party plugins with it.
  3. Delete every local copy of the private key. Never commit it.`);
