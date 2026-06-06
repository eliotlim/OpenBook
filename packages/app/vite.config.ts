import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
  },
  // to make use of `TAURI_ENV_DEBUG` and other env variables
  // https://v2.tauri.app/reference/environment-variables/
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // `@open-book/ui` ships an ESM-only build that externalizes every dependency,
  // and it loads the EditorJS tools through dynamic `import()`. Vite's dep scan
  // can't see those imports through the prebuilt package, so without this it
  // discovers them only when the first editor mounts — triggering an on-demand
  // re-optimize that 504s the in-flight modules and leaves the editor blank.
  // Pre-bundle them up front (the `parent > child` form resolves each tool via
  // the @open-book/ui package, where it actually lives).
  optimizeDeps: {
    include: [
      '@open-book/ui > @editorjs/editorjs',
      '@open-book/ui > @editorjs/header',
      '@open-book/ui > @editorjs/list',
      '@open-book/ui > @editorjs/quote',
      '@open-book/ui > @editorjs/delimiter',
      '@open-book/ui > @editorjs/code',
      '@open-book/ui > @editorjs/marker',
      '@open-book/ui > @editorjs/inline-code',
    ],
  },
  build: {
    // Leave `target` at Vite 8's default (`baseline-widely-available`). The
    // v1 template hardcoded `safari13`, which is now both needlessly old for
    // the Tauri v2 webview and broken under Vite 8/Rolldown: esbuild can't
    // lower some bundled deps' (EditorJS) destructuring to that target.
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
