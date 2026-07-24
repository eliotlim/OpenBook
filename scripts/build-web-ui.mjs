#!/usr/bin/env node
/**
 * STAB-7 (LAN-hosted web UI): build the client-only static export of the web app
 * and stage it where the Tauri desktop bundle consumes it as a resource.
 *
 *   pnpm run build:web-ui
 *
 * Two steps, mirroring `build:sidecar` (self-sufficient so it works standalone
 * and inside Tauri's `beforeBuildCommand`):
 *
 *   1. `next build` with NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1 → a static `out/`
 *      (see packages/web/next.config.js: `output: 'export'`). The exported app
 *      talks to the sidecar's SAME-ORIGIN /api, so no Next server is needed.
 *   2. Copy `packages/web/out` → `packages/app/src-tauri/resources/web-ui`, the
 *      stable path wired into `bundle.resources`. main.rs resolves it from the
 *      Tauri resource dir and hands it to the sidecar as OPENBOOK_UI_DIR, but
 *      ONLY while the LAN publish toggle is on.
 *
 * The staged dir is gitignored (a build product, like the sidecar binary).
 *
 * DEV MODE: skip staging entirely and point the sidecar straight at the export
 * with `OPENBOOK_UI_DIR=packages/web/out` in its env (server.ts reads it as a
 * fallback for AppOptions.uiDir).
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const webDir = join(repoRoot, 'packages', 'web');
const outDir = join(webDir, 'out');
const stageDir = join(repoRoot, 'packages', 'app', 'src-tauri', 'resources', 'web-ui');

// The export imports @book.dev/ui + @book.dev/sdk from their dists, and
// @book.dev/server/browser from the server's tsup dist (which build:sidecar
// does NOT produce). `build:libs` builds them before this in the full flow, but
// a standalone invocation may run first — build them on demand so this script
// is self-sufficient (matching build-sidecar.mjs's on-demand mcp/viewer builds).
for (const [pkg, dist] of [
  ['@book.dev/sdk', join(repoRoot, 'packages', 'sdk', 'dist', 'index.js')],
  ['@book.dev/ui', join(repoRoot, 'packages', 'ui', 'dist', 'index.js')],
  ['@book.dev/server', join(repoRoot, 'packages', 'server', 'dist', 'browser.js')],
]) {
  if (!existsSync(dist)) {
    console.log(`${pkg} dist missing — building it (pnpm --filter ${pkg} run build)…`);
    execFileSync('pnpm', ['--filter', pkg, 'run', 'build'], {stdio: 'inherit', cwd: repoRoot});
  }
}

// 1. Static export. The SAMEORIGIN flag flips next.config.js to output:'export'.
console.log('Building the client-only static web export (NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1)…');
execFileSync('pnpm', ['--filter', '@book.dev/web', 'run', 'build'], {
  stdio: 'inherit',
  cwd: repoRoot,
  env: {...process.env, NEXT_PUBLIC_OPENBOOK_SAMEORIGIN: '1'},
});

if (!existsSync(join(outDir, 'index.html'))) {
  console.error(`Expected the static export at ${outDir} (index.html missing).`);
  console.error('Is next.config.js honouring NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1 (output: "export")?');
  process.exit(1);
}

// 2. Stage into the Tauri resource dir (replace wholesale so a stale bundle can't
// linger). cpSync recurses; the dest is gitignored.
console.log(`Staging ${outDir} -> ${stageDir}`);
rmSync(stageDir, {recursive: true, force: true});
mkdirSync(dirname(stageDir), {recursive: true});
cpSync(outDir, stageDir, {recursive: true});
console.log('Done.');
