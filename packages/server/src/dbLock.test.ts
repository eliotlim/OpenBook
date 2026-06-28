import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createPgliteDb, PgliteDataDirLockedError} from './db';

let dataDir: string;
const lockPath = (): string => join(dataDir, '.openbook-pglite.lock');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ob-pglite-lock-'));
});
afterEach(() => {
  rmSync(dataDir, {recursive: true, force: true});
});

describe('createPgliteDb single-owner dataDir lock (corruption guard)', () => {
  it('acquires the dataDir lock on open and releases it on close', async () => {
    const db = await createPgliteDb(dataDir);
    expect(existsSync(lockPath())).toBe(true);
    await db.close();
    expect(existsSync(lockPath())).toBe(false); // released → next open can re-acquire
  });

  it('is FATAL when a live foreign process owns the dataDir (refuses to start)', async () => {
    // Two PGlite instances on one dataDir corrupt it, so unlike the book mirror this
    // does NOT degrade — it refuses. A cross-host holder is unconditionally "live".
    writeFileSync(
      lockPath(),
      JSON.stringify({pid: process.pid, host: 'another-machine', startedAt: new Date().toISOString()}),
      'utf8',
    );
    await expect(createPgliteDb(dataDir)).rejects.toBeInstanceOf(PgliteDataDirLockedError);
    // The foreign lock is left intact — we never opened the store over it.
    expect(existsSync(lockPath())).toBe(true);
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
});
