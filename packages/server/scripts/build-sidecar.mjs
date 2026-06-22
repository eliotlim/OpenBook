#!/usr/bin/env node
/**
 * Compile the OpenBook server into a single self-contained executable for the
 * Tauri desktop sidecar: `packages/app/src-tauri/binaries/openbook-server-<triple>`.
 *
 * Uses Bun's `--compile` to bundle the server, PGlite, and PGlite's embedded
 * WASM/data assets (copied first by copy-pglite-assets.mjs) into one binary that
 * needs nothing on disk. Install Bun (https://bun.sh), then:
 *
 *   pnpm --filter @book.dev/server build:sidecar          # host triple
 *   pnpm --filter @book.dev/server build:sidecar x86_64-pc-windows-msvc
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, '..');
const binariesDir = join(serverDir, '..', 'app', 'src-tauri', 'binaries');

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  switch (process.platform) {
    case 'darwin':
      return `${arch}-apple-darwin`;
    case 'linux':
      return `${arch}-unknown-linux-gnu`;
    case 'win32':
      return `${arch}-pc-windows-msvc`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

const triple = process.argv[2] || hostTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const outfile = join(binariesDir, `openbook-server-${triple}${ext}`);

// 1. Stage PGlite's WASM/data so Bun can embed them.
execFileSync('node', [join(here, 'copy-pglite-assets.mjs')], {stdio: 'inherit'});

// 2. Compile the Bun entrypoint into a single binary. The optional llama.cpp
// engine stays external (mirroring tsup.config.ts): its per-platform binding
// packages aren't installed, and the runtime import is try/caught — in the
// sidecar the llama provider simply reports unavailable and the user is
// pointed at the MLX/OpenAI-compatible providers.
mkdirSync(binariesDir, {recursive: true});
console.log(`Compiling OpenBook server sidecar -> ${outfile}`);
try {
  execFileSync(
    'bun',
    [
      'build',
      join(serverDir, 'src', 'bin.bun.ts'),
      '--compile',
      '--external',
      'node-llama-cpp',
      '--external',
      '@node-llama-cpp/*',
      '--outfile',
      outfile,
    ],
    {stdio: 'inherit'},
  );
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.error('\nThe sidecar compiles with Bun, which is not on PATH.');
    console.error('Install it from https://bun.sh (CI: oven-sh/setup-bun).');
    process.exit(1);
  }
  throw err;
}
console.log('Done.');
