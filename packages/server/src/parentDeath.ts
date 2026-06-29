/**
 * Self-terminate when the desktop host that spawned us dies.
 *
 * The Tauri shell plugin spawns the sidecar with a **piped stdin** whose write
 * end the host process holds. On *any* host death — Force Quit, crash, `kill -9`,
 * logout SIGKILL — that write end closes and the sidecar observes **stdin EOF**.
 * This is a portable parent-death signal: macOS has no `PR_SET_PDEATHSIG` and
 * Windows has no POSIX death signal, but both deliver the pipe closure. Without
 * it the sidecar survives a non-graceful host exit, keeps the PGlite/mirror
 * {@link DirLock}, and the next launch hits the single-owner conflict.
 *
 * As a Unix belt-and-suspenders we *also* poll the parent pid: once the host is
 * gone the kernel reparents us (ppid → 1 / a subreaper) and `process.kill(ppid,
 * 0)` reports `ESRCH`. Either observation triggers the same graceful shutdown.
 *
 * Everything here is **gated to sidecar mode** ({@link isSidecarMode}) so the
 * headless CLI (`bin.ts`), `bin.bun.ts` interactive runs, and the test suite are
 * never wired up — only a real desktop-spawned sidecar self-terminates.
 */

/** Inputs that decide whether we were launched as the desktop sidecar. */
export interface SidecarModeProbe {
  /** Process argv (defaults to `process.argv`). */
  argv?: string[];
  /** Env (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** `process.stdin.isTTY` (undefined for a pipe, true for a terminal). */
  stdinIsTTY?: boolean;
}

/**
 * True only when this process was launched as the desktop sidecar: a `--socket`
 * or `--data-dir` flag (or the matching env) is present **and** stdin is not a
 * TTY (the host hands us a pipe, never a terminal). The TTY check is what keeps
 * an interactive `--data-dir` run (e.g. `pnpm dev` in a terminal) from arming the
 * parent-death wiring, so closing the terminal's stdin can't shut the dev server.
 */
export function isSidecarMode(probe: SidecarModeProbe = {}): boolean {
  const argv = probe.argv ?? process.argv;
  const env = probe.env ?? process.env;
  const stdinIsTTY = probe.stdinIsTTY ?? process.stdin.isTTY;
  const hasSocket = argv.includes('--socket') || Boolean(env.OPENBOOK_SOCKET);
  const hasDataDir = argv.includes('--data-dir') || Boolean(env.OPENBOOK_DATA_DIR);
  return (hasSocket || hasDataDir) && !stdinIsTTY;
}

/** A minimal stdin surface — just what the parent-death watch touches. */
export interface StdinLike {
  on(event: 'end' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  resume(): unknown;
}

/** A timer handle that may be `unref`'d so it never keeps the loop alive. */
export interface UnrefTimer {
  unref?: () => void;
}

/** Injectable dependencies for {@link watchParentDeath} (defaulted to real process I/O). */
export interface ParentDeathDeps {
  stdin?: StdinLike;
  /** The parent pid captured at install time (defaults to `process.ppid`). */
  ppid?: number;
  /** Reads the *current* parent pid each tick (defaults to `() => process.ppid`). */
  getPpid?: () => number;
  /** Liveness probe: `process.kill(pid, 0)` → true if alive, false on `ESRCH`. */
  isAlive?: (pid: number) => boolean;
  /** Poll cadence for the ppid watch, ms. */
  pollMs?: number;
  /** Injectable timer (defaults to global `setInterval`/`clearInterval`). */
  setIntervalImpl?: (cb: () => void, ms: number) => UnrefTimer;
  clearIntervalImpl?: (handle: UnrefTimer) => void;
  /** Platform (defaults to `process.platform`); the ppid watch is Unix-only. */
  platform?: NodeJS.Platform;
}

/** Default liveness probe via `process.kill(pid, 0)` (signal 0 only probes). */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone. EPERM → exists but not ours (still alive). Anything else: assume alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const DEFAULT_PPID_POLL_MS = 2000;

/**
 * Wire the parent-death watches and invoke `onParentDeath` when the host dies.
 * `onParentDeath` MUST be idempotent — stdin EOF, stdin close, and the ppid poll
 * can all fire (and race) for the same death. Returns a `stop()` that detaches
 * the ppid timer (used by tests; the process is normally exiting anyway).
 */
export function watchParentDeath(onParentDeath: () => void, deps: ParentDeathDeps = {}): () => void {
  const stdin = deps.stdin ?? (process.stdin as unknown as StdinLike);
  const platform = deps.platform ?? process.platform;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const startPpid = deps.ppid ?? process.ppid;
  const getPpid = deps.getPpid ?? (() => process.ppid);
  const pollMs = deps.pollMs ?? DEFAULT_PPID_POLL_MS;
  const setIntervalImpl =
    deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms) as unknown as UnrefTimer);
  const clearIntervalImpl =
    deps.clearIntervalImpl ?? ((h) => clearInterval(h as unknown as ReturnType<typeof setInterval>));

  // Primary (cross-platform): the host holds our piped stdin's write end, so its
  // closure on host death surfaces as EOF. resume() starts the flow so 'end'
  // fires; 'close' is the backstop. An stdin error must not crash us.
  stdin.on('end', onParentDeath);
  stdin.on('close', onParentDeath);
  stdin.on('error', () => {});
  stdin.resume();

  // Belt-and-suspenders (Unix): once the host dies the kernel reparents us, so a
  // changed ppid — or the original ppid going ESRCH — means the host is gone.
  let timer: UnrefTimer | undefined;
  if (platform !== 'win32') {
    timer = setIntervalImpl(() => {
      const current = getPpid();
      // ppid === 1 (reparented to init/launchd) or a changed/dead parent → host gone.
      if (current === 1 || current !== startPpid || !isAlive(startPpid)) {
        onParentDeath();
      }
    }, pollMs);
    timer.unref?.();
  }

  return () => {
    if (timer) clearIntervalImpl(timer);
  };
}

/**
 * Gate + wire: when (and only when) we're a desktop sidecar, watch for host
 * death and call `onParentDeath` (the server's graceful shutdown). A no-op
 * outside sidecar mode — returns `undefined`. This is the single entry point
 * `cli.ts` calls.
 */
export function installSidecarParentDeath(
  onParentDeath: () => void,
  deps: ParentDeathDeps & SidecarModeProbe = {},
): (() => void) | undefined {
  if (!isSidecarMode(deps)) return undefined;
  return watchParentDeath(onParentDeath, deps);
}
