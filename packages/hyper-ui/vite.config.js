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
        'clsx',
        'csstype',
        'novel',
        'prop-types',
        'react',
        "react/jsx-runtime",
        'react-dom',
        'react-is',
        '@babel/runtime',
        '@emotion/react',
        '@emotion/styled',
        '@mui/base',
        '@mui/core-downloads-tracker',
        '@mui/icons-material',
        '@mui/joy',
        '@mui/styled-engine',
        '@mui/system',
        '@mui/types',
        '@mui/utils',
      ],
      output: {
        globals: {
          'clsx': 'clsx',
          'csstype': 'csstype',
          'novel': 'novel',
          'prop-types': 'prop-types',
          'react': 'react',
          'react-dom': 'ReactDOM',
          'react-is': 'react-is',
          'react/jsx-runtime': 'react/jsx-runtime',
          '@babel/runtime': '@babel/runtime',
          '@emotion/react': '@emotion/react',
          '@emotion/styled': '@emotion/styled',
          '@mui/base': '@mui/base',
          '@mui/core-downloads-tracker': '@mui/core-downloads-tracker',
          '@mui/icons-material': '@mui/icons-material',
          '@mui/joy': '@mui/joy',
          '@mui/styled-engine': '@mui/styled-engine',
          '@mui/system': '@mui/system',
          '@mui/types': '@mui/types',
          '@mui/utils': '@mui/utils',
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
