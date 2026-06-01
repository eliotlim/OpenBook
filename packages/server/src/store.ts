import {randomUUID} from 'node:crypto';
import postgres, {type Sql} from 'postgres';
import type {PageInput, PageMeta, PageSnapshot, StoredPage} from '@open-book/sdk';
import {runMigrations} from './migrations';

/** Raw row shape as returned by Postgres. */
interface PageRow {
  id: string;
  name: string | null;
  data?: PageSnapshot;
  created_at: Date;
  updated_at: Date;
}

const metaFromRow = (row: PageRow): PageMeta => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const pageFromRow = (row: PageRow): StoredPage => ({
  id: row.id,
  name: row.name,
  data: (row.data ?? {editorjs: {blocks: []}, values: [], names: []}) as PageSnapshot,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * The one and only OpenBook storage implementation: pages in Postgres.
 *
 * The embedded (desktop) and remote (server) modes are identical here — they
 * differ only in the connection URL passed to the constructor.
 */
export class PageStore {
  private readonly sql: Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {max: 10, onnotice: () => undefined});
  }

  /** Apply pending migrations. Idempotent. */
  async migrate(): Promise<void> {
    await runMigrations(this.sql);
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.sql.end();
  }

  /** List every page's metadata, most-recently-updated first. */
  async listPages(): Promise<PageMeta[]> {
    const rows = await this.sql<PageRow[]>`
      SELECT id, name, created_at, updated_at FROM pages ORDER BY updated_at DESC`;
    return rows.map(metaFromRow);
  }

  /** Fetch a single page by id, or `null` if it does not exist. */
  async getPage(id: string): Promise<StoredPage | null> {
    const rows = await this.sql<PageRow[]>`
      SELECT id, name, data, created_at, updated_at FROM pages WHERE id = ${id}`;
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Fetch a page by its (optional, unique) name. */
  async getPageByName(name: string): Promise<StoredPage | null> {
    const rows = await this.sql<PageRow[]>`
      SELECT id, name, data, created_at, updated_at FROM pages WHERE name = ${name}`;
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Create or update a page. Mints a UUID when `input.id` is absent. */
  async upsertPage(input: PageInput): Promise<StoredPage> {
    const id = input.id ?? randomUUID();
    const name = input.name ?? null;
    const rows = await this.sql<PageRow[]>`
      INSERT INTO pages (id, name, data, updated_at)
      VALUES (${id}, ${name}, ${this.sql.json(input.data as never)}, now())
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            data = EXCLUDED.data,
            updated_at = now()
      RETURNING id, name, data, created_at, updated_at`;
    return pageFromRow(rows[0]);
  }

  /** Delete a page. Returns `true` if a row was removed. */
  async deletePage(id: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM pages WHERE id = ${id}`;
    return result.count > 0;
  }
}
