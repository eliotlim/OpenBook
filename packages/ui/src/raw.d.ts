// Vite's `?raw` import suffix returns a module's source as a string.
declare module '*?raw' {
  const content: string;
  export default content;
}
