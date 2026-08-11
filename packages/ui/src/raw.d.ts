// Vite's `?raw` import suffix returns a module's source as a string.
declare module '*?raw' {
  const content: string;
  export default content;
}

/** True only while building the CSP-safe, read-only standalone viewer. */
declare const __OB_SAFE_EXPORT_VIEWER__: boolean;

// Force the QuickJS WASM payload into the inline Worker. This also avoids
// Emscripten trying to open a Vite development URL as a filesystem path in tests.
declare module '*?url&inline' {
  const url: string;
  export default url;
}

// Vite's build-time `import.meta.glob`. Declared narrowly for the one form this
// package uses — eager + `?raw`, i.e. "every matching module's source, as a map
// keyed by path" — rather than pulling in all of `vite/client`, whose own
// wildcard module declarations would collide with the ones in this directory.
interface ImportMeta {
  glob(pattern: string, options: {query: '?raw'; import: 'default'; eager: true}): Record<string, string>;
  readonly env: {readonly MODE: string};
}
