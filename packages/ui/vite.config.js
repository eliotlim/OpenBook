//vite.config.js
import { resolve, isAbsolute } from "path";
import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";

// In watch mode (`pnpm dev` → `vite build --watch`) Vite would empty `dist/`
// at startup before the first rebuild, briefly removing `dist/index.js`. The
// app and web dev servers resolve `@open-book/ui` to that file, so a dep scan
// landing in that window fails with "could not be resolved". Keep the existing
// build in place while watching (overwrite in place); still clean for one-shot
// production builds.
const isWatch = process.argv.includes("--watch");

export default defineConfig ({
  build: {
    emptyOutDir: !isWatch,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "@open-book/ui",
      fileName: "index",
      // ESM only. Every consumer (web/Next, app/Vite, desktop) imports the ESM
      // build; the old UMD output was unused and, under Vite 8 (Rolldown),
      // forced a `require()`-based interop shim for externals that Next 16's
      // Turbopack rejects ("dynamic usage of require is not supported").
      formats: ["es"],
      // Vite 6+ names the lib's CSS bundle after the entry (index.css) instead
      // of the old `style.css`. Pin it so `@open-book/ui/style.css` keeps
      // resolving (see the "./style.css" export in package.json).
      cssFileName: "style",
    },
    rollupOptions: {
      // Externalize every bare (node_modules) import; bundle only ui's own
      // source (relative + the resolved `@/` alias). A library shouldn't inline
      // its deps, and bundling a CJS dep that `require()`s external react is
      // exactly what produced the Turbopack-incompatible require shim.
      external: (id) => !id.startsWith(".") && !id.startsWith("@/") && !isAbsolute(id),
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
