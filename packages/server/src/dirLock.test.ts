import {execFile} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DirLock, DirLockedError, type DirLockInfo} from './dirLock';

const pexec = promisify(execFile);

let dir: string;
const lockPath = (): string => join(dir, '.test.lock');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ob-dirlock-'));
});
afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

const writeHolder = (info: DirLockInfo): void => writeFileSync(lockPath(), JSON.stringify(info), 'utf8');
const readHolder = async (): Promise<DirLockInfo> => JSON.parse(await readFile(lockPath(), 'utf8')) as DirLockInfo;

describe('DirLock single-owner semantics', () => {
  it('claims a free path and writes our identity', async () => {
    const lock = await DirLock.acquire(lockPath());
    expect(existsSync(lockPath())).toBe(true);
    const holder = await readHolder();
    expect(holder.pid).toBe(process.pid);
    expect(holder.host).toBe(hostname());
    await lock.release();
  });

  it('refuses a path a live FOREIGN process owns', async () => {
    // A lock from another host (network-synced folder): liveness is unknowable, so
    // it must be assumed live and declined rather than start a cross-host write war.
    writeHolder({pid: process.pid, host: 'some-other-host', startedAt: new Date().toISOString()});
    await expect(DirLock.acquire(lockPath())).rejects.toBeInstanceOf(DirLockedError);
    // The foreign lock is left intact (we did not steal it).
    expect((await readHolder()).host).toBe('some-other-host');
  });

  it('takes over a STALE lock whose holder pid is gone (ESRCH)', async () => {
    writeHolder({pid: 999_999, host: hostname(), startedAt: new Date().toISOString()});
    const lock = await DirLock.acquire(lockPath());
    expect((await readHolder()).pid).toBe(process.pid); // claimed
    await lock.release();
  });

  it('takes over our OWN-pid lock (an abandoned prior instance / restart replay)', async () => {
    writeHolder({pid: process.pid, host: hostname(), startedAt: '2000-01-01T00:00:00.000Z'});
    const lock = await DirLock.acquire(lockPath());
    expect((await readHolder()).startedAt).not.toBe('2000-01-01T00:00:00.000Z'); // re-claimed
    await lock.release();
  });

  it('takes over a corrupt/empty lock file', async () => {
    await writeFile(lockPath(), 'not json at all', 'utf8');
    const lock = await DirLock.acquire(lockPath());
    expect((await readHolder()).pid).toBe(process.pid);
    await lock.release();
  });

  it('release() removes the lock so the next start can re-acquire it', async () => {
    const first = await DirLock.acquire(lockPath());
    await first.release();
    expect(existsSync(lockPath())).toBe(false);
    const second = await DirLock.acquire(lockPath()); // not blocked by the prior lock
    expect(second).toBeInstanceOf(DirLock);
    await second.release();
  });

  it('release() will NOT delete a lock that no longer identifies this process', async () => {
    // [ER-5 review, LOW] A claimant that lost a race (or an abandoned older instance)
    // must never delete the true live holder's lock on a later release()/close().
    const lock = await DirLock.acquire(lockPath());
    // Simulate the lock having been taken over by another live holder (different body).
    const usurper: DirLockInfo = {pid: process.pid, host: hostname(), startedAt: '2099-01-01T00:00:00.000Z'};
    writeHolder(usurper);
    await lock.release();
    // The usurper's lock survives — release saw the body was no longer ours.
    expect(existsSync(lockPath())).toBe(true);
    expect((await readHolder()).startedAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('isLive: cross-host assumed live; dead pid + own pid taken over', () => {
    expect(DirLock.isLive({pid: process.pid, host: 'elsewhere', startedAt: 'x'})).toBe(true); // cross-host → live
    expect(DirLock.isLive({pid: 999_999, host: hostname(), startedAt: 'x'})).toBe(false); // dead pid → take over
    expect(DirLock.isLive({pid: process.pid, host: hostname(), startedAt: 'x'})).toBe(false); // own pid → take over
    expect(DirLock.isLive({pid: 'nope' as unknown as number, host: hostname(), startedAt: 'x'})).toBe(false); // malformed pid
  });
});

// ── Cross-process single-owner stress (TOCTOU + takeover atomicity) ──────────────
// The takeover path is only meaningful across real OS processes (distinct pids):
// in-process, two claimants share process.pid, so a loser would treat the winner's
// lock as its own abandoned instance. A blind read→rm→link takeover double-grants
// here (Sasha reproduced ~19/30 rounds with 2–4 winners); the breaker-serialized
// takeover must never let two processes own the dir AT ONCE — on the free path AND
// the stale-lock (post-crash dead-pid) path that was broken.
//
// The invariant under test is *simultaneity*, not a cumulative WON count: DirLock is
// a REUSABLE lock, so a winner that releases lawfully frees it for the next claimant.
// Each winner therefore claims an exclusive owner-marker (atomic O_EXCL) for as long
// as it holds the lock; a coexisting owner makes that marker create EEXIST → "DOUBLE",
// which is the real corruption bug (two PGlite opens on one dataDir). Cumulative WON>1
// from a peer re-acquiring the freed lock is benign and expected under load — see the
// assertion comment in stress() and the "Why not flock?" note in dirLock.ts.

const DIRLOCK_SRC = fileURLToPath(new URL('./dirLock.ts', import.meta.url));
const SERVER_SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

let childScript: string;
beforeEach(() => {
  // Each child claims at a shared wall-clock barrier (so they collide), holds
  // briefly so a racing peer sees a *live* foreign holder, then releases. While it
  // holds, it claims an exclusive owner-marker (atomic O_EXCL): if a peer already
  // holds the marker, two owners coexist — a real double-grant — so it reports DOUBLE
  // instead of WON. The marker is dropped before release(), so a peer that lawfully
  // re-acquires the freed (reusable) lock afterwards is NOT a double-grant.
  const child = join(mkdtempSync(join(tmpdir(), 'ob-dirlock-child-')), 'claim.ts');
  const source = [
    `import {DirLock, DirLockedError} from ${JSON.stringify(DIRLOCK_SRC)};`,
    'import {openSync, closeSync, rmSync} from "node:fs";',
    '(async () => {',
    '  const [p, barrier] = [process.argv[2], Number(process.argv[3])];',
    '  while (Date.now() < barrier) { /* spin to the shared barrier */ }',
    '  let lock;',
    '  try {',
    '    lock = await DirLock.acquire(p);',
    '  } catch (e) {',
    '    process.stdout.write(e instanceof DirLockedError ? "DECLINED" : "ERR:" + (e && e.message));',
    '    return;',
    '  }',
    '  let fd = null;',
    '  try {',
    '    fd = openSync(p + ".owner", "wx"); // atomic O_CREAT|O_EXCL — exactly one live owner may hold it',
    '  } catch {',
    '    process.stdout.write("DOUBLE"); // a coexisting owner already holds the marker',
    '    await lock.release();',
    '    return;',
    '  }',
    '  process.stdout.write("WON");',
    '  await new Promise((r) => setTimeout(r, 200));',
    '  closeSync(fd);',
    '  rmSync(p + ".owner", {force: true}); // drop the marker BEFORE releasing — a serialized re-acquire is fine',
    '  await lock.release();',
    '})();',
  ].join('\n');
  writeFileSync(child, source, 'utf8');
  childScript = child;
});

/** Race `n` child processes to claim `path`; returns each child's verdict. */
async function raceClaims(path: string, n: number): Promise<string[]> {
  const barrier = String(Date.now() + 800); // time for every child to spawn + reach the spin
  const run = (): Promise<string> =>
    pexec(process.execPath, ['--import', 'tsx', childScript, path, barrier], {cwd: SERVER_SRC_DIR})
      .then((r) => r.stdout.trim())
      .catch((e: Error) => `THROW:${e.message}`);
  return Promise.all(Array.from({length: n}, run));
}

/** Run `rounds` independent races of `n` claimants; assert no two ever own it at once. */
async function stress(opts: {n: number; rounds: number; seedStale: boolean; seedLeakedBreaker?: boolean}): Promise<void> {
  for (let r = 0; r < opts.rounds; r += 1) {
    const roundDir = mkdtempSync(join(tmpdir(), 'ob-dirlock-stress-'));
    const path = join(roundDir, 'race.lock');
    if (opts.seedStale) {
      // A post-crash leftover from a dead pid that every claimant must take over.
      writeFileSync(path, JSON.stringify({pid: 999_999, host: hostname(), startedAt: new Date().toISOString()}));
    }
    if (opts.seedLeakedBreaker) {
      // A leaked breaker: dead pid, aged past the recovery window — so EVERY claimant
      // hits the breaker-RECOVERY path at once (Sasha's config). This is the path the
      // read→rename gap got wrong (two recoverers → two owners); the token-gated
      // recovery must yield exactly one winner.
      writeFileSync(
        `${path}.breaker`,
        JSON.stringify({pid: 999_999, host: hostname(), startedAt: new Date(Date.now() - 60_000).toISOString()}),
      );
    }
    try {
      const verdicts = await raceClaims(path, opts.n);
      const won = verdicts.filter((v) => v === 'WON');
      const doubled = verdicts.filter((v) => v === 'DOUBLE');
      const errored = verdicts.filter((v) => v.startsWith('ERR') || v.startsWith('THROW'));
      // The crux is the anti-corruption invariant: never two SIMULTANEOUS owners (a
      // DOUBLE marker = two live owners on one dir = two PGlite opens), and never zero
      // (someone must win). We deliberately do NOT assert won === 1: DirLock is a
      // *reusable* lock, so a winner that releases frees it for the next claimant. Under
      // load (this round oversubscribes 16 procs onto 8 cores) a claimant whose startup
      // jitter outran the 200 ms hold can lawfully re-acquire the freed lock, yielding
      // cumulative WON>1 with strictly DISJOINT ownership — proven serialized, never
      // overlapping. Asserting on the cumulative count conflated that benign re-acquire
      // with a real double-grant and intermittently failed under CI load (OB-279). The
      // residual fourth-order two-owners window is unclosable without flock (see the
      // "Why not flock?" + ER-5 notes in dirLock.ts); the marker would catch it as DOUBLE.
      expect({round: r, doubled, errored, wonAtLeastOne: won.length >= 1, verdicts}).toEqual({
        round: r,
        doubled: [],
        errored: [],
        wonAtLeastOne: true,
        verdicts,
      });
    } finally {
      rmSync(roundDir, {recursive: true, force: true});
    }
  }
}

describe('DirLock single-owner stress (cross-process)', () => {
  it('free path: N claimants on a fresh lock → never two owners at once', async () => {
    await stress({n: 8, rounds: 5, seedStale: false});
  }, 90_000);

  it('stale-takeover path: N claimants over a dead-pid lock → never two owners at once', async () => {
    // This is the case the blind-rm takeover got wrong (multiple SIMULTANEOUS winners).
    // With the breaker-serialized takeover, at most one process owns the dir at a time.
    await stress({n: 8, rounds: 10, seedStale: true});
  }, 150_000);

  it('breaker-RECOVERY path: N claimants over a stale lock + leaked breaker → never two owners at once', async () => {
    // Adopts Sasha's recover config: pre-seed a dead-pid stale lock AND a leaked
    // (dead-pid, aged) breaker, so every claimant takes the breaker-recovery path
    // simultaneously. The earlier `rename`-away recovery double-granted here
    // (two recoverers → two owners → two PGlite opens); token-gated recovery must
    // keep it to at most one owner at a time. (n is set above the 8-core dev box to
    // maximise the contention that exposes a regression; the path is exercised every
    // round regardless of core count because the leaked breaker is pre-seeded.)
    await stress({n: 16, rounds: 20, seedStale: true, seedLeakedBreaker: true});
  }, 240_000);
});
