//vite.config.js
import { resolve } from "path";
import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";

export default defineConfig ({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "@hyper-hq/hyper-ui",
      fileName: "index",
    },
    rollupOptions: {
      external: ["react"],
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: '@/components', replacement: fileURLToPath(new URL('./src/components', import.meta.url)) },
      { find: '@/layouts', replacement: fileURLToPath(new URL('./src/layouts', import.meta.url)) },
    ],
  },
});
