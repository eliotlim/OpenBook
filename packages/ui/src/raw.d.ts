// Vite's `?raw` import suffix returns a module's source as a string.
declare module '*?raw' {
  const content: string;
  export default content;
}

// Vite's build-time `import.meta.glob`. Declared narrowly for the one form this
// package uses — eager + `?raw`, i.e. "every matching module's source, as a map
// keyed by path" — rather than pulling in all of `vite/client`, whose own
// wildcard module declarations would collide with the ones in this directory.
interface ImportMeta {
  glob(pattern: string, options: {query: '?raw'; import: 'default'; eager: true}): Record<string, string>;
}
