import {randomUUID} from 'node:crypto';
import type {
  DatabaseInput,
  DatabaseRow,
  DatabaseSchema,
  DatabaseUpdate,
  PageInput,
  PageMeta,
  PageSnapshot,
  RowInput,
  StoredDatabase,
  StoredPage,
} from '@open-book/sdk';
import {emptyPageSnapshot, projectExports} from '@open-book/sdk';
import type {Db} from './db';
import {runMigrations} from './migrations';

/** Raw row shape returned by the database. */
interface PageRow {
  id: string;
  name: string | null;
  // JSONB comes back parsed (object) from some drivers and as a string from
  // others (e.g. over the wire), so accept both.
  data?: PageSnapshot | string | null;
  database_id?: string | null;
  parent_id?: string | null;
  properties?: Record<string, unknown> | string | null;
  // Populated by a LEFT JOIN onto `databases` — the database this page hosts.
  hosted_database_id?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Raw row shape for the `databases` table. */
interface DatabaseRowRecord {
  id: string;
  page_id: string;
  name: string | null;
  schema?: DatabaseSchema | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const EMPTY_SNAPSHOT: PageSnapshot = {editorjs: {blocks: []}, values: [], names: []};
const EMPTY_SCHEMA: DatabaseSchema = {properties: [], views: []};

// Timestamps come back as Date (postgres) or ISO string (pglite); normalize.
const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

// JSONB may be parsed (object) or raw (string) depending on the driver.
const parseJson = <T>(value: T | string | null | undefined, fallback: T): T => {
  if (value == null) return fallback;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
};

const parseSnapshot = (value: PageSnapshot | string | null | undefined): PageSnapshot =>
  parseJson<PageSnapshot>(value, EMPTY_SNAPSHOT);

const metaFromRow = (row: PageRow): PageMeta => ({
  id: row.id,
  name: row.name,
  hostedDatabaseId: row.hosted_database_id ?? null,
  parentId: row.parent_id ?? null,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const pageFromRow = (row: PageRow): StoredPage => ({
  id: row.id,
  name: row.name,
  data: parseSnapshot(row.data),
  hostedDatabaseId: row.hosted_database_id ?? null,
  databaseId: row.database_id ?? null,
  parentId: row.parent_id ?? null,
  properties: parseJson<Record<string, unknown>>(row.properties, {}),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const databaseFromRow = (row: DatabaseRowRecord): StoredDatabase => ({
  id: row.id,
  pageId: row.page_id,
  name: row.name,
  schema: parseJson<DatabaseSchema>(row.schema, EMPTY_SCHEMA),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const rowFromPage = (row: PageRow): DatabaseRow => {
  const data = parseSnapshot(row.data);
  return {
    id: row.id,
    name: row.name,
    properties: parseJson<Record<string, unknown>>(row.properties, {}),
    exports: projectExports(data),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
};

// Column list for a full page fetch, including the hosted-database join.
const PAGE_COLUMNS =
  'p.id, p.name, p.data, p.database_id, p.parent_id, p.properties, p.created_at, p.updated_at, ' +
  'd.id AS hosted_database_id';
const PAGE_FROM = 'pages p LEFT JOIN databases d ON d.page_id = p.id';

/**
 * The one and only OpenBook storage implementation: pages in Postgres. The
 * embedded (desktop) and remote (server) modes differ only in the {@link Db}
 * backend passed in.
 */
export class PageStore {
  constructor(private readonly db: Db) {}

  /** Apply pending migrations. Idempotent. */
  async migrate(): Promise<void> {
    await runMigrations(this.db);
  }

  /** Release the underlying database. */
  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * List page metadata, most-recently-updated first. Database *rows* (pages
   * tagged with a `database_id`) are excluded so the sidebar shows only
   * top-level pages; rows are listed through the database APIs instead. Each
   * entry carries `hostedDatabaseId` when the page hosts a database.
   */
  async listPages(): Promise<PageMeta[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT p.id, p.name, p.parent_id, p.created_at, p.updated_at, d.id AS hosted_database_id
       FROM ${PAGE_FROM}
       WHERE p.database_id IS NULL
       ORDER BY p.updated_at DESC`,
    );
    return rows.map(metaFromRow);
  }

  /** Fetch a single page by id, or `null` if it does not exist. */
  async getPage(id: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.id = $1`,
      [id],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Fetch a page by its (optional, unique) name. */
  async getPageByName(name: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.name = $1`,
      [name],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /**
   * Create or update a page. Mints a UUID when `input.id` is absent. `parent_id`
   * is written only on insert (a `parentId` in the payload nests a *new* page);
   * `database_id` and manual `properties` are owned by the database row APIs.
   * On update only `name`/`data` change, so a routine content save never
   * clobbers a page's parent, database membership, or properties.
   */
  async upsertPage(input: PageInput): Promise<StoredPage> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<PageRow>(
      `INSERT INTO pages (id, name, data, parent_id, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             data = EXCLUDED.data,
             updated_at = now()
       RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
         (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
      [id, input.name ?? null, JSON.stringify(input.data ?? EMPTY_SNAPSHOT), input.parentId ?? null],
    );
    return pageFromRow(rows[0]);
  }

  /** Update only a page's name, leaving its data untouched. */
  async renamePage(id: string, name: string | null): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `UPDATE pages SET name = $2, updated_at = now() WHERE id = $1
       RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
         (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
      [id, name],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Delete a page. Returns `true` if a row was removed. */
  async deletePage(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM pages WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ── Databases ──────────────────────────────────────────────────────────────

  /**
   * Create a database owned by an existing host page (1:1). The host page keeps
   * its own content; this only records the database definition and links it.
   */
  async createDatabase(input: DatabaseInput): Promise<StoredDatabase> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<DatabaseRowRecord>(
      `INSERT INTO databases (id, page_id, name, schema, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       RETURNING id, page_id, name, schema, created_at, updated_at`,
      [id, input.pageId, input.name ?? null, JSON.stringify(input.schema ?? EMPTY_SCHEMA)],
    );
    return databaseFromRow(rows[0]);
  }

  /** Fetch a database by id, or `null` if it does not exist. */
  async getDatabase(id: string): Promise<StoredDatabase | null> {
    const rows = await this.db.query<DatabaseRowRecord>(
      'SELECT id, page_id, name, schema, created_at, updated_at FROM databases WHERE id = $1',
      [id],
    );
    return rows.length > 0 ? databaseFromRow(rows[0]) : null;
  }

  /** Fetch the database hosted by a page, or `null` if the page hosts none. */
  async getDatabaseByPage(pageId: string): Promise<StoredDatabase | null> {
    const rows = await this.db.query<DatabaseRowRecord>(
      'SELECT id, page_id, name, schema, created_at, updated_at FROM databases WHERE page_id = $1',
      [pageId],
    );
    return rows.length > 0 ? databaseFromRow(rows[0]) : null;
  }

  /** Update a database's name and/or schema. Only provided fields change. */
  async updateDatabase(id: string, patch: DatabaseUpdate): Promise<StoredDatabase | null> {
    const rows = await this.db.query<DatabaseRowRecord>(
      `UPDATE databases
         SET name   = COALESCE($2, name),
             schema = COALESCE($3::jsonb, schema),
             updated_at = now()
       WHERE id = $1
       RETURNING id, page_id, name, schema, created_at, updated_at`,
      [
        id,
        patch.name === undefined ? null : patch.name,
        patch.schema === undefined ? null : JSON.stringify(patch.schema),
      ],
    );
    return rows.length > 0 ? databaseFromRow(rows[0]) : null;
  }

  /** Delete a database and (by cascade) all of its row pages. */
  async deleteDatabase(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM databases WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ── Database rows (pages tagged with a database_id) ──────────────────────────

  /**
   * List a database's rows, most-recently-updated first, projected for table/
   * list rendering: page title + manual `properties` + `exports` (named
   * reactive cell values pulled from each row page's snapshot).
   */
  async listRows(databaseId: string): Promise<DatabaseRow[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT id, name, data, properties, created_at, updated_at
       FROM pages WHERE database_id = $1 ORDER BY updated_at DESC`,
      [databaseId],
    );
    return rows.map(rowFromPage);
  }

  /** Create a row: a fresh page tagged with `database_id`. Returns the page. */
  async createRow(databaseId: string, input: RowInput = {}): Promise<StoredPage> {
    const id = randomUUID();
    const rows = await this.db.query<PageRow>(
      `INSERT INTO pages (id, name, data, database_id, properties, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, now())
       RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at, NULL AS hosted_database_id`,
      [
        id,
        input.name ?? null,
        JSON.stringify(input.data ?? emptyPageSnapshot()),
        databaseId,
        JSON.stringify(input.properties ?? {}),
      ],
    );
    return pageFromRow(rows[0]);
  }

  /**
   * Update a row's title and/or manual property values without touching its
   * document content. Returns the projected row, or `null` if it does not
   * belong to the given database.
   */
  async updateRow(
    databaseId: string,
    rowId: string,
    patch: {name?: string | null; properties?: Record<string, unknown>},
  ): Promise<DatabaseRow | null> {
    const rows = await this.db.query<PageRow>(
      `UPDATE pages
         SET name = CASE WHEN $3 THEN $4 ELSE name END,
             properties = COALESCE($5::jsonb, properties),
             updated_at = now()
       WHERE id = $1 AND database_id = $2
       RETURNING id, name, data, properties, created_at, updated_at`,
      [
        rowId,
        databaseId,
        patch.name !== undefined,
        patch.name ?? null,
        patch.properties === undefined ? null : JSON.stringify(patch.properties),
      ],
    );
    return rows.length > 0 ? rowFromPage(rows[0]) : null;
  }
}
