import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {PgliteDb} from './db';
import {runMigrations} from './migrations';

// Migration 0011 (sharing & access schema, OB-188). Proves it applies cleanly on a
// FRESH database and additively on an EXISTING one with data, and that the CHECK
// constraints + partial-unique `lower(email)` indexes behave on the embedded PGlite
// (PostgreSQL 17.5). SCHEMA ONLY — no authorization logic is exercised here.

const ISS = 'https://account.book.pub';
const SUB = `${ISS}#alice`;

/** A fresh in-memory PGlite with every migration applied. */
async function freshDb(): Promise<PgliteDb> {
  const db = await PgliteDb.create('memory://');
  await runMigrations(db);
  return db;
}

const insertMember = (
  db: PgliteDb,
  cols: {subject?: string | null; email?: string | null; issuer?: string; role?: string; status?: string},
): Promise<unknown> =>
  db.query(
    `INSERT INTO members (id, subject, email, issuer, role, status)
     VALUES ($1, $2, $3, COALESCE($4, '${ISS}'), COALESCE($5, 'viewer'), COALESCE($6, 'active'))`,
    [randomUUID(), cols.subject ?? null, cols.email ?? null, cols.issuer ?? null, cols.role ?? null, cols.status ?? null],
  );

const insertAcl = (
  db: PgliteDb,
  pageId: string,
  cols: {subject?: string | null; email?: string | null; issuer?: string | null; level?: string},
): Promise<unknown> =>
  db.query(
    `INSERT INTO page_acl (page_id, subject, email, issuer, level)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'read'))`,
    [pageId, cols.subject ?? null, cols.email ?? null, cols.issuer ?? null, cols.level ?? null],
  );

const newPage = async (db: PgliteDb, name = `p-${randomUUID()}`): Promise<string> => {
  const id = randomUUID();
  await db.query('INSERT INTO pages (id, name) VALUES ($1, $2)', [id, name]);
  return id;
};

describe('migration 0011 — fresh database', () => {
  it('records 0011 and creates members + page_acl + pages.visibility', async () => {
    const db = await freshDb();

    const applied = await db.query<{name: string}>('SELECT name FROM _migrations');
    expect(applied.map((r) => r.name)).toContain('0011_sharing_access');

    const tables = await db.query<{table_name: string}>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('members', 'page_acl')`,
    );
    expect(tables.map((t) => t.table_name).sort()).toEqual(['members', 'page_acl']);

    // The pages.visibility column exists and defaults to 'inherit'.
    const id = await newPage(db);
    const [page] = await db.query<{visibility: string}>('SELECT visibility FROM pages WHERE id = $1', [id]);
    expect(page.visibility).toBe('inherit');

    await db.close();
  });

  it('creates every named index from §2.1 / §2.3 (incl. the lower(email) ones)', async () => {
    const db = await freshDb();
    const rows = await db.query<{indexname: string}>(
      'SELECT indexname FROM pg_indexes WHERE tablename IN (\'members\', \'page_acl\')',
    );
    const names = new Set(rows.map((r) => r.indexname));
    for (const idx of [
      'members_email_key',
      'members_subject_key',
      'members_subject_idx',
      'page_acl_page_idx',
      'page_acl_page_subj_key',
      'page_acl_page_email_key',
      'page_acl_email_idx',
    ]) {
      expect(names).toContain(idx);
    }
    await db.close();
  });
});

describe('migration 0011 — existing database with data', () => {
  it('back-fills visibility=inherit on pre-existing pages and is idempotent', async () => {
    // Simulate a pre-0011 workspace: a real pages table with a row, with 0001..0010
    // already recorded so the runner applies ONLY 0011 against existing data.
    const db = await PgliteDb.create('memory://');
    await db.query('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await db.query(`CREATE TABLE pages (
      id UUID PRIMARY KEY, name TEXT, data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const n of [
      '0001_init', '0002_databases', '0003_page_nesting', '0004_soft_delete', '0005_page_order',
      '0006_settings', '0007_plugins', '0008_suggestions', '0009_provenance', '0010_review_authors',
    ]) {
      await db.query('INSERT INTO _migrations (name) VALUES ($1)', [n]);
    }
    const existing = randomUUID();
    await db.query('INSERT INTO pages (id, name) VALUES ($1, $2)', [existing, 'pre-existing']);

    await runMigrations(db);

    // The ALTER ... ADD COLUMN backfills the existing row with the default.
    const [page] = await db.query<{visibility: string}>('SELECT visibility FROM pages WHERE id = $1', [existing]);
    expect(page.visibility).toBe('inherit');

    // Now the new tables work on top of the existing page.
    await insertMember(db, {subject: SUB, email: 'alice@example.com', role: 'admin'});
    await insertAcl(db, existing, {subject: SUB, level: 'write'});

    // Re-running every migration is a clean no-op that preserves data.
    await runMigrations(db);
    const [{n: migCount}] = await db.query<{n: string}>(
      'SELECT count(*)::int AS n FROM _migrations WHERE name = \'0011_sharing_access\'',
    );
    expect(Number(migCount)).toBe(1);
    const [{n: pageCount}] = await db.query<{n: string}>('SELECT count(*)::int AS n FROM pages');
    expect(Number(pageCount)).toBe(1);
    const [{n: memberCount}] = await db.query<{n: string}>('SELECT count(*)::int AS n FROM members');
    expect(Number(memberCount)).toBe(1);

    await db.close();
  });
});

describe('migration 0011 — members constraints', () => {
  it('enforces case-insensitive email uniqueness (rejects a dup persona)', async () => {
    const db = await freshDb();
    await insertMember(db, {email: 'Alice@Example.com'});
    await expect(insertMember(db, {email: 'alice@example.com'})).rejects.toThrow();
    await db.close();
  });

  it('rejects a row with neither email nor subject (the at-least-one-key CHECK)', async () => {
    const db = await freshDb();
    await expect(insertMember(db, {subject: null, email: null})).rejects.toThrow();
    await db.close();
  });

  it('allows two distinct personas backed by the same account subject', async () => {
    const db = await freshDb();
    await insertMember(db, {subject: SUB, email: 'work@example.com'});
    await insertMember(db, {subject: SUB, email: 'personal@example.com'});
    const [{n}] = await db.query<{n: string}>('SELECT count(*)::int AS n FROM members WHERE subject = $1', [SUB]);
    expect(Number(n)).toBe(2);
    await db.close();
  });

  it('enforces subject uniqueness for pure subject/handle members', async () => {
    const db = await freshDb();
    await insertMember(db, {subject: SUB});
    await expect(insertMember(db, {subject: SUB})).rejects.toThrow();
    await db.close();
  });
});

describe('migration 0011 — page_acl constraints', () => {
  it('rejects an email grant with no issuer (B1 — email MUST pin an issuer)', async () => {
    const db = await freshDb();
    const page = await newPage(db);
    await expect(insertAcl(db, page, {email: 'invitee@example.com', issuer: null})).rejects.toThrow();
    await db.close();
  });

  it('rejects a row with both a subject and an email (exactly-one-key CHECK)', async () => {
    const db = await freshDb();
    const page = await newPage(db);
    await expect(insertAcl(db, page, {subject: SUB, email: 'invitee@example.com', issuer: ISS})).rejects.toThrow();
    await db.close();
  });

  it('enforces case-insensitive email uniqueness per page', async () => {
    const db = await freshDb();
    const page = await newPage(db);
    await insertAcl(db, page, {email: 'Invitee@Example.com', issuer: ISS});
    await expect(insertAcl(db, page, {email: 'invitee@example.com', issuer: ISS})).rejects.toThrow();
    // The same email on a DIFFERENT page is fine (uniqueness is per page).
    const other = await newPage(db);
    await insertAcl(db, other, {email: 'invitee@example.com', issuer: ISS});
    await db.close();
  });

  it('cascade-deletes ACL rows with their page', async () => {
    const db = await freshDb();
    const page = await newPage(db);
    await insertAcl(db, page, {subject: SUB, level: 'write'});
    await db.query('DELETE FROM pages WHERE id = $1', [page]);
    const [{n}] = await db.query<{n: string}>('SELECT count(*)::int AS n FROM page_acl WHERE page_id = $1', [page]);
    expect(Number(n)).toBe(0);
    await db.close();
  });
});
