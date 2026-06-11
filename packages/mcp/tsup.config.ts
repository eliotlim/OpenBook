import {defineConfig} from 'tsup';

// Two entrypoints: `bin` (the stdio MCP server program) and `index` (the
// programmatic API, for embedding the server elsewhere). Deps stay external —
// this runs under plain Node.
export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: {entry: {index: 'src/index.ts'}},
});
