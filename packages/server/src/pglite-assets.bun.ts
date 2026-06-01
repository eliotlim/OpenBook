/**
 * Bun-only: embeds PGlite's WASM/data into the compiled sidecar binary.
 *
 * The `with { type: 'file' }` imports tell Bun to bundle these files into the
 * executable; `Bun.file(path)` then reads them from the embedded filesystem at
 * runtime, so the single binary needs nothing on disk. The asset files are
 * copied into `../assets/` by `scripts/copy-pglite-assets.mjs` before
 * `bun build --compile`.
 *
 * This module is imported ONLY by `bin.bun.ts` (never by the Node build), so
 * Node/tsup never sees these non-JS imports.
 */
import type {PGliteOptions} from '@electric-sql/pglite';
import pgliteWasmFile from '../assets/pglite.wasm' with {type: 'file'};
import initdbWasmFile from '../assets/initdb.wasm' with {type: 'file'};
import fsDataFile from '../assets/pglite.data' with {type: 'file'};

declare const Bun: {file(path: string): {arrayBuffer(): Promise<ArrayBuffer>}};

export async function loadEmbeddedPgliteAssets(): Promise<Partial<PGliteOptions>> {
  const [wasm, initdb, data] = await Promise.all([
    Bun.file(pgliteWasmFile).arrayBuffer(),
    Bun.file(initdbWasmFile).arrayBuffer(),
    Bun.file(fsDataFile).arrayBuffer(),
  ]);
  return {
    pgliteWasmModule: await WebAssembly.compile(wasm),
    initdbWasmModule: await WebAssembly.compile(initdb),
    fsBundle: new Blob([data]),
  };
}
