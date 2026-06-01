#!/usr/bin/env node
/**
 * Compile the OpenBook server into a single self-contained executable and place
 * it where Tauri expects sidecars: `packages/app/src-tauri/binaries/` with a
 * `-<target-triple>` suffix.
 *
 * Uses Bun's `--compile` (https://bun.sh) to bundle the server + its
 * dependencies into one binary. Install Bun first, then:
 *
 *   pnpm --filter @open-book/server build:sidecar          # host triple
 *   pnpm --filter @open-book/server build:sidecar x86_64-pc-windows-msvc
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

mkdirSync(binariesDir, {recursive: true});
console.log(`Compiling OpenBook server sidecar → ${outfile}`);
execFileSync('bun', ['build', join(serverDir, 'src', 'bin.ts'), '--compile', '--outfile', outfile], {
  stdio: 'inherit',
});
console.log('Done.');
