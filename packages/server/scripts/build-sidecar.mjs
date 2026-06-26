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
 *   pnpm --filter @book.dev/server build:sidecar x86_64-apple-darwin
 *
 * The target triple may also be supplied via the SIDECAR_TARGET env var (used by
 * the release workflow's matrix). When the requested triple differs from the
 * host, Bun cross-compiles via `--target` — that's how the per-arch macOS
 * release builds the Intel sidecar on an Apple Silicon runner.
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

const triple = process.argv[2] || process.env.SIDECAR_TARGET || hostTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const outfile = join(binariesDir, `openbook-server-${triple}${ext}`);

// Map a Rust/Tauri target triple to Bun's `--target` name. We only pass
// `--target` when cross-compiling (the requested triple differs from the host),
// e.g. the per-arch macOS release building the Intel sidecar on an Apple Silicon
// runner. For a host-matching triple we let Bun build natively — byte-identical
// to the previous behaviour for the Linux / Windows / arm64-macOS legs.
const BUN_TARGET = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-pc-windows-msvc': 'bun-windows-arm64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
};
const crossCompiling = triple !== hostTriple();

// 1. Stage PGlite's WASM/data so Bun can embed them.
execFileSync('node', [join(here, 'copy-pglite-assets.mjs')], {stdio: 'inherit'});

// 2. Compile the Bun entrypoint into a single binary. The optional llama.cpp
// engine stays external (mirroring tsup.config.ts): its per-platform binding
// packages aren't installed, and the runtime import is try/caught — in the
// sidecar the llama provider simply reports unavailable and the user is
// pointed at the MLX/OpenAI-compatible providers.
mkdirSync(binariesDir, {recursive: true});
console.log(
  `Compiling OpenBook server sidecar -> ${outfile}` +
    (crossCompiling ? ` (cross-compiling for ${triple})` : ''),
);
const bunArgs = [
  'build',
  join(serverDir, 'src', 'bin.bun.ts'),
  '--compile',
  '--external',
  'node-llama-cpp',
  '--external',
  '@node-llama-cpp/*',
];
if (crossCompiling) {
  const bunTarget = BUN_TARGET[triple];
  if (!bunTarget) {
    throw new Error(
      `No Bun --target mapping for "${triple}". Add it to BUN_TARGET in build-sidecar.mjs.`,
    );
  }
  bunArgs.push('--target', bunTarget);
}
bunArgs.push('--outfile', outfile);
try {
  execFileSync('bun', bunArgs, {stdio: 'inherit'});
} catch (err) {
  if (err?.code === 'ENOENT') {
    console.error('\nThe sidecar compiles with Bun, which is not on PATH.');
    console.error('Install it from https://bun.sh (CI: oven-sh/setup-bun).');
    process.exit(1);
  }
  throw err;
}
console.log('Done.');
