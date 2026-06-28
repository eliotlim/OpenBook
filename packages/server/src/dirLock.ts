import {link, readFile, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';

/**
 * A persisted single-owner lock on a path. `{pid, host, startedAt}` identifies the
 * process that holds it so liveness can be probed (see {@link DirLock.isLive}).
 */
export interface DirLockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Thrown by {@link DirLock.acquire} when another **live** process already holds the
 * lock. Callers decide the consequence: the book mirror degrades to running without
 * a mirror, while the PGlite data dir treats it as fatal (two writers = corruption).
 */
export class DirLockedError extends Error {
  constructor(
    readonly path: string,
    readonly holder: DirLockInfo,
  ) {
    super(`dir lock: ${path} is already held by pid ${holder.pid} on ${holder.host} (since ${holder.startedAt})`);
    this.name = 'DirLockedError';
  }
}

/**
 * How many times {@link DirLock.acquire} will take over a stale lock and retry the
 * exclusive create before giving up. A handful is plenty: a single live peer wins
 * the race once and we decline; only a pathological churn of dying-then-restarting
 * holders would exhaust this, at which point declining is the safe answer.
 */
const MAX_TAKEOVER_ATTEMPTS = 8;

/**
 * A reusable single-owner lock on a filesystem path (generalised from the OB-241
 * mirror lock). Used to guard a directory that exactly one process may own at a
 * time: the on-disk book mirror (degrade-on-contention) and the embedded PGlite
 * `dataDir` (fatal-on-contention — two PGlite instances on one dir corrupt it).
 *
 * **TOCTOU-closed claim.** A naive check-then-write lock ("read the file; if no
 * live holder, write my own") lets two simultaneous starts both observe "free" and
 * both write — both think they won. {@link acquire} instead claims atomically:
 * write the lock body to a temp file then `link()` it to the lock path, which the
 * OS rejects with `EEXIST` if the path already exists. `link()` (not `open(…,'wx')`)
 * is used so the lock file, once present, always holds its full body — there is no
 * window where a racing claimant could read a half-written/empty lock and mistake
 * it for stale. Exactly one of N concurrent claimants wins the `link`; the losers
 * see the winner's (live, foreign) lock and decline.
 *
 * **Liveness + takeover.** A lock whose holder is gone (pid dead → `ESRCH`), or
 * which belongs to an abandoned prior instance in *this* process (own pid), is
 * stale and taken over. A lock from another host (a network-synced folder) can't
 * be probed, so it is assumed live and declined rather than risk a cross-host war.
 */
export class DirLock {
  private held = false;

  private constructor(readonly path: string) {}

  /**
   * Claim exclusive ownership of `path`. Resolves with the held lock, or rejects
   * with {@link DirLockedError} when a live foreign process already owns it.
   */
  static async acquire(path: string): Promise<DirLock> {
    const lock = new DirLock(path);
    await lock.claim();
    return lock;
  }

  /** Is a recorded lock held by a different, still-running process? */
  static isLive(lock: DirLockInfo): boolean {
    if (typeof lock.pid !== 'number') return false; // malformed → ignore.
    // A lock from another machine on a network-synced folder: we can't probe its
    // liveness, so assume live to avoid a cross-host write war.
    if (lock.host && lock.host !== hostname()) return true;
    // Our own pid: a prior instance in this process crashed/was abandoned (e.g. a
    // restart replay) — safe to take over.
    if (lock.pid === process.pid) return false;
    try {
      process.kill(lock.pid, 0); // signal 0 only probes; doesn't kill.
      return true; // the process exists.
    } catch (err) {
      // ESRCH → no such process (dead, take over); EPERM → alive but not ours.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private info(): DirLockInfo {
    return {pid: process.pid, host: hostname(), startedAt: new Date().toISOString()};
  }

  private async readLock(): Promise<DirLockInfo | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as DirLockInfo;
    } catch {
      return null; // missing/unreadable/corrupt — treat as no usable holder.
    }
  }

  private async claim(): Promise<void> {
    for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt += 1) {
      // Write the full body first, then atomically `link` it into place. The lock
      // file therefore never exists half-written, closing the TOCTOU a racing
      // claimant could otherwise hit by reading an empty lock as "stale".
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.info()), 'utf8');
      try {
        await link(tmp, this.path); // atomic create-or-fail: EEXIST if already held.
        this.held = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Already held — read the holder and decide. A live foreign holder is final;
        // a stale/dead/own-pid/unreadable holder is removed and the claim retried,
        // where the exclusive `link` again admits exactly one winner.
        const prior = await this.readLock();
        if (prior && DirLock.isLive(prior)) throw new DirLockedError(this.path, prior);
        await rm(this.path, {force: true});
      } finally {
        await rm(tmp, {force: true});
      }
    }
    // Exhausted takeover attempts: a live peer keeps winning the create race, so
    // someone is actively holding it — decline rather than loop forever.
    const prior = await this.readLock();
    throw new DirLockedError(this.path, prior ?? this.info());
  }

  /** Release the lock (best-effort) so the next start can re-acquire it. */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    try {
      await rm(this.path, {force: true});
    } catch {
      // Best-effort: a leftover lock is re-evaluated by liveness on the next start.
    }
  }
}
