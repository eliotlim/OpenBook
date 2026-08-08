#!/usr/bin/env node
/**
 * Release backstop (ST-1, mirrors the updater .sig guard): assert that every
 * bundled first-party plugin the build just generated is signed by a PINNED
 * registry key (an OPENBOOK_REGISTRY_KEYS entry in packages/sdk/src/
 * plugins.ts). Run AFTER a build with OPENBOOK_REGISTRY_PRIVATE_KEY set — a
 * pass means fresh installs of this build show the Ledger et al. as
 * Verified; a fail means the secret holds the wrong key (or the pinned list
 * wasn't updated) and the release would silently ship Unverified bundles.
 *
 * Reads the machine-readable sidecar bundlePlugins.ts emits
 * (packages/ui/src/plugins/bundled.signatures.json) rather than parsing the
 * generated TS. Exit 0 = all signatures pinned; exit 1 otherwise.
 */
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const src = readFileSync(resolve(ROOT, 'packages/sdk/src/plugins.ts'), 'utf8');
const block = src.match(/export const OPENBOOK_REGISTRY_KEYS[\s\S]*?\n\];/)?.[0];
if (!block) {
  console.error('::error::could not locate OPENBOOK_REGISTRY_KEYS in packages/sdk/src/plugins.ts — cannot vouch for the trust anchor.');
  process.exit(1);
}
const pinned = new Set([...block.matchAll(/publicKey: '([^']+)'/g)].map((m) => m[1]));
if (pinned.size === 0) {
  console.error('::error::OPENBOOK_REGISTRY_KEYS contains no publicKey entries — nothing to verify against.');
  process.exit(1);
}

const sigs = JSON.parse(readFileSync(resolve(ROOT, 'packages/ui/src/plugins/bundled.signatures.json'), 'utf8'));
if (!Array.isArray(sigs) || sigs.length === 0) {
  console.error('::error::bundled.signatures.json is empty — the build produced no signed bundled plugins.');
  process.exit(1);
}

const unpinned = sigs.filter((s) => !pinned.has(s.publicKey));
if (unpinned.length > 0) {
  console.error(
    `::error::bundled plugin(s) signed by a key that is NOT pinned in OPENBOOK_REGISTRY_KEYS — installs would show Unverified: ${unpinned
      .map((s) => `${s.id} (${s.registry}, ${s.publicKey})`)
      .join('; ')}. Check the OPENBOOK_REGISTRY_PRIVATE_KEY secret against the committed pinned key(s).`,
  );
  process.exit(1);
}
console.log(`All ${sigs.length} bundled plugin signature(s) match a pinned OPENBOOK_REGISTRY_KEYS entry.`);
