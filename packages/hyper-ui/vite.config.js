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
      external: [
        'react',
        "react/jsx-runtime",
        'react-dom',
        '@mui/styled-engine',
      ],
      output: {
        globals: {
          'react': 'react',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'react/jsx-runtime',
          '@mui/styled-engine': '@mui/styled-engine',
        },
      }
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
});
