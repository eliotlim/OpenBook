/**
 * OpenBook server entrypoint for the compiled desktop sidecar (Bun).
 *
 * Identical to `bin.ts` except it embeds PGlite's WASM/data assets into the
 * single executable and passes them to the server, so the binary is fully
 * self-contained. Built with `bun build --compile` (see scripts/build-sidecar.mjs).
 */
import {runCli} from './cli';
import {loadEmbeddedPgliteAssets} from './pglite-assets.bun';

const pgliteAssets = await loadEmbeddedPgliteAssets();

runCli({pgliteAssets}).catch((err) => {
  console.error(err);
  process.exit(1);
});
