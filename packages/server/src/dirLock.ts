import {link, readFile, rename, rm, writeFile} from 'node:fs/promises';
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
 * Bound on the claim retry loop. Each iteration is one of: a fast exclusive
 * create, a decline against a live holder, or a serialized takeover of a stale
 * lock. Under contention a handful of iterations settle (the takeover winner makes
 * the lock live and everyone else then declines); the bound only stops a
 * pathological churn of dying-and-restarting holders — at which point declining is
 * the safe answer.
 */
const MAX_CLAIM_ATTEMPTS = 64;

/**
 * Iterations the breaker (takeover serializer) will spend recovering a *leaked*
 * breaker before giving up and declining the takeover.
 */
const MAX_BREAKER_ATTEMPTS = 16;

/**
 * A breaker held longer than this **and** whose owner pid is dead is provably
 * abandoned (its critical section is a handful of metadata syscalls — milliseconds,
 * never seconds), so it is safe to recover. The window is deliberately generous so
 * a *fresh* breaker (age ≈ 0) can never be mistaken for a leaked one — which is
 * what makes the (otherwise destructive) breaker recovery race-free in practice.
 */
const BREAKER_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A reusable single-owner lock on a filesystem path (generalised from the OB-241
 * mirror lock). Guards a directory that exactly one process may own at a time: the
 * on-disk book mirror (degrade-on-contention) and the embedded PGlite `dataDir`
 * (fatal-on-contention — two PGlite instances on one dir corrupt it).
 *
 * ## Why not `flock`?
 * A kernel advisory lock (`flock`/`fcntl` on a held-open fd) would be the ideal
 * primitive — it is arbitrated by the kernel and auto-released on process death,
 * removing both the takeover and the pid-liveness heuristic. It is not viable here:
 * Node exposes no `flock`, the only bindings are native addons (e.g. `fs-ext`), and
 * the server ships as a `bun --compile` single-file sidecar cross-compiled to six
 * targets — native addons don't bundle into that. So this is a pure-`fs` lock.
 *
 * ## Claim protocol (exactly-one-owner)
 *  1. **Fast path.** Write the body to a temp file then `link()` it onto the lock
 *     path — an atomic create-or-fail (`EEXIST` if already present). `link` (not
 *     `open(…,'wx')`) guarantees the lock, once present, always holds its full body,
 *     so a racing claimant never reads a half-written/empty lock as "stale".
 *  2. **Decline.** If the holder is **live**, throw {@link DirLockedError}.
 *  3. **Takeover (the corruption-critical step).** A stale holder (dead pid, or our
 *     own abandoned prior instance) is taken over, but the takeover is **serialized
 *     behind a breaker**: a claimant must first win an exclusive breaker (`link` on
 *     a sibling path) before it may remove the stale lock and reclaim. Because only
 *     one process is ever inside the takeover at a time, no claimant can delete a
 *     lock a peer made live in the gap — the bug a naive read→`rm`→`link` has
 *     (reproduced at 19/30 rounds with 2–4 winners). A late cold-`link` that slips
 *     into the brief free window is admitted by the OS atomically (one winner) and
 *     the breaker holder then sees that live lock and declines. The breaker itself
 *     is recovered only when its owner is dead **and** it is older than
 *     {@link BREAKER_STALE_MS} (see above), which terminates the recursion.
 *
 * ## Liveness + takeover policy
 * A holder on another host (a network-synced folder) can't be probed, so it is
 * assumed live and declined — there is never a cross-host takeover. Same-host: a
 * dead pid (`ESRCH`) or our own pid (an abandoned prior instance / restart replay)
 * is stale and taken over; a live foreign pid (`EPERM`/exists) is declined.
 */
export class DirLock {
  private held = false;
  /** The exact body we wrote when we acquired — release() removes the lock only if disk still matches this. */
  private mine: DirLockInfo | null = null;

  private constructor(readonly path: string) {}

  /**
   * Claim exclusive ownership of `path`. Resolves with the held lock, or rejects
   * with {@link DirLockedError} when a live process already owns it.
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
    // liveness, so assume live to avoid a cross-host write war (no cross-host takeover).
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

  private get breakerPath(): string {
    return `${this.path}.breaker`;
  }

  private info(): DirLockInfo {
    return {pid: process.pid, host: hostname(), startedAt: new Date().toISOString()};
  }

  private async readInfo(p: string): Promise<DirLockInfo | null> {
    try {
      return JSON.parse(await readFile(p, 'utf8')) as DirLockInfo;
    } catch {
      return null; // missing/unreadable/corrupt — treat as no usable holder.
    }
  }

  /**
   * Atomic create-or-fail at `dest` with `body`. Returns true if we created it,
   * false on `EEXIST` (already held); other errors propagate. The body is written
   * to a temp file first then `link`ed, so `dest` never exists half-written.
   */
  private async exclusiveCreate(dest: string, body: DirLockInfo): Promise<boolean> {
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(body), 'utf8');
    try {
      await link(tmp, dest);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    } finally {
      await rm(tmp, {force: true});
    }
  }

  private async claim(): Promise<void> {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      // 1. Fast path: atomic create on a free path.
      const body = this.info();
      if (await this.exclusiveCreate(this.path, body)) {
        this.held = true;
        this.mine = body;
        return;
      }
      // 2. Occupied — decline against a live holder.
      const prior = await this.readInfo(this.path);
      if (prior && DirLock.isLive(prior)) throw new DirLockedError(this.path, prior);
      // 3. Stale/corrupt → take over, but ONLY while holding the breaker so two
      //    claimants can't both remove the stale lock and both win.
      if (!(await this.acquireBreaker())) {
        await sleep(2 + Math.floor(Math.random() * 12)); // another taker is active — back off + retry
        continue;
      }
      try {
        const cur = await this.readInfo(this.path);
        if (cur && DirLock.isLive(cur)) throw new DirLockedError(this.path, cur); // became live under us
        // Remove the stale lock, then reclaim by atomic create. A cold-`link` peer
        // can only slip into the brief free window atomically (one winner); if it
        // does, our create fails EEXIST and we decline against its live lock below.
        await rm(this.path, {force: true});
        const reclaim = this.info();
        if (await this.exclusiveCreate(this.path, reclaim)) {
          this.held = true;
          this.mine = reclaim;
          return;
        }
        const won = await this.readInfo(this.path);
        if (won && DirLock.isLive(won)) throw new DirLockedError(this.path, won);
        // Re-staled in the window (cold winner already died) — loop and retry.
      } finally {
        await this.releaseBreaker();
      }
    }
    const prior = await this.readInfo(this.path);
    throw new DirLockedError(this.path, prior ?? this.info());
  }

  /**
   * Win the takeover serializer. Returns true while we hold it; false when another
   * claimant is actively taking over (the caller backs off + retries). A breaker
   * whose owner is dead AND which is older than {@link BREAKER_STALE_MS} is provably
   * leaked (a crash mid-takeover); it is recovered with an atomic `rename`-away so
   * exactly one recoverer wins for a given breaker inode.
   */
  private async acquireBreaker(): Promise<boolean> {
    for (let i = 0; i < MAX_BREAKER_ATTEMPTS; i += 1) {
      if (await this.exclusiveCreate(this.breakerPath, this.info())) return true;
      const b = await this.readInfo(this.breakerPath);
      if (!b) {
        await sleep(2); // mid-create / just-removed — settle then retry
        continue;
      }
      if (!this.breakerRecyclable(b)) return false; // a live taker holds it — defer to them
      // Provably leaked → recover. `rename` removes the breaker atomically; the
      // loser of a concurrent recovery gets ENOENT and simply retries.
      try {
        await rename(this.breakerPath, `${this.breakerPath}.${randomUUID()}.dead`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      // best-effort sweep of any grave we (or a peer) renamed aside is unnecessary —
      // they are dotfiles ignored by the watcher; leave them for the next rm/clean.
    }
    return false;
  }

  private breakerRecyclable(b: DirLockInfo): boolean {
    if (DirLock.isLive(b)) return false; // a live (or cross-host) owner is never recyclable
    const started = Date.parse(b.startedAt);
    if (!Number.isFinite(started)) return true; // unparseable timestamp → treat as leaked
    return Date.now() - started > BREAKER_STALE_MS;
  }

  private async releaseBreaker(): Promise<void> {
    try {
      // Remove the breaker only if it is still ours, so a recovered-from-under-us
      // breaker (we were paused past the stale window) isn't yanked from its new owner.
      const b = await this.readInfo(this.breakerPath);
      if (b && b.pid === process.pid && b.host === hostname()) await rm(this.breakerPath, {force: true});
    } catch {
      // Best-effort: a leftover breaker is recovered by the staleness window.
    }
  }

  /**
   * Release the lock so the next start can re-acquire it. Removes the lock file
   * **only if it still identifies this process** (pid + host + startedAt), so a
   * claimant that lost a race — or an abandoned older instance — can never delete
   * the true live holder's lock on a later release()/close().
   */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const mine = this.mine;
    this.mine = null;
    try {
      const cur = await this.readInfo(this.path);
      if (cur && mine && cur.pid === mine.pid && cur.host === mine.host && cur.startedAt === mine.startedAt) {
        await rm(this.path, {force: true});
      }
    } catch {
      // Best-effort: a leftover lock is re-evaluated by liveness on the next start.
    }
  }
}
