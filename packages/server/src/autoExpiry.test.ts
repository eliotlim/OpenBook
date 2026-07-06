/**
 * Generalisable database auto-expiry (TTL) — feature B.
 *
 * A database whose {@link DatabaseSchema.autoExpiry} is enabled auto-removes rows
 * older than N days on the hourly `sweepTrash` loop. These tests pin the store
 * primitive {@link PageStore.sweepExpiredRows}:
 *  - rows past the cutoff (by `created`, `lastEdited`, or a `date` property) are
 *    SOFT-deleted to the trash (restorable) — never hard-purged by this sweep;
 *  - fresher rows and disabled databases are left untouched;
 *  - the sweep is scoped strictly to each database's own rows;
 *  - the `days` clamp and invalid-basis no-op rules hold.
 *
 * `now` is injected so the tests never depend on the uncontrollable wall clock:
 * rows are back-dated with a raw `created_at`/`updated_at`/`properties` write and
 * the sweep is run against a fixed `now`.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AutoExpiryConfig, DatabaseProperty, PageSnapshot} from '@book.dev/sdk';
import {resolveAutoExpiry} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

let db: PgliteDb;
let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-auto-expiry-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const emptySnap = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

/** A fixed reference clock so cutoffs are deterministic. */
const NOW = new Date('2026-07-06T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** Create a database (with a fresh host page) carrying `schema`. */
async function makeDatabase(
  properties: DatabaseProperty[],
  autoExpiry: AutoExpiryConfig | undefined,
): Promise<string> {
  const host = await store.upsertPage({name: `host-${seq}-${Math.random()}`, data: emptySnap()});
  const database = await store.createDatabase({
    pageId: host.id,
    schema: {properties, views: [], ...(autoExpiry ? {autoExpiry} : {})},
  });
  return database.id;
}

/** Force a row's `created_at` (bypasses the DB default so ages are deterministic). */
const setCreatedAt = (id: string, at: Date) =>
  db.query('UPDATE pages SET created_at = $2 WHERE id = $1', [id, at.toISOString()]);
/** Force a row's `updated_at`. */
const setUpdatedAt = (id: string, at: Date) =>
  db.query('UPDATE pages SET updated_at = $2 WHERE id = $1', [id, at.toISOString()]);

/** Is the row currently in the trash (soft-deleted)? */
async function isTrashed(id: string): Promise<boolean> {
  const rows = await db.query<{deleted_at: Date | string | null}>(
    'SELECT deleted_at FROM pages WHERE id = $1',
    [id],
  );
  return rows.length > 0 && rows[0].deleted_at != null;
}

/** Does the row still physically exist (i.e. was NOT hard-deleted)? */
async function exists(id: string): Promise<boolean> {
  const rows = await db.query<{id: string}>('SELECT id FROM pages WHERE id = $1', [id]);
  return rows.length > 0;
}

describe('PageStore.sweepExpiredRows — created basis', () => {
  it('soft-deletes rows older than N days, keeps fresher rows, returns the count', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 30, basis: 'created'});
    const old = await store.createRow(dbId, {name: 'old'});
    const fresh = await store.createRow(dbId, {name: 'fresh'});
    await setCreatedAt(old.id, days(40)); // past the 30-day cutoff
    await setCreatedAt(fresh.id, days(5)); // well inside the window

    const count = await store.sweepExpiredRows({now: NOW});

    expect(count).toBe(1);
    expect(await isTrashed(old.id)).toBe(true);
    expect(await isTrashed(fresh.id)).toBe(false);
    // Only the fresh row remains in the live projection.
    const rows = await store.listRows(dbId);
    expect(rows.map((r) => r.id)).toEqual([fresh.id]);
  });

  it('rows exactly at the cutoff expire (<=)', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 10, basis: 'created'});
    const edge = await store.createRow(dbId, {name: 'edge'});
    await setCreatedAt(edge.id, days(10)); // exactly the boundary

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(edge.id)).toBe(true);
  });

  it('does nothing when auto-expiry is disabled', async () => {
    const dbId = await makeDatabase([], {enabled: false, days: 1, basis: 'created'});
    const old = await store.createRow(dbId, {name: 'ancient'});
    await setCreatedAt(old.id, days(999));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(0);
    expect(await isTrashed(old.id)).toBe(false);
  });

  it('does nothing when a database has no autoExpiry config at all', async () => {
    const dbId = await makeDatabase([], undefined);
    const old = await store.createRow(dbId, {name: 'ancient'});
    await setCreatedAt(old.id, days(999));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(0);
    expect(await isTrashed(old.id)).toBe(false);
  });
});

describe('PageStore.sweepExpiredRows — other bases', () => {
  it('honours the lastEdited basis (updated_at)', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 30, basis: 'lastEdited'});
    const stale = await store.createRow(dbId, {name: 'stale'});
    const active = await store.createRow(dbId, {name: 'active'});
    // Both created long ago, but `active` was edited recently → should survive.
    await setCreatedAt(stale.id, days(400));
    await setCreatedAt(active.id, days(400));
    await setUpdatedAt(stale.id, days(90));
    await setUpdatedAt(active.id, days(2));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(stale.id)).toBe(true);
    expect(await isTrashed(active.id)).toBe(false);
  });

  it('honours a date-property basis (value in pages.properties)', async () => {
    const dueProp: DatabaseProperty = {id: 'p_due', name: 'Due', type: 'date'};
    const dbId = await makeDatabase([dueProp], {enabled: true, days: 30, basis: 'p_due'});
    // Rows are all freshly created; expiry keys off the stored `Due` date, not created_at.
    const overdue = await store.createRow(dbId, {name: 'overdue', properties: {p_due: '2026-01-01'}});
    const upcoming = await store.createRow(dbId, {name: 'upcoming', properties: {p_due: '2026-07-05'}});
    const noDate = await store.createRow(dbId, {name: 'no-date', properties: {}});

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(overdue.id)).toBe(true);
    expect(await isTrashed(upcoming.id)).toBe(false);
    expect(await isTrashed(noDate.id)).toBe(false); // a missing date never expires
  });

  it('honours a date-range property basis (compares the range start)', async () => {
    const spanProp: DatabaseProperty = {id: 'p_span', name: 'Span', type: 'date', dateRange: true};
    const dbId = await makeDatabase([spanProp], {enabled: true, days: 30, basis: 'p_span'});
    const old = await store.createRow(dbId, {
      name: 'old-span',
      properties: {p_span: {start: '2026-01-01', end: '2026-01-10'}},
    });
    const recent = await store.createRow(dbId, {
      name: 'recent-span',
      properties: {p_span: {start: '2026-07-04', end: '2026-07-08'}},
    });

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(old.id)).toBe(true);
    expect(await isTrashed(recent.id)).toBe(false);
  });

  it('treats a created_time property basis as the created time', async () => {
    const createdProp: DatabaseProperty = {id: 'p_created', name: 'Created', type: 'created_time'};
    const dbId = await makeDatabase([createdProp], {enabled: true, days: 30, basis: 'p_created'});
    const old = await store.createRow(dbId, {name: 'old'});
    const fresh = await store.createRow(dbId, {name: 'fresh'});
    await setCreatedAt(old.id, days(60));
    await setCreatedAt(fresh.id, days(1));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(old.id)).toBe(true);
    expect(await isTrashed(fresh.id)).toBe(false);
  });
});

describe('PageStore.sweepExpiredRows — safety', () => {
  it('SOFT-deletes (restorable), never hard-deletes', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 7, basis: 'created'});
    const old = await store.createRow(dbId, {name: 'old'});
    await setCreatedAt(old.id, days(30));

    await store.sweepExpiredRows({now: NOW});
    expect(await isTrashed(old.id)).toBe(true);
    expect(await exists(old.id)).toBe(true); // still physically present — not purged

    // A restore brings it straight back into the live database.
    const restored = await store.restorePage(old.id);
    expect(restored).not.toBeNull();
    expect(await isTrashed(old.id)).toBe(false);
    expect((await store.listRows(dbId)).map((r) => r.id)).toContain(old.id);
  });

  it('touches ONLY the target database, never another database with old rows', async () => {
    const expiring = await makeDatabase([], {enabled: true, days: 30, basis: 'created'});
    const disabled = await makeDatabase([], {enabled: false, days: 30, basis: 'created'});

    const a = await store.createRow(expiring, {name: 'a-old'});
    const b = await store.createRow(disabled, {name: 'b-old'}); // just as old, but disabled db
    await setCreatedAt(a.id, days(90));
    await setCreatedAt(b.id, days(90));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(a.id)).toBe(true);
    expect(await isTrashed(b.id)).toBe(false); // the other database is untouched
    expect((await store.listRows(disabled)).map((r) => r.id)).toEqual([b.id]);
  });
});

describe('PageStore.sweepExpiredRows — clamp & invalid basis (no-op)', () => {
  it('clamps days < 1 up to 1 (does not disable the sweep)', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 0, basis: 'created'});
    const twoDaysOld = await store.createRow(dbId, {name: 'two-days'});
    await setCreatedAt(twoDaysOld.id, days(2)); // older than the clamped 1-day window

    expect(await store.sweepExpiredRows({now: NOW})).toBe(1);
    expect(await isTrashed(twoDaysOld.id)).toBe(true);
  });

  it('is a no-op when the basis property does not exist', async () => {
    const dbId = await makeDatabase([], {enabled: true, days: 1, basis: 'p_missing'});
    const old = await store.createRow(dbId, {name: 'old', properties: {p_missing: '2000-01-01'}});
    await setCreatedAt(old.id, days(999));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(0);
    expect(await isTrashed(old.id)).toBe(false);
  });

  it('is a no-op when the basis property is not a date/created_time column', async () => {
    const textProp: DatabaseProperty = {id: 'p_note', name: 'Note', type: 'text'};
    const dbId = await makeDatabase([textProp], {enabled: true, days: 1, basis: 'p_note'});
    const old = await store.createRow(dbId, {name: 'old', properties: {p_note: 'whatever'}});
    await setCreatedAt(old.id, days(999));

    expect(await store.sweepExpiredRows({now: NOW})).toBe(0);
    expect(await isTrashed(old.id)).toBe(false);
  });
});

describe('resolveAutoExpiry (SDK validator)', () => {
  const base = {properties: [{id: 'p_due', name: 'Due', type: 'date'} as DatabaseProperty], views: []};

  it('returns null when absent or disabled', () => {
    expect(resolveAutoExpiry({...base})).toBeNull();
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: false, days: 5, basis: 'created'}})).toBeNull();
  });

  it('clamps days to >= 1 and floors it', () => {
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: 0, basis: 'created'}})).toEqual({days: 1, kind: 'created'});
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: -4, basis: 'lastEdited'}})).toEqual({days: 1, kind: 'lastEdited'});
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: 30.9, basis: 'created'}})).toEqual({days: 30, kind: 'created'});
  });

  it('rejects NaN / Infinite days', () => {
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: Number.NaN, basis: 'created'}})).toBeNull();
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: Infinity, basis: 'created'}})).toBeNull();
  });

  it('resolves a date property basis, collapses created_time to created, rejects others', () => {
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: 5, basis: 'p_due'}})).toEqual({days: 5, kind: 'dateProperty', propertyId: 'p_due'});
    const withCreated = {properties: [{id: 'p_ct', name: 'C', type: 'created_time'} as DatabaseProperty], views: []};
    expect(resolveAutoExpiry({...withCreated, autoExpiry: {enabled: true, days: 5, basis: 'p_ct'}})).toEqual({days: 5, kind: 'created'});
    const withText = {properties: [{id: 'p_t', name: 'T', type: 'text'} as DatabaseProperty], views: []};
    expect(resolveAutoExpiry({...withText, autoExpiry: {enabled: true, days: 5, basis: 'p_t'}})).toBeNull();
    expect(resolveAutoExpiry({...base, autoExpiry: {enabled: true, days: 5, basis: 'p_nope'}})).toBeNull();
  });
});
