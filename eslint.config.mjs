// Flat config (ESLint 9). Replaces the legacy .eslintrc.js. One root config
// lints every workspace package; `eslint .` from any package picks it up.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import e2eIsolation from './eslint-rules/e2e-workspace-isolation.mjs';
import noArbitrarySpacing from './eslint-rules/no-arbitrary-spacing.mjs';
import noHoverGeometry from './eslint-rules/no-hover-geometry.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      // Next static export (STAB-7 `build:web-ui` → the LAN web UI bundle). Built
      // JS/manifests, gitignored — never lint them (mirrors the `.next` ignore).
      '**/out/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      // Playwright / Chromatic run artifacts (generated; includes built JS).
      '**/test-results/**',
      '**/playwright-report/**',
      '**/blob-report/**',
      // Rust host + generated Tauri capability schemas.
      'packages/app/src-tauri/**',
      // shadcn/ui primitives, kept verbatim from upstream.
      'packages/ui/src/components/ui/**',
      // Vendored UMD bundles (d3 / Observable Plot) inlined into the HTML export.
      'packages/ui/src/export/vendor/**',
      // Generated mirror of the ledger plugin's PURE report folds (LX-3) —
      // byte-copies of examples/plugins/ledger/src with one import rewritten
      // (see ui scripts/bundlePlugins.ts). Fix the plugin source, regenerate.
      'packages/ui/src/export/ledgerFolds.gen/**',
      // Generated sidecar assets: `build:sidecar` copies the vendored viewer
      // bundle + PGlite wasm/data here for the bun-compiled binary. All
      // generated/vendored (the dir is gitignored); never lint them.
      'packages/server/assets/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Host-realm dynamic code execution is forbidden by default. Narrow
    // non-document exceptions must be annotated at the call site; reactive
    // document evaluation lives in the QuickJS Worker sandbox.
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Hover may repaint an element, but it must not alter geometry and shift
    // adjacent content. UI primitives remain covered by the upstream ignore.
    plugins: {'layout-shift': noHoverGeometry},
    rules: {'layout-shift/no-hover-geometry': 'error'},
  },
  {
    // Product spacing follows Tailwind's shared scale; bracket-arbitrary values
    // for padding, margin, and gaps would silently introduce one-off geometry.
    plugins: {tailwind: noArbitrarySpacing},
    rules: {'tailwind/no-arbitrary-spacing': 'error'},
  },
  {
    // Plain Node scripts (build helpers, etc.).
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {globals: {...globals.node}},
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {react},
    languageOptions: {
      globals: {...globals.browser, ...globals.node},
      parserOptions: {ecmaFeatures: {jsx: true}},
    },
    settings: {react: {version: '19.0'}},
    rules: {
      ...react.configs.flat.recommended.rules,
      // We use TypeScript + the new JSX transform.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Preserved from the v8 .eslintrc (core stylistic rules; deprecated in
      // ESLint 9 but still functional — they move to @stylistic in ESLint 10).
      'indent': ['error', 2],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
    },
  },
  {
    // Next.js rules for the web shell only (replaces `next lint`).
    files: ['packages/web/**/*.{ts,tsx}'],
    plugins: {'@next/next': nextPlugin},
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // Pages live at packages/web/src/pages, not a root ./pages dir.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    // Structural workspace isolation for the Playwright e2e suite (OB-223):
    // forbid the manual name-collision workarounds and require specs that seed
    // hardcoded page/row names to opt into the per-test `freshWorkspace` reset.
    files: ['packages/web/e2e/**/*.spec.ts'],
    plugins: {e2e: e2eIsolation},
    rules: {'e2e/workspace-isolation': 'error'},
  },
);
