// vite.viewer.config.js — the dedicated build for the standalone viewer bundle
// (`pnpm build:viewer`, part of `pnpm build`). Unlike the main lib build
// (vite.config.js), which EXTERNALIZES every dependency, this one inlines the
// whole world — React, react-dom, Yjs, the block renderer, radix pieces — into
// a single IIFE exposing the `OpenBookViewer` global, and injects the compiled
// stylesheet from JS at load time. The result is fully self-contained: a bare
// HTML file can <script src> it from file:// with zero network requests.
//
// Output lands in src/export/vendor/ (gitignored, regenerated every build) so
// the HTML export pipeline can inline it with a `?raw` import, exactly like
// the vendored d3/plot UMDs beside it. It builds BEFORE the main lib build in
// the package's `build` script, so a future `?raw` consumer inside src always
// sees a fresh bundle.
import { resolve } from "path";
import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";

/** Fold the emitted CSS asset into the entry chunk as a JS-injected <style>
 *  tag — the single-file requirement. Hand-rolled (15 lines) rather than a new
 *  plugin dependency. */
const inlineCssPlugin = () => ({
  name: "openbook-viewer-inline-css",
  apply: "build",
  enforce: "post",
  generateBundle(_options, bundle) {
    const cssNames = Object.keys(bundle).filter((n) => n.endsWith(".css"));
    const css = cssNames.map((n) => String(bundle[n].source)).join("\n");
    for (const name of cssNames) delete bundle[name];
    const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
    if (!entry || !css) return;
    // Guarded against double load: the style injects once, and a second copy of
    // the script keeps the FIRST OpenBookViewer instance (the `var` declaration
    // hoists out of the `else` block, so the global binding still exists; only
    // the assignment is skipped) rather than silently redefining the global.
    const inject =
      "(function(){try{if(document.querySelector('style[data-openbook-viewer]'))return;" +
      "var d=document,s=d.createElement('style');" +
      "s.setAttribute('data-openbook-viewer','');" +
      `s.textContent=${JSON.stringify(css)};` +
      "(d.head||d.documentElement).appendChild(s);}catch(e){}})();\n";
    entry.code =
      inject +
      'if (window.OpenBookViewer) { console.warn("OpenBookViewer: already loaded; keeping the first instance."); } else {\n' +
      entry.code +
      "\n}";
  },
});

export default defineConfig({
  plugins: [inlineCssPlugin()],
  define: {
    // Inlined React et al. read NODE_ENV; the IIFE must carry a production
    // value itself (lib builds don't substitute it by default).
    "process.env.NODE_ENV": JSON.stringify("production"),
    __OB_SAFE_EXPORT_VIEWER__: 'true',
  },
  build: {
    outDir: "src/export/vendor",
    // The vendor dir also holds committed UMDs (d3, plot) — never wipe it.
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, "src/viewer/index.tsx"),
      name: "OpenBookViewer",
      formats: ["iife"],
      fileName: () => "openbook-viewer.js",
    },
    // NO rollupOptions.external: inlining everything is the whole point.
  },
  resolve: {
    alias: [
      // The read-only viewer has no DataProvider and cannot install plugins.
      // Exclude the app's source compiler (Sucrase + Function constructor).
      { find: "@/plugins", replacement: fileURLToPath(new URL("./src/viewer/pluginStubs.ts", import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom"],
  },
});
