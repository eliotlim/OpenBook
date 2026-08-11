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
 * Only a recovery **token** held longer than this (and whose owner is dead) is
 * reclaimed. A recovery token is created and removed within a sub-millisecond
 * window, so a token older than this can only be the litter of a process that died
 * mid-recovery; a *fresh* token (age ≈ 0, from a live recoverer) is never past it,
 * so an active recoverer is never displaced. (The leaked *breaker* itself needs no
 * age gate — recovery is gated by an atomic identity-keyed token, not by age.)
 */
const BREAKER_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether two lock bodies identify the same acquisition (the full triple). */
const sameIdentity = (a: DirLockInfo, b: DirLockInfo): boolean =>
  a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt;

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
 * Desktop data directories are single-machine state, and hostnames drift during
 * ordinary renames/network changes, so `host` is informational: every pid is
 * probed locally. A dead pid (`ESRCH`) or our own pid (an abandoned prior instance
 * / restart replay) is stale and taken over; a live foreign pid (`EPERM`/exists)
 * is declined. Network-volume caveat: a directory genuinely shared by multiple
 * machines cannot use this lock for cross-machine exclusion because pid namespaces
 * are local. The immutable lock has no heartbeat/lease with which to add a safe
 * freshness gate; such shared data directories are therefore unsupported.
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
          if (cur) {
            console.warn(
              `OpenBook dir lock: reclaimed stale lock ${this.path} left by pid ${cur.pid} on ${cur.host}`,
            );
          }
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
   * Win the takeover serializer ("breaker"). Returns true while we hold it; false
   * when another claimant is actively taking over (the caller backs off + retries).
   *
   * Recovering a **leaked** breaker (owner genuinely dead) is the corruption-critical
   * step an earlier `rename`-away version got wrong: it read the leaked breaker `B0`,
   * then `rename(breakerPath → grave)` acted on whatever was at `breakerPath` *at
   * execution time* — which a peer recoverer may already have replaced with its own
   * fresh breaker `B1`. Moving `B1` aside let two processes both "recover" and both
   * enter the takeover → two owners (reproduced). So recovery is now gated by a
   * **token whose name is derived from `B0`'s identity**: only the one process that
   * wins `exclusiveCreate(token)` may touch this exact `B0`, and it replaces it via an
   * atomic rename-overwrite (no empty window). While `B0` sits at `breakerPath` no
   * fresh breaker is ever created (cold creators see it occupied; rival recoverers
   * lose the token), so the wrong-inode displacement is structurally impossible —
   * which is what keeps the inner `rm(path)` at {@link claim} safe (single-entry).
   */
  private async acquireBreaker(): Promise<boolean> {
    for (let i = 0; i < MAX_BREAKER_ATTEMPTS; i += 1) {
      // Cold path: create the breaker on a free slot.
      if (await this.exclusiveCreate(this.breakerPath, this.info())) return true;
      const b = await this.readInfo(this.breakerPath);
      if (!b) {
        await sleep(2); // mid-create / just-removed — settle then retry
        continue;
      }
      if (DirLock.isLive(b)) return false; // a live taker holds it — defer
      // `b` is a leaked breaker (owner dead). Elect the SOLE recoverer of this exact
      // `b` and let only it replace the breaker.
      const outcome = await this.recoverLeakedBreaker(b);
      if (outcome === 'won') return true;
      if (outcome === 'deferred') return false; // a live recoverer owns the token
      // 'retry' → a token from a crashed recoverer was reclaimed; loop and re-elect.
    }
    return false;
  }

  /**
   * Recover leaked breaker `b`. Win a token keyed to `b`'s identity (so exactly one
   * process recovers a given leaked breaker), then replace `b` with our own breaker
   * via an atomic overwrite — no empty window for a cold-creator to slip into.
   * Returns `'won'` (we now hold the breaker), `'deferred'` (a live process is
   * recovering `b` — caller declines), or `'retry'` (a token leaked by a recoverer
   * that died mid-recovery was reclaimed; the caller should loop and re-elect).
   *
   * ER-5 accepted residual: a *fourth-order* two-owners window remains — a recoverer
   * must die in the sub-ms gap between winning the token and the atomic breaker
   * overwrite, survive the {@link BREAKER_STALE_MS} (30s) window, and have a peer hit a
   * precise reclaim interleave. It is unclosable with pure-fs primitives (the reclaim
   * is a recursive TOCTOU) and `flock` is unavailable in the bun-compiled sidecar (see
   * the "Why not flock?" header note); astronomically gated and self-healing (the next
   * acquire re-elects), so it is a reviewed, knowingly-accepted limitation.
   */
  private async recoverLeakedBreaker(b: DirLockInfo): Promise<'won' | 'deferred' | 'retry'> {
    const token = this.recoveryTokenPath(b);
    if (await this.exclusiveCreate(token, this.info())) {
      try {
        // Re-verify the breaker is STILL the exact `b` we're recovering before
        // overwriting it. The token is released only AFTER the replace below and at
        // most one process holds it at a time, so a *prior* recoverer (which has
        // since released the token, letting us win it) has already replaced `b` —
        // breakerPath then no longer equals `b`, and overwriting its live breaker
        // would double-grant. In that case abort: that recoverer is live and wins.
        const cur = await this.readInfo(this.breakerPath);
        if (!cur || !sameIdentity(cur, b)) return 'deferred';
        await this.replaceInPlace(this.breakerPath, this.info()); // B0 → ours, atomic
        return 'won';
      } finally {
        await rm(token, {force: true}); // happy-path cleanup — no token litter (ER-9)
      }
    }
    // Lost the token: normally a live recoverer holds it (defer). The exception is a
    // recoverer that died in the sub-ms window between winning the token and
    // overwriting the breaker — then the token is leaked. Reclaim it ONLY when its
    // owner is dead AND it is aged past the window, so a fresh token (age ≈ 0) from a
    // live recoverer is never displaced.
    const t = await this.readInfo(token);
    if (t && !DirLock.isLive(t) && this.agedOut(t)) {
      await rm(token, {force: true});
      return 'retry';
    }
    return 'deferred';
  }

  /** Token path keyed to a leaked breaker's identity, so all its recoverers contend for one token. */
  private recoveryTokenPath(b: DirLockInfo): string {
    const ts = Date.parse(b.startedAt);
    return `${this.breakerPath}.rec.${b.pid}.${Number.isFinite(ts) ? ts : 'x'}`;
  }

  /** Atomically replace whatever is at `dest` with `body` — write-temp then rename-overwrite, no gap. */
  private async replaceInPlace(dest: string, body: DirLockInfo): Promise<void> {
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(body), 'utf8');
    await rename(tmp, dest);
  }

  private agedOut(info: DirLockInfo): boolean {
    const started = Date.parse(info.startedAt);
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
      if (cur && mine && sameIdentity(cur, mine)) {
        await rm(this.path, {force: true});
      }
    } catch {
      // Best-effort: a leftover lock is re-evaluated by liveness on the next start.
    }
  }
}
