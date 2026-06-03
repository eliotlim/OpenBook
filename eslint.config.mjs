// Flat config (ESLint 9). Replaces the legacy .eslintrc.js. One root config
// lints every workspace package; `eslint .` from any package picks it up.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      // Rust host + generated Tauri capability schemas.
      'packages/app/src-tauri/**',
      // shadcn/ui primitives, kept verbatim from upstream.
      'packages/ui/src/components/ui/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
);
