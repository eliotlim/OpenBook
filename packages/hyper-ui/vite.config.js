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
  '@headlessui/react',
  '@heroicons/react',
  '@heroicons/react/24/outline',
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
  "novel",
  "tailwind-merge",
  "tailwindcss-animate",
];

export default defineConfig ({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "@hyper-hq/hyper-ui",
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
    ],
  },
});
