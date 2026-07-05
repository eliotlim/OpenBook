// Bun's `with { type: 'file' }` imports resolve to a path string at runtime.
// These ambient declarations let `tsc` type-check `bin.bun.ts` /
// `pglite-assets.bun.ts` without the asset files being present.
declare module '*.wasm' {
  const path: string;
  export default path;
}
declare module '*.data' {
  const path: string;
  export default path;
}
// The staged viewer runtime bundle (`viewer-asset.bun.ts`) — scoped to the one
// filename so ordinary `.js` imports keep normal resolution.
declare module '*openbook-viewer.js' {
  const path: string;
  export default path;
}
