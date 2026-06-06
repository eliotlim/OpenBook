import type {Db} from './db';

interface Migration {
  name: string;
  statements: string[];
}

/**
 * Ordered, append-only schema migrations. Each runs once and is recorded in
 * `_migrations`. Runs on every boot in every mode (embedded PGlite or real
 * Postgres) — the SQL is identical.
 */
const MIGRATIONS: Migration[] = [
  {
    name: '0001_init',
    statements: [
      `CREATE TABLE IF NOT EXISTS pages (
        id          UUID        PRIMARY KEY,
        name        TEXT,
        data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS pages_name_key ON pages (name) WHERE name IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS pages_updated_at_idx ON pages (updated_at DESC)',
    ],
  },
  {
    // Notion-style databases. A database is owned by a host page (1:1) and its
    // rows are ordinary pages tagged with `database_id`. Manual property values
    // live in `pages.properties`; `expr` columns are projected from the row
    // page's reactive snapshot at read time (see sdk `projectExports`).
    //
    // Circular FKs by design: `databases.page_id → pages.id` (the host) and
    // `pages.database_id → databases.id` (row membership). The databases table
    // is created first so the column FK below resolves. Deleting a host page
    // cascades to its database, which cascades to its row pages.
    name: '0002_databases',
    statements: [
      `CREATE TABLE IF NOT EXISTS databases (
        id          UUID        PRIMARY KEY,
        page_id     UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        name        TEXT,
        schema      JSONB       NOT NULL DEFAULT '{"properties":[],"views":[]}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE UNIQUE INDEX IF NOT EXISTS databases_page_id_key ON databases (page_id)',
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS database_id UUID REFERENCES databases(id) ON DELETE CASCADE',
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS properties JSONB NOT NULL DEFAULT \'{}\'::jsonb',
      'CREATE INDEX IF NOT EXISTS pages_database_id_idx ON pages (database_id)',
    ],
  },
  {
    // Page nesting: a page may be a child of another page. Deleting a parent
    // cascades to its children (and theirs), so a subtree is removed together.
    name: '0003_page_nesting',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES pages(id) ON DELETE CASCADE',
      'CREATE INDEX IF NOT EXISTS pages_parent_id_idx ON pages (parent_id)',
    ],
  },
  {
    // Soft delete: deleting a page sets `deleted_at` instead of removing the
    // row, so it can be restored from the trash. A cleanup job hard-deletes
    // pages whose `deleted_at` is older than the configured retention; the FK
    // cascades then remove nested children, the hosted database, and its rows.
    // The unique-name index is narrowed to live rows so a trashed page's name
    // can be reused (and is re-checked on restore).
    name: '0004_soft_delete',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
      'CREATE INDEX IF NOT EXISTS pages_deleted_at_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL',
      'DROP INDEX IF EXISTS pages_name_key',
      'CREATE UNIQUE INDEX IF NOT EXISTS pages_name_key ON pages (name) WHERE name IS NOT NULL AND deleted_at IS NULL',
    ],
  },
];

/** Apply all pending migrations. Idempotent; safe on every boot. */
export async function runMigrations(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = await db.query<{name: string}>('SELECT name FROM _migrations');
  const done = new Set(applied.map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;
    await db.begin(async (tx) => {
      for (const statement of migration.statements) {
        await tx.query(statement);
      }
      await tx.query('INSERT INTO _migrations (name) VALUES ($1)', [migration.name]);
    });
  }
}
