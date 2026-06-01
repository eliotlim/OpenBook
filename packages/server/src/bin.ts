#!/usr/bin/env node
/**
 * OpenBook server entrypoint for Node (headless deployment and `pnpm dev`).
 * Under Node, embedded PGlite loads its own WASM/data from node_modules, so no
 * asset overrides are needed. The compiled desktop sidecar uses `bin.bun.ts`.
 */
import {runCli} from './cli';

runCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
