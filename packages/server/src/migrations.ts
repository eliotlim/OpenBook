import type {Sql} from 'postgres';

interface Migration {
  name: string;
  statements: string[];
}

/**
 * Ordered, append-only list of schema migrations. Each entry runs once and is
 * recorded in `_migrations`. Statements are idempotent where practical so a
 * partially-applied state is recoverable.
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
      // Optional name, unique when present, so name lookups are deterministic.
      `CREATE UNIQUE INDEX IF NOT EXISTS pages_name_key ON pages (name) WHERE name IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS pages_updated_at_idx ON pages (updated_at DESC)`,
    ],
  },
];

/**
 * Apply all pending migrations inside transactions. Idempotent; safe to call on
 * every boot in every mode (embedded desktop or headless server).
 */
export async function runMigrations(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  const applied = await sql<{name: string}[]>`SELECT name FROM _migrations`;
  const done = new Set(applied.map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;
    await sql.begin(async (tx) => {
      for (const statement of migration.statements) {
        await tx.unsafe(statement);
      }
      await tx`INSERT INTO _migrations (name) VALUES (${migration.name})`;
    });
  }
}
