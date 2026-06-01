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
