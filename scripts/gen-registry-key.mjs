#!/usr/bin/env node
/**
 * Generate the first-party plugin-registry signing keypair (the key ceremony).
 *
 *   node scripts/gen-registry-key.mjs --out <key.json>
 *
 * Prints the PUBLIC key (raw Ed25519, base64) — commit that as an
 * `OPENBOOK_REGISTRY_KEYS` entry in packages/sdk/src/plugins.ts — and writes
 * the PRIVATE key (PKCS#8, base64) to a mode-0600 JSON key file (the shape
 * `pack-plugin.mjs --sign --key` accepts). --out is REQUIRED and never
 * overwrites an existing file: the private half goes to exactly one fresh
 * file you then store as a secret and destroy — never to stdout (shell
 * history / scrollback / CI logs), never over something else.
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
if (!outPath) {
  console.error('usage: gen-registry-key.mjs --out <key.json>   (required: the private key is only ever written to a fresh file, never stdout)');
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

const keyFile = {
  __WARNING__:
    'PRIVATE registry signing key — do NOT commit. Store the privateKey as the OPENBOOK_REGISTRY_PRIVATE_KEY GitHub Actions secret, then delete this file. See docs/plugin-signing.md.',
  registry: 'OpenBook Registry',
  publicKey: publicBase64,
  privateKey: privateBase64,
};
try {
  // flag 'wx': create-only. Refusing to overwrite means the private key can
  // never land in a pre-existing file whose (looser) mode survives — and a
  // fumbled path can't clobber anything.
  writeFileSync(outPath, `${JSON.stringify(keyFile, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
} catch (err) {
  if (err && err.code === 'EEXIST') {
    console.error(`refusing to overwrite ${outPath} — pick a fresh path (existing files keep their existing permissions).`);
    process.exit(1);
  }
  throw err;
}
console.log(`  Private key written to ${outPath} (mode 0600, create-only).`);

console.log(`
Key ceremony (docs/plugin-signing.md):
  1. Commit the PUBLIC key as an OPENBOOK_REGISTRY_KEYS entry in packages/sdk/src/plugins.ts.
  2. Store the PRIVATE key as the OPENBOOK_REGISTRY_PRIVATE_KEY secret
     (GitHub → Settings → Environments → publish) — release builds sign the
     bundled first-party plugins with it.
  3. Delete every local copy of the private key. Never commit it.`);
