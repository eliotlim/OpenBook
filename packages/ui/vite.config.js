//vite.config.js
import { resolve, isAbsolute } from "path";
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
