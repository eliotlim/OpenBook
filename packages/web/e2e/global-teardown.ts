import {execFileSync} from 'node:child_process';
import {readdirSync, rmSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {WORKER_BASE_PORT, WORKER_DATA_DIR_PREFIX} from './fixtures';

/**
 * Playwright global teardown: reap the per-worker data servers and throwaway
 * data dirs that e2e/fixtures.ts spawns.
 *
 * Each worker runs its own OpenBook data server (`:WORKER_BASE_PORT+workerIndex`,
 * data dir `${WORKER_DATA_DIR_PREFIX}<index>`). The fixture kills its own server
 * on teardown, but a worker that dies hard — crash, interrupt, SIGKILL — never
 * runs that teardown, so its `:44xx` listener and `/tmp/openbook-web-e2e-data-w*`
 * dir survive. The next run's pre-flight squatter check then aborts that worker
 * ("something already serves :44xx"), surfacing as "stale workspace" failures.
 *
 * This runs once after the whole run and sweeps those leaks. It is intentionally
 * scoped tight: a process is killed only when its command line carries the
 * suite's unique data-dir marker, so an unrelated `:44xx` listener — and, above
 * all, a dev server on :4319 or any of the user's own data — is never touched.
 * Idempotent: a clean run finds nothing to do.
 */

// `openbook-web-e2e-data-w` — the basename of the data-dir prefix, which appears
// verbatim in every spawned server's argv (`… --data-dir <prefix><index> …`).
// Unique enough to be a safe kill gate.
const MARKER = basename(WORKER_DATA_DIR_PREFIX);

// How far above WORKER_BASE_PORT to sweep. A failed worker is replaced with a
// fresh, ever-increasing workerIndex, so leaked ports can sit well above the
// `workers` count (2 in CI / 4 local). Mirrors the fixtures' own
// `seq 4400 4460` recovery hint; every kill is still marker-gated, so the width
// only widens coverage, never the blast radius.
const PORT_SWEEP = 64;

/** Run a command, returning trimmed stdout; a non-zero exit yields '' (e.g.
 * pgrep/lsof exit 1 when nothing matches — that is the common, healthy case). */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return '';
  }
}

function parsePids(out: string): number[] {
  return out
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/** Full argv of a pid (`ps -o args=`), or '' if it is already gone. */
function cmdlineOf(pid: number): string {
  return run('ps', ['-ww', '-p', String(pid), '-o', 'args=']);
}

export default async function globalTeardown(): Promise<void> {
  const targets = new Set<number>();

  // (a) Every e2e server, regardless of worker index, found by the unique
  //     data-dir marker in its argv (`node --import tsx src/bin.ts --data-dir
  //     <prefix><index> --port 44xx`). This is index-agnostic, so it catches
  //     restarted workers whose index ran past PORT_SWEEP.
  for (const pid of parsePids(run('pgrep', ['-f', MARKER]))) targets.add(pid);

  // (b) Backstop: free the fixtures' port range. lsof accepts a port range in
  //     one call; only kill a listener whose owner carries our marker — never a
  //     dev server (:4319) or an unrelated 44xx process.
  const listeners = run('lsof', [
    '-ti',
    `tcp:${WORKER_BASE_PORT}-${WORKER_BASE_PORT + PORT_SWEEP}`,
    '-sTCP:LISTEN',
  ]);
  for (const pid of parsePids(listeners)) {
    if (cmdlineOf(pid).includes(MARKER)) targets.add(pid);
  }

  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited between discovery and kill — nothing to do
    }
  }

  // Remove the throwaway PGlite data dirs (the prefix's basename, under its
  // parent dir). A live run's own dirs are already gone — its fixtures removed
  // them on teardown — so this only sweeps what a crashed worker stranded.
  const root = dirname(WORKER_DATA_DIR_PREFIX);
  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith(MARKER)) rmSync(join(root, name), {recursive: true, force: true});
    }
  } catch {
    // tmp root unreadable / missing — nothing to clean
  }
}
