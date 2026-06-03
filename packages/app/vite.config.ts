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
