import {defineConfig} from 'tsup';

// Three entrypoints: `bin` (the CLI/sidecar program), `index` (the programmatic
// Node API), and `browser` (the in-webview embedded data layer — PGlite store +
// LocalDataClient, no Node imports, consumed by the app/web bundlers). Deps stay
// external for the headless `node dist/bin.js` run; the sidecar build
// (`build:sidecar`) bundles everything via Bun instead.
export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'src/index.ts',
    browser: 'src/browser.ts',
  },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The optional native engine stays a runtime import — tsup treats
  // `dependencies` as external automatically but not `optionalDependencies`.
  external: ['node-llama-cpp', /^@node-llama-cpp\//],
  dts: {entry: {index: 'src/index.ts', browser: 'src/browser.ts'}},
});
