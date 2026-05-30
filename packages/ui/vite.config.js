//vite.config.js
import { resolve } from "path";
import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";

const externalModules = [
  'emoji-picker-react',
  'novel',
  'react',
  "react/jsx-runtime",
  'react-dom',
  'react-is',
  '@babel/runtime',
  '@editorjs/editorjs',
  '@headlessui/react',
  '@heroicons/react',
  '@heroicons/react/24/outline',
  '@mantine/core',
  "@radix-ui/react-dialog",
  "@radix-ui/react-icons",
  "@radix-ui/react-label",
  "@radix-ui/react-popover",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tooltip",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-navigation-menu",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "novel",
  "tailwind-merge",
  "tailwindcss-animate",
  "use-immer",
  "use-resize-observer",
];

export default defineConfig ({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "@open-book/ui",
      fileName: "index",
    },
    rollupOptions: {
      external: externalModules,
      output: {
        globals: externalModules.reduce((acc, cur) => {
          acc[cur] = cur;
          return acc;
        }, {}),
      }
    },
  },
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Force a single React instance for tests. packages/ui/node_modules/react
      // exists alongside the workspace-root react; without this alias the
      // test file's `import React from 'react'` resolves to the local copy
      // while react-dom (only at root) imports the root copy — two React
      // instances at runtime breaks Hooks. Aliasing both to root collapses
      // them.
      { find: /^react$/, replacement: fileURLToPath(new URL('../../node_modules/react', import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL('../../node_modules/react-dom/client', import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL('../../node_modules/react-dom', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
  },
});
