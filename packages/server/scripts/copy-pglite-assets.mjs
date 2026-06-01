#!/usr/bin/env node
/**
 * Copy PGlite's WASM/data assets from node_modules into `packages/server/assets/`
 * so `bin.bun.ts` can embed them into the compiled sidecar (`with { type: 'file' }`).
 * Run before `bun build --compile` (see build-sidecar.mjs).
 */
import {copyFileSync, mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'assets');
const require = createRequire(import.meta.url);
// Resolve the package's dist directory via its entry module.
const pgliteDist = dirname(require.resolve('@electric-sql/pglite'));

const ASSETS = ['pglite.wasm', 'initdb.wasm', 'pglite.data'];

mkdirSync(assetsDir, {recursive: true});
for (const file of ASSETS) {
  copyFileSync(join(pgliteDist, file), join(assetsDir, file));
  console.log(`copied ${file}`);
}
console.log(`PGlite assets ready in ${assetsDir}`);
