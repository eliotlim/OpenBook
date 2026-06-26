import type {Db} from './dbCore';

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
    // Full-featured databases. A database is owned by a host page (1:1) and its
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
  {
    // Manual sidebar ordering. `position` orders a page among its siblings (the
    // pages sharing its `parent_id`, NULL = top level); the sidebar tree lists
    // pages by it instead of by recency. Backfilled from the previous
    // updated-at-desc order so existing workspaces keep their current layout.
    // Drag-to-reorder / drag-to-nest renumbers a sibling group via `movePage`.
    name: '0005_page_order',
    statements: [
      'ALTER TABLE pages ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION NOT NULL DEFAULT 0',
      `WITH ordered AS (
         SELECT id, row_number() OVER (PARTITION BY parent_id ORDER BY updated_at DESC) - 1 AS rn
         FROM pages
       )
       UPDATE pages p SET position = o.rn FROM ordered o WHERE p.id = o.id`,
      'CREATE INDEX IF NOT EXISTS pages_parent_position_idx ON pages (parent_id, position)',
    ],
  },
  {
    // Key-value settings (first consumer: the optional local-AI config).
    // JSONB values; identical SQL for embedded PGlite and Postgres.
    name: '0006_settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS settings (
        key    TEXT  PRIMARY KEY,
        value  JSONB NOT NULL DEFAULT '{}'::jsonb
      )`,
    ],
  },
  {
    // Installed extensions: the whole package (manifest + TypeScript source
    // files + optional registry signature) lives in JSONB so every client of
    // the workspace loads the same plugins.
    name: '0007_plugins',
    statements: [
      `CREATE TABLE IF NOT EXISTS plugins (
        id            TEXT        PRIMARY KEY,
        manifest      JSONB       NOT NULL,
        files         JSONB       NOT NULL,
        signature     JSONB,
        enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
        installed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    // The review layer: persisted SUGGESTIONS (proposed, reviewable changes —
    // AI write tools and humans both author these instead of mutating the
    // document directly) and COMMENTS (threaded on a suggestion, or standalone
    // on a block). Both cascade-delete with their host page. A suggestion's
    // `target`/`payload` are JSONB (the bridge replays `payload` to apply the
    // change); a comment's `body` is JSONB rich text (TextRun[]). Comments are
    // double-anchored: `suggestion_id` for a review thread, `block_id` for a
    // standalone block comment (exactly one is set in practice).
    name: '0008_suggestions',
    statements: [
      `CREATE TABLE IF NOT EXISTS suggestions (
        id           UUID        PRIMARY KEY,
        page_id      UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        author_kind  TEXT        NOT NULL,
        author_name  TEXT        NOT NULL,
        kind         TEXT        NOT NULL,
        target       JSONB       NOT NULL DEFAULT '{}'::jsonb,
        before_text  TEXT        NOT NULL DEFAULT '',
        after_text   TEXT        NOT NULL DEFAULT '',
        status       TEXT        NOT NULL DEFAULT 'open',
        payload      JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS suggestions_page_id_idx ON suggestions (page_id)',
      'CREATE INDEX IF NOT EXISTS suggestions_status_idx ON suggestions (page_id, status)',
      `CREATE TABLE IF NOT EXISTS comments (
        id             UUID        PRIMARY KEY,
        page_id        UUID        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        suggestion_id  UUID        REFERENCES suggestions(id) ON DELETE CASCADE,
        block_id       TEXT,
        parent_id      UUID        REFERENCES comments(id) ON DELETE CASCADE,
        author_name    TEXT        NOT NULL,
        body           JSONB       NOT NULL DEFAULT '[]'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS comments_page_id_idx ON comments (page_id)',
      'CREATE INDEX IF NOT EXISTS comments_suggestion_id_idx ON comments (suggestion_id)',
    ],
  },
  {
    // Multi-user provenance (OB-165). The server is single-tenant (one shared
    // workspace), so this records *who* made each change, not data ownership.
    //
    // `edit_log` is an append-only trail — one row per mutating request — that
    // records what each user changed and which signed credential authorized it
    // (`assertion_kid`/`assertion_jti`), so a change traces back to its source
    // even on a federated instance. `verified_via` distinguishes a fresh JWS
    // from a guest or an expired-while-offline assertion. The newest row for a
    // page is its "last edited by". Purely additive: an instance with nobody
    // signed in (guest-by-default) keeps working exactly as before — the log
    // just attributes its writes to a guest. `page_id` is intentionally NOT a
    // FK: the trail outlives the page (a delete is itself a logged event).
    name: '0009_provenance',
    statements: [
      `CREATE TABLE IF NOT EXISTS edit_log (
        id             UUID        PRIMARY KEY,
        page_id        UUID,
        author_subject TEXT        NOT NULL,
        author_issuer  TEXT        NOT NULL DEFAULT '',
        author_name    TEXT        NOT NULL DEFAULT '',
        verified_via   TEXT        NOT NULL,
        kind           TEXT        NOT NULL,
        assertion_kid  TEXT,
        assertion_jti  TEXT,
        summary        TEXT        NOT NULL DEFAULT '',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS edit_log_page_id_idx ON edit_log (page_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS edit_log_author_idx ON edit_log (author_subject, created_at DESC)',
    ],
  },
  {
    // Server-stamped author identity on the review layer (OB-165). The
    // suggestions/comments tables already carry `author_name` (a display label
    // the client supplies) + `author_kind` ('ai'|'human'); these add the
    // *verified* principal behind the write (subject/issuer + how it was
    // established), so review-layer authorship is as trustworthy as the edit
    // log. All nullable/additive: pre-multi-user rows simply have no identity.
    name: '0010_review_authors',
    statements: [
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_subject TEXT',
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_issuer TEXT',
      'ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS author_verified TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_subject TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_issuer TEXT',
      'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_verified TEXT',
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
