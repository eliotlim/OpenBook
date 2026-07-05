/**
 * Bun-only: embeds the viewer runtime bundle (`OpenBookViewer` IIFE) into the
 * compiled sidecar binary, for the book mirror's folder-level
 * `_openbook/viewer.js` (see {@link BookMirror}'s `runtimeBundle`).
 *
 * Same mechanism as `pglite-assets.bun.ts`: the `with { type: 'file' }` import
 * tells Bun to bundle the file into the executable; `Bun.file(path)` reads it
 * from the embedded filesystem at runtime. The asset is staged into `../assets/`
 * by `scripts/build-sidecar.mjs` (which builds the ui viewer bundle first when
 * missing) before `bun build --compile`, so the single binary needs nothing on
 * disk.
 *
 * This module is imported ONLY by `bin.bun.ts` (never by the Node build), so
 * Node/tsup never sees the non-JS import semantics.
 */
import viewerBundleFile from '../assets/openbook-viewer.js' with {type: 'file'};

declare const Bun: {file(path: string): {text(): Promise<string>}};

/** The embedded viewer runtime bundle's JS source. */
export async function loadEmbeddedViewerRuntime(): Promise<string> {
  return Bun.file(viewerBundleFile).text();
}
