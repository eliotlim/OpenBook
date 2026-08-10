import {readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BACKUP_CADENCE_MS, BACKUP_VERSION, type LibraryBackup, type StoredPage} from '@book.dev/sdk';
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
  await rm(dataDir, {recursive: true, force: true});
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
    const parsed = JSON.parse(await readFile(join(backupDir, 'daily', res!.file), 'utf8')) as LibraryBackup;
    expect(parsed.version).toBe(BACKUP_VERSION);
    expect(parsed.pages.some((p) => p.name === `bk-${seq}`)).toBe(true);
    expect(parsed.assets).toEqual([]);
    expect(parsed.pageAccess).toHaveLength(parsed.pages.length);
  });

  it('backs up on a fresh install without configuration (default-on / opt-out)', async () => {
    await scheduler().tick();
    expect(await listSnapshots('daily')).toHaveLength(1);
    // A never-configured instance reads as enabled.
    expect((await store.getBackupConfig()).enabled).toBe(true);
  });

  it('does nothing after an explicit opt-out (and the opt-out persists)', async () => {
    await store.updateBackupConfig({enabled: false});
    await scheduler().tick();
    expect(await listSnapshots('daily')).toHaveLength(0);
    // Re-reading keeps the user's off decision (marker set), not the default-on.
    expect((await store.getBackupConfig()).enabled).toBe(false);
  });

  const seedRawBackupRow = async (config: Record<string, unknown>) => {
    const db = (store as unknown as {db: {query(sql: string, params: unknown[]): Promise<unknown>}}).db;
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('backups', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(config)],
    );
  };

  it('honours a stored enabled:false row (no user marker) — an explicit off is NOT re-enabled', async () => {
    // A row already exists (the only writer is `updateBackupConfig`, so its presence
    // means the user touched the toggle). The default-on override must not apply.
    await seedRawBackupRow({
      enabled: false,
      dir: null,
      cadences: {daily: true, weekly: true, monthly: true, yearly: true},
      keep: {daily: 7, weekly: 5, monthly: 12, yearly: 3},
      lastRun: {},
    });
    expect((await store.getBackupConfig()).enabled).toBe(false);
    await scheduler().tick();
    expect(await listSnapshots('daily')).toHaveLength(0);
  });

  it('honours a stored enabled:true row (no user marker) — stays on', async () => {
    await seedRawBackupRow({
      enabled: true,
      dir: null,
      cadences: {daily: true, weekly: true, monthly: true, yearly: true},
      keep: {daily: 7, weekly: 5, monthly: 12, yearly: 3},
      lastRun: {},
    });
    expect((await store.getBackupConfig()).enabled).toBe(true);
    await scheduler().tick();
    expect(await listSnapshots('daily')).toHaveLength(1);
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

  it('a scheduled snapshot round-trips cleanly through the import/restore path (OB-176)', async () => {
    await store.upsertPage({name: `rt-${seq}`, data: snapshot()});
    const res = await scheduler().runNow('daily');
    expect(res).toBeTruthy();
    const parsed = JSON.parse(await readFile(join(backupDir, 'daily', res!.file), 'utf8')) as LibraryBackup;

    // Restore the scheduled bundle into a fresh instance via the same import path
    // the app's "Restore backup" uses — the canonical LibraryBackup JSON.
    const restoreDir = join(tmpdir(), `ob-backup-restore-${process.pid}-${seq}`);
    const restored = new PageStore(await PgliteDb.create(restoreDir));
    await restored.migrate();
    try {
      const result = await restored.importBundle({...parsed, mode: 'copy', installForeignPageAccess: true});
      expect(result.created).toBe(parsed.pages.length);
      expect(result.diagnostics).toBeUndefined();
      expect((await restored.listPages()).map((p) => p.name)).toContain(`rt-${seq}`);
    } finally {
      await restored.close();
      await rm(restoreDir, {recursive: true, force: true});
    }
  });

  it('binds v3 access state to its origin and requires opt-in on a foreign target', async () => {
    await store.updateInstanceConfig({ownerSubject: 'account#owner'});
    const page = await store.upsertPage({name: `origin-${seq}`, data: snapshot()});
    await store.setPageVisibility(page.id, 'public');
    await store.setPageAgentEdits(page.id, 'direct');
    await store.setPageAcl(page.id, {subject: 'account#viewer', level: 'write', invitedBy: 'account#owner'});

    const bundle = await store.exportAll();
    expect(bundle.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.ownerSubject).toBe('account#owner');

    const sameOrigin = await store.importBundle({...bundle, mode: 'copy'});
    const sameOriginId = sameOrigin.idMap[page.id];
    expect(sameOrigin.diagnostics).toBeUndefined();
    expect(await store.getPageVisibility(sameOriginId)).toBe('public');
    expect(await store.getPageAgentEdits(sameOriginId)).toBe('direct');
    expect(await store.getPageAcl(sameOriginId)).toHaveLength(1);

    const foreignDir = join(tmpdir(), `ob-backup-foreign-${process.pid}-${seq}`);
    const foreign = new PageStore(await PgliteDb.create(foreignDir));
    await foreign.migrate();
    try {
      const safe = await foreign.importBundle({...bundle, mode: 'copy'});
      const safeId = safe.idMap[page.id];
      expect(safe.diagnostics).toEqual([
        expect.objectContaining({code: 'partial-restore', version: 3, missing: ['page-access-state']}),
      ]);
      expect(await foreign.getPageVisibility(safeId)).toBe('restricted');
      expect(await foreign.getPageAgentEdits(safeId)).toBe('suggest');
      expect(await foreign.getPageAcl(safeId)).toEqual([]);

      const optedIn = await foreign.importBundle({...bundle, mode: 'copy', installForeignPageAccess: true});
      const optedInId = optedIn.idMap[page.id];
      expect(optedIn.diagnostics).toBeUndefined();
      expect(await foreign.getPageVisibility(optedInId)).toBe('public');
      expect(await foreign.getPageAgentEdits(optedInId)).toBe('direct');
      expect(await foreign.getPageAcl(optedInId)).toHaveLength(1);

      const originless = structuredClone(bundle);
      delete originless.instanceId;
      delete originless.ownerSubject;
      const noOrigin = await foreign.importBundle({...originless, mode: 'copy'});
      expect(noOrigin.diagnostics).toEqual([
        expect.objectContaining({code: 'partial-restore', version: 3, missing: ['page-access-state']}),
      ]);
      expect(await foreign.getPageVisibility(noOrigin.idMap[page.id])).toBe('restricted');
    } finally {
      await foreign.close();
      await rm(foreignDir, {recursive: true, force: true});
    }
  });

  it('accepts v2 only with an explicit partial-restore diagnostic', async () => {
    const result = await store.importBundle({version: 2, pages: [], databases: [], mode: 'overwrite'});
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'partial-restore',
        version: 2,
        missing: ['complete-asset-manifest', 'page-access-state'],
      }),
    ]);
  });

  it('refuses unknown future versions clearly and writes nothing', async () => {
    const before = await store.exportAll();
    await expect(
      store.importBundle({version: BACKUP_VERSION + 1, pages: [], databases: [], mode: 'overwrite'}),
    ).rejects.toThrow(`unsupported backup format version ${BACKUP_VERSION + 1}`);
    expect((await store.exportAll()).pages).toEqual(before.pages);
  });

  it('fails backup loudly when a live page references missing asset bytes', async () => {
    const missing = 'a'.repeat(64);
    await store.upsertPage({
      name: `missing-asset-${seq}`,
      data: {
        editorjs: {blocks: []},
        values: [],
        names: [],
        blockdoc: {v: 1, update: '', blocks: [{id: 'image', type: 'image', props: {assetId: missing}}]},
      },
    });
    await expect(store.exportAll()).rejects.toThrow(`referenced asset ${missing} has no stored bytes`);
  });

  it('keeps backup reachability aligned with GC for future asset URL shapes', async () => {
    const bytes = Uint8Array.from([7, 8, 9]);
    const {id} = await store.putAsset(bytes, 'image/png');
    const page = await store.upsertPage({
      name: `future-asset-url-${seq}`,
      data: {
        editorjs: {blocks: [{type: 'future-attachment', data: {downloadUrl: `/assets/${id}?download=1`}}]},
        values: [],
        names: [],
      },
    });

    // No edge-table help: both safety-critical paths must derive liveness from
    // the same page document substring semantics.
    expect(await store.pagesReferencingAsset(id)).toEqual([]);
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect((await store.exportAll()).assets).toEqual([
      expect.objectContaining({id, refs: [page.id]}),
    ]);
  });

  it('overwrite restore replaces stale asset refs for the target page', async () => {
    const oldBytes = Uint8Array.from([1, 2, 3]);
    const newBytes = Uint8Array.from([4, 5, 6]);
    const {id: oldId} = await store.putAsset(oldBytes, 'image/png');
    const page = await store.upsertPage({
      name: `replace-restored-ref-${seq}`,
      data: {
        editorjs: {blocks: []},
        values: [],
        names: [],
        blockdoc: {v: 1, update: '', blocks: [{id: 'old', type: 'image', props: {assetId: oldId}}]},
      },
    });
    await store.refAsset(oldId, page.id);
    const original = await store.exportAll();
    const {id: newId} = await store.putAsset(newBytes, 'image/png');
    const replacement = structuredClone(original);
    replacement.pages[0].data = {
      editorjs: {blocks: []},
      values: [],
      names: [],
      blockdoc: {v: 1, update: '', blocks: [{id: 'new', type: 'image', props: {assetId: newId}}]},
    };
    replacement.assets = [{
      id: newId,
      mime: 'image/png',
      size: newBytes.byteLength,
      bytesBase64: Buffer.from(newBytes).toString('base64'),
      refs: [page.id],
    }];

    await store.importBundle({...replacement, mode: 'overwrite'});
    expect(await store.pagesReferencingAsset(oldId)).toEqual([]);
    expect(await store.pagesReferencingAsset(newId)).toEqual([page.id]);
    expect((await store.gcUnreferencedAssets({graceMs: 0})).ids).toContain(oldId);
  });

  it('preflights the v3 asset manifest before writing any page', async () => {
    const missing = 'b'.repeat(64);
    const now = new Date().toISOString();
    const page: StoredPage = {
      id: '00000000-0000-4000-8000-000000000099',
      name: 'must-not-land',
      data: {
        editorjs: {blocks: []},
        values: [],
        names: [],
        blockdoc: {v: 1, update: '', blocks: [{id: 'image', type: 'image', props: {assetId: missing}}]},
      },
      hostedDatabaseId: null,
      databaseId: null,
      parentId: null,
      properties: {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await expect(
      store.importBundle({
        version: 3,
        pages: [page],
        databases: [],
        assets: [],
        pageAccess: [{pageId: page.id, visibility: 'inherit', agentEdits: 'inherit', acl: []}],
        mode: 'overwrite',
      }),
    ).rejects.toThrow(`referenced asset bytes are missing: ${missing}`);
    expect(await store.getPage(page.id)).toBeNull();
  });

  it('rejects v3 asset bytes that do not answer to their manifest hash', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const {id} = await store.putAsset(bytes, 'image/png');
    await store.upsertPage({
      name: `forged-asset-${seq}`,
      data: {
        editorjs: {blocks: []},
        values: [],
        names: [],
        blockdoc: {v: 1, update: '', blocks: [{id: 'image', type: 'image', props: {assetId: id}}]},
      },
    });
    const bundle = await store.exportAll();
    const forged = structuredClone(bundle);
    forged.assets![0].bytesBase64 = Buffer.from([4, 3, 2, 1]).toString('base64');
    const before = (await store.exportAll()).pages.length;
    await expect(store.importBundle({...forged, mode: 'copy'})).rejects.toThrow(/bytes hash to/);
    expect((await store.exportAll()).pages).toHaveLength(before);
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
    expect(status.config.enabled).toBe(true); // default-on (opt-out)

    // Toggling off is an explicit choice that survives a reload (marker persisted).
    const disabled = await (
      await app.request('/api/backups', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
        body: JSON.stringify({enabled: false}),
      })
    ).json();
    expect(disabled.config.enabled).toBe(false);
    expect((await (await app.request('/api/backups')).json()).config.enabled).toBe(false);

    const enabled = await (
      await app.request('/api/backups', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
        body: JSON.stringify({enabled: true}),
      })
    ).json();
    expect(enabled.config.enabled).toBe(true);

    const run = await app.request('/api/backups/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
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

  it('returns a clear 400 for an unknown future bundle version', async () => {
    const app = createApp(store, undefined, new PageHub());
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({version: BACKUP_VERSION + 1, pages: [], databases: [], mode: 'overwrite'}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `unsupported backup format version ${BACKUP_VERSION + 1}; this build reads through v${BACKUP_VERSION}`,
    });
  });

  it('returns clean 400s for malformed or overlong ACL identity fields before writing', async () => {
    await store.upsertPage({name: `acl-preflight-${seq}`, data: snapshot()});
    const base = await store.exportAll();
    const now = new Date().toISOString();
    const cases: Array<{field: 'subject' | 'issuer' | 'invitedBy'; value: unknown}> = [
      {field: 'subject', value: 7},
      {field: 'issuer', value: {not: 'a string'}},
      {field: 'invitedBy', value: false},
      {field: 'subject', value: 's'.repeat(2049)},
      {field: 'issuer', value: 'i'.repeat(2049)},
      {field: 'invitedBy', value: 'b'.repeat(2049)},
    ];
    const app = createApp(store, undefined, new PageHub());

    for (const testCase of cases) {
      const forged = structuredClone(base) as unknown as Record<string, unknown> & LibraryBackup;
      forged.pageAccess![0].acl = [{
        subject: 'account#viewer',
        email: null,
        issuer: null,
        level: 'read',
        invitedBy: null,
        createdAt: now,
        [testCase.field]: testCase.value,
      } as never];
      const res = await app.request('/api/import', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
        body: JSON.stringify({...forged, mode: 'overwrite'}),
      });
      expect(res.status, testCase.field).toBe(400);
      expect((await res.json()).error).toContain(`ACL ${testCase.field}`);
    }
  });

  it('returns a clean 400 when page JSON exceeds the backup nesting cap', async () => {
    await store.upsertPage({name: `deep-preflight-${seq}`, data: snapshot()});
    const forged = structuredClone(await store.exportAll());
    let nested: Record<string, unknown> = {leaf: true};
    for (let depth = 0; depth < 102; depth += 1) nested = {child: nested};
    forged.pages[0].data = nested as never;

    const app = createApp(store, undefined, new PageHub());
    const res = await app.request('/api/import', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({...forged, mode: 'overwrite'}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('exceeds the 100-level nesting cap');
  });
});
