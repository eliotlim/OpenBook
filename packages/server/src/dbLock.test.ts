import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createPgliteDb, PgliteDataDirLockedError} from './db';

let dataDir: string;
const lockPath = (): string => join(dataDir, '.openbook-pglite.lock');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ob-pglite-lock-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, {recursive: true, force: true});
});

const startLiveChild = async (): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  await once(child, 'spawn');
  return child;
};

const spawnDeadPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
  await once(child, 'exit');
  return child.pid!;
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
};

describe('createPgliteDb single-owner dataDir lock (corruption guard)', () => {
  it('acquires the dataDir lock on open and releases it on close', async () => {
    const db = await createPgliteDb(dataDir);
    expect(existsSync(lockPath())).toBe(true);
    await db.close();
    expect(existsSync(lockPath())).toBe(false); // released → next open can re-acquire
  });

  it.each([
    ['same recorded hostname', hostname()],
    ['different recorded hostname', 'pre-rename-mac'],
  ])('is FATAL when a live process owns the dataDir (%s)', async (_label, host) => {
    const child = await startLiveChild();
    try {
      writeFileSync(
        lockPath(),
        JSON.stringify({pid: child.pid, host, startedAt: new Date().toISOString()}),
        'utf8',
      );
      await expect(createPgliteDb(dataDir)).rejects.toBeInstanceOf(PgliteDataDirLockedError);
      expect(existsSync(lockPath())).toBe(true);
    } finally {
      await stopChild(child);
    }
  });

  it('reopens cleanly after a clean close, preserving data', async () => {
    const db = await createPgliteDb(dataDir);
    await db.query('CREATE TABLE t (n int)');
    await db.query('INSERT INTO t VALUES (42)');
    await db.close();

    const reopened = await createPgliteDb(dataDir); // lock was released → succeeds
    const rows = await reopened.query<{n: number}>('SELECT n FROM t');
    expect(rows).toEqual([{n: 42}]);
    await reopened.close();
  });

  it('takes over a stale lock left by a crashed prior run (dead pid)', async () => {
    // A crash leaves the lock behind; the next boot must take it over (dead pid →
    // ESRCH) rather than refuse forever.
    writeFileSync(
      lockPath(),
      JSON.stringify({pid: 999_999, host: hostname(), startedAt: new Date().toISOString()}),
      'utf8',
    );
    const db = await createPgliteDb(dataDir);
    expect(existsSync(lockPath())).toBe(true);
    await db.close();
  });

  it('starts after reclaiming a dead-pid lock recorded under a prior hostname', async () => {
    const deadPid = await spawnDeadPid();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(
      lockPath(),
      JSON.stringify({pid: deadPid, host: 'Apple-Book-Pro-Max.local', startedAt: '2026-08-10T01:16:54.631Z'}),
      'utf8',
    );

    const db = await createPgliteDb(dataDir);
    const holder = JSON.parse(readFileSync(lockPath(), 'utf8')) as {pid: number; host: string};
    expect(holder).toMatchObject({pid: process.pid, host: hostname()});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pid ${deadPid}`));
    await db.close();
  });
});
