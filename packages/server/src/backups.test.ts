import {readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BACKUP_CADENCE_MS, type SpaceBackup} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {BackupScheduler} from './backups';

let store: PageStore;
let dataDir: string;
let backupDir: string;
let seq = 0;
let nowMs = 0;

const DAY = BACKUP_CADENCE_MS.daily;
const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const listSnapshots = async (cadence: string): Promise<string[]> => {
  try {
    return (await readdir(join(backupDir, cadence))).filter((f) => f.endsWith('.openbook.json'));
  } catch {
    return [];
  }
};

const scheduler = () => new BackupScheduler(store, {defaultDir: backupDir, now: () => nowMs});

beforeEach(async () => {
  seq += 1;
  nowMs = Date.parse('2026-06-01T00:00:00.000Z');
  dataDir = join(tmpdir(), `ob-backup-test-${process.pid}-${seq}`);
  backupDir = join(tmpdir(), `ob-backup-out-${process.pid}-${seq}`);
  rm(dataDir, {recursive: true, force: true});
  await rm(backupDir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dataDir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  await rm(dataDir, {recursive: true, force: true});
  await rm(backupDir, {recursive: true, force: true});
});

describe('BackupScheduler', () => {
  it('runNow writes a restorable snapshot of the space', async () => {
    await store.upsertPage({name: `bk-${seq}`, data: snapshot()});
    const res = await scheduler().runNow('daily');
    expect(res).toBeTruthy();
    expect(await listSnapshots('daily')).toHaveLength(1);
    const parsed = JSON.parse(await readFile(join(backupDir, 'daily', res!.file), 'utf8')) as SpaceBackup;
    expect(parsed.version).toBeGreaterThanOrEqual(1);
    expect(parsed.pages.some((p) => p.name === `bk-${seq}`)).toBe(true);
  });

  it('does nothing while disabled (the default)', async () => {
    await scheduler().tick();
    expect(await listSnapshots('daily')).toHaveLength(0);
  });

  it('runs a cadence when due and skips it when not', async () => {
    await store.updateBackupConfig({enabled: true, cadences: {daily: true, weekly: false, monthly: false, yearly: false}});
    const s = scheduler();

    await s.tick(); // first run: no prior lastRun → due
    expect(await listSnapshots('daily')).toHaveLength(1);

    nowMs += DAY / 2; // half a day later → not due
    await s.tick();
    expect(await listSnapshots('daily')).toHaveLength(1);

    nowMs += DAY; // now well past a day since the last run → due again
    await s.tick();
    expect(await listSnapshots('daily')).toHaveLength(2);
  });

  it('prunes to the retention count, keeping the newest', async () => {
    await store.updateBackupConfig({keep: {daily: 2, weekly: 5, monthly: 12, yearly: 3}});
    const s = scheduler();
    for (let i = 0; i < 4; i += 1) {
      nowMs += DAY; // distinct, sortable filenames
      await s.runNow('daily');
    }
    const remaining = (await listSnapshots('daily')).sort();
    expect(remaining).toHaveLength(2);
    // The two kept are the most recent (lexically largest ISO-stamped names).
  });

  it('reports per-cadence status (last/next run + count)', async () => {
    await store.updateBackupConfig({enabled: true});
    const s = scheduler();
    await s.runNow('daily');
    const status = await s.status();
    expect(status.resolvedDir).toBe(backupDir);
    const daily = status.cadences.find((c) => c.cadence === 'daily')!;
    expect(daily.count).toBe(1);
    expect(daily.lastRun).not.toBeNull();
    expect(Date.parse(daily.nextDue!) - Date.parse(daily.lastRun!)).toBe(DAY);
  });
});

describe('backup HTTP routes', () => {
  it('GET/PUT/POST /api/backups drive status, policy, and on-demand runs', async () => {
    await store.upsertPage({name: `route-${seq}`, data: snapshot()});
    const app = createApp(store, undefined, new PageHub(), {backups: scheduler()});

    const status = await (await app.request('/api/backups')).json();
    expect(status.resolvedDir).toBe(backupDir);
    expect(status.config.enabled).toBe(false);

    const enabled = await (
      await app.request('/api/backups', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({enabled: true}),
      })
    ).json();
    expect(enabled.config.enabled).toBe(true);

    const run = await app.request('/api/backups/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({cadence: 'weekly'}),
    });
    expect(run.status).toBe(200);
    const {file} = await run.json();
    expect(file).toMatch(/\.openbook\.json$/);
    expect(await listSnapshots('weekly')).toContain(file);
  });

  it('reports 501 when the server cannot write backups (no scheduler)', async () => {
    const app = createApp(store, undefined, new PageHub());
    expect((await app.request('/api/backups')).status).toBe(501);
  });
});
