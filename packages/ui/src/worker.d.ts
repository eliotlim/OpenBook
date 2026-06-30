// Vite's `?worker&inline` import suffix bundles a module as a Web Worker and
// **embeds it inline** (a self-contained blob/data-URI baked into the importing
// chunk), returning a zero-arg `Worker` constructor. Inlining matters here: this
// package ships as a prebuilt Vite library that downstream bundlers (Next/
// Turbopack for web, Vite for the Tauri desktop app) consume as-is. A non-inline
// `?worker` emits a *separate* asset referenced by an absolute `/assets/…` path
// the consumer never copies — so it 404s downstream and the worker silently
// never loads. Inlining travels the worker's code *inside* `dist/index.js`, so
// it survives the lib→consumer pipeline with no asset re-resolution.
declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
