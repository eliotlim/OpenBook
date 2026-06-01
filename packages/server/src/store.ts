import {randomUUID} from 'node:crypto';
import type {PageInput, PageMeta, PageSnapshot, StoredPage} from '@open-book/sdk';
import type {Db} from './db';
import {runMigrations} from './migrations';

/** Raw row shape returned by the database. */
interface PageRow {
  id: string;
  name: string | null;
  // JSONB comes back parsed (object) from some drivers and as a string from
  // others (e.g. over the wire), so accept both.
  data?: PageSnapshot | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const EMPTY_SNAPSHOT: PageSnapshot = {editorjs: {blocks: []}, values: [], names: []};

// Timestamps come back as Date (postgres) or ISO string (pglite); normalize.
const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

// JSONB may be parsed (object) or raw (string) depending on the driver.
const parseSnapshot = (value: PageSnapshot | string | null | undefined): PageSnapshot => {
  if (value == null) return EMPTY_SNAPSHOT;
  return typeof value === 'string' ? (JSON.parse(value) as PageSnapshot) : value;
};

const metaFromRow = (row: PageRow): PageMeta => ({
  id: row.id,
  name: row.name,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const pageFromRow = (row: PageRow): StoredPage => ({
  id: row.id,
  name: row.name,
  data: parseSnapshot(row.data),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

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

  /** List every page's metadata, most-recently-updated first. */
  async listPages(): Promise<PageMeta[]> {
    const rows = await this.db.query<PageRow>(
      'SELECT id, name, created_at, updated_at FROM pages ORDER BY updated_at DESC',
    );
    return rows.map(metaFromRow);
  }

  /** Fetch a single page by id, or `null` if it does not exist. */
  async getPage(id: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      'SELECT id, name, data, created_at, updated_at FROM pages WHERE id = $1',
      [id],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Fetch a page by its (optional, unique) name. */
  async getPageByName(name: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      'SELECT id, name, data, created_at, updated_at FROM pages WHERE name = $1',
      [name],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Create or update a page. Mints a UUID when `input.id` is absent. */
  async upsertPage(input: PageInput): Promise<StoredPage> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<PageRow>(
      `INSERT INTO pages (id, name, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             data = EXCLUDED.data,
             updated_at = now()
       RETURNING id, name, data, created_at, updated_at`,
      [id, input.name ?? null, JSON.stringify(input.data ?? EMPTY_SNAPSHOT)],
    );
    return pageFromRow(rows[0]);
  }

  /** Delete a page. Returns `true` if a row was removed. */
  async deletePage(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM pages WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }
}
