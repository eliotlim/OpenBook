import {describe, expect, it, vi} from 'vitest';
import {
  installSidecarParentDeath,
  isSidecarMode,
  watchParentDeath,
  type StdinLike,
  type UnrefTimer,
} from './parentDeath';

/** A minimal stdin double that records resume() and lets a test emit events. */
function fakeStdin(): StdinLike & {emit: (event: string) => void; resumed: boolean} {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    resumed: false,
    on(event, listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return this;
    },
    resume() {
      this.resumed = true;
      return this;
    },
    emit(event) {
      for (const l of listeners.get(event) ?? []) l();
    },
  };
}

/** A setInterval double that captures the callback so a test can tick it by hand. */
function fakeTimer(): {
  setIntervalImpl: (cb: () => void, ms: number) => UnrefTimer;
  tick: () => void;
  cleared: boolean;
  unrefed: boolean;
} {
  const state = {cb: (): void => {}, cleared: false, unrefed: false};
  return {
    setIntervalImpl(cb) {
      state.cb = cb;
      return {
        unref: () => {
          state.unrefed = true;
        },
      };
    },
    tick: () => state.cb(),
    get cleared() {
      return state.cleared;
    },
    get unrefed() {
      return state.unrefed;
    },
  };
}

describe('isSidecarMode (layer A gate — armed ONLY by the explicit host env)', () => {
  it('is true only with OPENBOOK_SIDECAR=1 (the host-set signal)', () => {
    expect(isSidecarMode({env: {OPENBOOK_SIDECAR: '1'}})).toBe(true);
  });

  it('is FALSE for the web e2e spawn shape (--data-dir, non-TTY /dev/null stdin, NO env)', () => {
    // The CRITICAL regression: packages/web/e2e/fixtures.ts spawns
    // `bin.ts --data-dir <dir> --port <n>` with stdio:'ignore' (stdin=/dev/null,
    // isTTY=undefined). Inference armed the watch → stdin.resume() on /dev/null
    // emits 'end' → the server self-terminated. The env gate makes it impossible.
    expect(isSidecarMode({env: {OPENBOOK_DATA_DIR: '/x', OPENBOOK_PORT: '4400'}})).toBe(false);
    expect(isSidecarMode({env: {}})).toBe(false);
  });

  it('is FALSE for any value other than the exact "1"', () => {
    expect(isSidecarMode({env: {OPENBOOK_SIDECAR: ''}})).toBe(false);
    expect(isSidecarMode({env: {OPENBOOK_SIDECAR: '0'}})).toBe(false);
    expect(isSidecarMode({env: {OPENBOOK_SIDECAR: 'true'}})).toBe(false);
  });

  it('does NOT arm on --socket/--data-dir without the env (headless/docker/systemd)', () => {
    expect(isSidecarMode({env: {OPENBOOK_SOCKET: '/x.sock'}})).toBe(false);
  });
});

describe('watchParentDeath', () => {
  const baseDeps = {ppid: 100, getPpid: () => 100, isAlive: () => true};

  it('shuts down on stdin EOF (the host closed our piped stdin)', () => {
    const onDeath = vi.fn();
    const stdin = fakeStdin();
    watchParentDeath(onDeath, {...baseDeps, stdin, setIntervalImpl: fakeTimer().setIntervalImpl});
    expect(stdin.resumed).toBe(true); // resume() so 'end' actually fires
    stdin.emit('end');
    expect(onDeath).toHaveBeenCalledTimes(1);
  });

  it('shuts down on stdin close', () => {
    const onDeath = vi.fn();
    const stdin = fakeStdin();
    watchParentDeath(onDeath, {...baseDeps, stdin, setIntervalImpl: fakeTimer().setIntervalImpl});
    stdin.emit('close');
    expect(onDeath).toHaveBeenCalledTimes(1);
  });

  it('does NOT shut down on a transient stdin error', () => {
    const onDeath = vi.fn();
    const stdin = fakeStdin();
    watchParentDeath(onDeath, {...baseDeps, stdin, setIntervalImpl: fakeTimer().setIntervalImpl});
    stdin.emit('error');
    expect(onDeath).not.toHaveBeenCalled();
  });

  it('shuts down when the parent pid goes away (ESRCH)', () => {
    const onDeath = vi.fn();
    const timer = fakeTimer();
    watchParentDeath(onDeath, {
      stdin: fakeStdin(),
      ppid: 100,
      getPpid: () => 100,
      isAlive: () => false, // parent dead
      setIntervalImpl: timer.setIntervalImpl,
    });
    expect(onDeath).not.toHaveBeenCalled(); // nothing fires until the poll ticks
    timer.tick();
    expect(onDeath).toHaveBeenCalledTimes(1);
    expect(timer.unrefed).toBe(true); // never keeps the loop alive
  });

  it('shuts down when reparented (ppid changed, e.g. → 1)', () => {
    const onDeath = vi.fn();
    const timer = fakeTimer();
    watchParentDeath(onDeath, {
      stdin: fakeStdin(),
      ppid: 100,
      getPpid: () => 1, // reparented to init/launchd → host gone
      isAlive: () => true,
      setIntervalImpl: timer.setIntervalImpl,
    });
    timer.tick();
    expect(onDeath).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the parent is still alive and unchanged', () => {
    const onDeath = vi.fn();
    const timer = fakeTimer();
    watchParentDeath(onDeath, {stdin: fakeStdin(), ...baseDeps, setIntervalImpl: timer.setIntervalImpl});
    timer.tick();
    timer.tick();
    expect(onDeath).not.toHaveBeenCalled();
  });

  it('skips the ppid poll on win32 (stdin EOF still wired)', () => {
    const onDeath = vi.fn();
    const setIntervalImpl = vi.fn();
    const stdin = fakeStdin();
    watchParentDeath(onDeath, {...baseDeps, stdin, platform: 'win32', setIntervalImpl});
    expect(setIntervalImpl).not.toHaveBeenCalled();
    stdin.emit('end');
    expect(onDeath).toHaveBeenCalledTimes(1);
  });

  it('runs an idempotent shutdown ONCE even when stdin EOF and the ppid poll both fire', () => {
    // Mirrors cli.ts's `shuttingDown` guard: many death signals, one shutdown.
    let runs = 0;
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      runs += 1;
    };
    const timer = fakeTimer();
    const stdin = fakeStdin();
    watchParentDeath(shutdown, {stdin, ppid: 100, getPpid: () => 1, isAlive: () => false, setIntervalImpl: timer.setIntervalImpl});
    stdin.emit('end');
    stdin.emit('close');
    timer.tick();
    expect(runs).toBe(1);
  });
});

describe('installSidecarParentDeath (gate + wire)', () => {
  it('is a no-op for the e2e spawn shape (--data-dir, no env) and never touches stdin', () => {
    const onDeath = vi.fn();
    const stdin = fakeStdin();
    const setIntervalImpl = vi.fn();
    const stop = installSidecarParentDeath(onDeath, {
      env: {OPENBOOK_DATA_DIR: '/x'}, // e2e/headless: data-dir set, but NOT OPENBOOK_SIDECAR
      stdin,
      setIntervalImpl,
    });
    expect(stop).toBeUndefined();
    expect(stdin.resumed).toBe(false); // never resume() /dev/null → no spurious 'end'
    expect(setIntervalImpl).not.toHaveBeenCalled();
  });

  it('wires the watches only when the host set OPENBOOK_SIDECAR=1', () => {
    const onDeath = vi.fn();
    const stdin = fakeStdin();
    const stop = installSidecarParentDeath(onDeath, {
      env: {OPENBOOK_SIDECAR: '1', OPENBOOK_DATA_DIR: '/x'},
      stdin,
      ppid: 100,
      getPpid: () => 100,
      isAlive: () => true,
      setIntervalImpl: fakeTimer().setIntervalImpl,
    });
    expect(typeof stop).toBe('function');
    expect(stdin.resumed).toBe(true);
    stdin.emit('end');
    expect(onDeath).toHaveBeenCalledTimes(1);
  });
});
