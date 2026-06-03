// Ambient declaration so `tsc` accepts side-effect CSS imports (e.g. the
// `import './index.css'` in index.ts). Vite handles the actual bundling; this
// is purely to satisfy type-checking under `moduleResolution: bundler` + TS 6.
declare module '*.css';
