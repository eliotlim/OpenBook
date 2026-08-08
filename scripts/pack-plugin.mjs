#!/usr/bin/env node
/**
 * Pack (and optionally sign) a plugin directory into an installable zip.
 *
 *   node scripts/pack-plugin.mjs <plugin-dir> <out.zip> [--sign] [--key <key.json>]
 *
 * --sign requires an EXPLICIT key — there is no default:
 *   - `--key <path>`: a JSON key file ({registry, privateKey[, publicKey]},
 *     the shape `gen-registry-key.mjs --out` writes), or
 *   - the OPENBOOK_REGISTRY_PRIVATE_KEY env var (base64 PKCS#8 Ed25519, the
 *     same secret the release build signs with; registry name via
 *     OPENBOOK_REGISTRY_NAME, default "OpenBook Registry").
 * The public key is derived from the private half when not given.
 *
 * For a dev-signed zip (verifiable only where the test registry is explicitly
 * trusted — see docs/plugin-signing.md): `--key scripts/test-registry-key.json`.
 */
import {readFileSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {createRequire} from 'node:module';
import {createPrivateKey, createPublicKey} from 'node:crypto';
// fflate lives in the ui package's dependencies — resolve from there.
const {zipSync, strToU8} = createRequire(new URL('../packages/ui/package.json', import.meta.url))('fflate');
// Signing inlined (mirrors packages/sdk/src/plugins.ts — the dist is
// bundler-shaped and not raw-node loadable): Ed25519 over the canonical
// SHA-256 digest of manifest + sorted, length-prefixed files.
const te = new TextEncoder();
function canonicalBytes(manifest, files) {
  const parts = [];
  const push = (s) => {
    const bytes = te.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    parts.push(len, bytes);
  };
  push(JSON.stringify(manifest, Object.keys(manifest).sort()));
  for (const p of Object.keys(files).sort()) {
    push(p);
    push(files[p]);
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
async function signPlugin(pkg, privateKeyBase64, registry, publicKeyBase64) {
  const hash = await crypto.subtle.digest('SHA-256', canonicalBytes(pkg.manifest, pkg.files));
  const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(privateKeyBase64, 'base64'), 'Ed25519', false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, te.encode(digest)));
  return {registry, publicKey: publicKeyBase64, signature: sig.toString('base64'), algorithm: 'ed25519'};
}

/** Raw (32-byte) Ed25519 public key, base64, derived from a base64 PKCS#8 private key. */
function derivePublicKey(privateKeyBase64) {
  const priv = createPrivateKey({key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8'});
  const spki = createPublicKey(priv).export({format: 'der', type: 'spki'});
  return spki.subarray(spki.length - 32).toString('base64'); // SPKI = 12-byte DER prefix + raw key
}

const args = process.argv.slice(2);
const keyAt = args.indexOf('--key');
const keyPath = keyAt === -1 ? undefined : args[keyAt + 1];
if (keyAt !== -1) args.splice(keyAt, 2);
const [dir, out, ...flags] = args;
if (!dir || !out) {
  console.error('usage: pack-plugin.mjs <plugin-dir> <out.zip> [--sign] [--key <key.json>]');
  process.exit(1);
}

const files = {};
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(dir, p).replaceAll('\\', '/')] = readFileSync(p, 'utf8');
  }
};
walk(dir);

const manifest = JSON.parse(files['openbook.json'] ?? 'null');
if (!manifest) {
  console.error('no openbook.json in the plugin directory');
  process.exit(1);
}
const sources = Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'openbook.json' && p !== 'signature.json'));

const entries = {'openbook.json': strToU8(JSON.stringify(manifest, null, 2))};
for (const [p, s] of Object.entries(sources)) entries[p] = strToU8(s);

if (flags.includes('--sign')) {
  // No silent default: signing demands an explicit key so nobody dev-signs a
  // zip by accident and mistakes the test registry for real provenance.
  let key;
  if (keyPath) {
    key = JSON.parse(readFileSync(keyPath, 'utf8'));
    if (!key.privateKey || !key.registry) {
      console.error(`--key ${keyPath}: expected JSON with "registry" and "privateKey" (base64 PKCS#8)`);
      process.exit(1);
    }
  } else if (process.env.OPENBOOK_REGISTRY_PRIVATE_KEY) {
    key = {
      registry: process.env.OPENBOOK_REGISTRY_NAME || 'OpenBook Registry',
      privateKey: process.env.OPENBOOK_REGISTRY_PRIVATE_KEY,
    };
  } else {
    console.error(
      '--sign needs a key: pass --key <key.json> or set OPENBOOK_REGISTRY_PRIVATE_KEY.\n' +
        'For a dev/test signature use --key scripts/test-registry-key.json (trusted nowhere by default — see docs/plugin-signing.md).',
    );
    process.exit(1);
  }
  const publicKey = key.publicKey ?? derivePublicKey(key.privateKey);
  const signature = await signPlugin({manifest, files: sources}, key.privateKey, key.registry, publicKey);
  entries['signature.json'] = strToU8(JSON.stringify(signature, null, 2));
  console.log(`signed by ${key.registry} (public key ${publicKey})`);
}

writeFileSync(out, zipSync(entries));
console.log(`packed ${Object.keys(sources).length} source file(s) -> ${out}`);
