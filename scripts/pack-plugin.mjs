#!/usr/bin/env node
/**
 * Pack (and optionally sign) a plugin directory into an installable zip.
 *
 *   node scripts/pack-plugin.mjs examples/plugins/hello-openbook out.zip [--sign]
 *
 * --sign uses the DEV registry key (scripts/dev-registry-key.json), whose
 * public half is pinned in the app — installs from this zip show "Verified".
 */
import {readFileSync, writeFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {createRequire} from 'node:module';
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

const [dir, out, ...flags] = process.argv.slice(2);
if (!dir || !out) {
  console.error('usage: pack-plugin.mjs <plugin-dir> <out.zip> [--sign]');
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
  const key = JSON.parse(readFileSync(new URL('./dev-registry-key.json', import.meta.url), 'utf8'));
  const signature = await signPlugin({manifest, files: sources}, key.privateKey, key.registry, key.publicKey);
  entries['signature.json'] = strToU8(JSON.stringify(signature, null, 2));
  console.log(`signed by ${key.registry}`);
}

writeFileSync(out, zipSync(entries));
console.log(`packed ${Object.keys(sources).length} source file(s) -> ${out}`);
