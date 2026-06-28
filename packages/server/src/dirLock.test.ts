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

  it('isLive: cross-host assumed live; dead pid + own pid taken over', () => {
    expect(DirLock.isLive({pid: process.pid, host: 'elsewhere', startedAt: 'x'})).toBe(true); // cross-host → live
    expect(DirLock.isLive({pid: 999_999, host: hostname(), startedAt: 'x'})).toBe(false); // dead pid → take over
    expect(DirLock.isLive({pid: process.pid, host: hostname(), startedAt: 'x'})).toBe(false); // own pid → take over
    expect(DirLock.isLive({pid: 'nope' as unknown as number, host: hostname(), startedAt: 'x'})).toBe(false); // malformed pid
  });
});

// ── Cross-process O_EXCL race (TOCTOU closure) ──────────────────────────────────
// In-process the two claimants would share `process.pid`, so the loser would treat
// the winner's lock as its own abandoned instance and take over — both "win". The
// race only has meaning across real OS processes (distinct pids), which is also the
// real-world scenario: two `openbook-server` starts pointed at one dir. Each child
// claims the same lock at a shared wall-clock barrier; exactly one must win.

const DIRLOCK_SRC = fileURLToPath(new URL('./dirLock.ts', import.meta.url));
const SERVER_SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Spawn N children racing to claim `path`; returns each child's verdict. */
async function raceClaims(path: string, n: number): Promise<string[]> {
  const child = join(mkdtempSync(join(tmpdir(), 'ob-dirlock-child-')), 'claim.ts');
  // The child claims, holds briefly (so a racing peer sees a *live* foreign holder),
  // then releases. WON/DECLINED is its only stdout line.
  const source = [
    `import {DirLock, DirLockedError} from ${JSON.stringify(DIRLOCK_SRC)};`,
    '(async () => {',
    '  const [p, barrier] = [process.argv[2], Number(process.argv[3])];',
    '  while (Date.now() < barrier) { /* spin to the shared barrier */ }',
    '  try {',
    '    const lock = await DirLock.acquire(p);',
    '    process.stdout.write("WON");',
    '    await new Promise((r) => setTimeout(r, 400));',
    '    await lock.release();',
    '  } catch (e) {',
    '    process.stdout.write(e instanceof DirLockedError ? "DECLINED" : "ERR:" + (e && e.message));',
    '  }',
    '})();',
  ].join('\n');
  writeFileSync(child, source, 'utf8');
  const barrier = String(Date.now() + 800); // give every child time to spawn + reach the spin
  const run = (): Promise<string> =>
    pexec(process.execPath, ['--import', 'tsx', child, path, barrier], {cwd: SERVER_SRC_DIR})
      .then((r) => r.stdout.trim())
      .catch((e: Error) => `THROW:${e.message}`);
  return Promise.all(Array.from({length: n}, run));
}

describe('DirLock O_EXCL race (cross-process)', () => {
  it('two near-simultaneous claims on a free path → exactly one wins', async () => {
    const path = join(dir, 'race-free.lock');
    const verdicts = await raceClaims(path, 2);
    expect(verdicts.filter((v) => v === 'WON')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'DECLINED')).toHaveLength(1);
  }, 30_000);

  it('concurrent takeover of a STALE lock still admits exactly one winner', async () => {
    const path = join(dir, 'race-stale.lock');
    // A dead-pid lock both children must take over: the exclusive `link` retry must
    // still let only one re-create it (without O_EXCL both would take over + win).
    writeFileSync(path, JSON.stringify({pid: 999_999, host: hostname(), startedAt: new Date().toISOString()}));
    const verdicts = await raceClaims(path, 3);
    expect(verdicts.filter((v) => v === 'WON')).toHaveLength(1);
    expect(verdicts.filter((v) => v === 'DECLINED')).toHaveLength(2);
  }, 40_000);
});
