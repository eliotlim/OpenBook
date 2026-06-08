import {randomUUID} from 'node:crypto';
import type {
  DatabaseInput,
  DatabaseRow,
  DatabaseSchema,
  DatabaseUpdate,
  ImportRequest,
  ImportResult,
  PageInput,
  PageMeta,
  PageSnapshot,
  RowInput,
  StoredDatabase,
  StoredPage,
} from '@open-book/sdk';
import {emptyPageSnapshot, extractMentionIds, projectExports, propertiesReferencePage, remapBundle} from '@open-book/sdk';
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
  // Set when the page is in the trash (soft-deleted); null for live pages.
  deleted_at?: Date | string | null;
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

// Nullable timestamp (e.g. `deleted_at`): normalize to ISO or null.
const toIsoOrNull = (value: Date | string | null | undefined): string | null =>
  value == null ? null : toIso(value);

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
  deletedAt: toIsoOrNull(row.deleted_at),
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
  deletedAt: toIsoOrNull(row.deleted_at),
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

/**
 * Resolve a page name that is free among *live* pages (and not already claimed
 * by `taken` in the current batch), appending `" (<label>)"` — then
 * `" (<label> 2)"`, etc. — until it no longer collides. `excludeId` ignores one
 * page's own row (so an overwrite of the same page keeps its name). Used by
 * restore (`label='restored'`) and backup import (`label='imported'`).
 */
const freeName = async (
  tx: Db,
  base: string,
  taken: Set<string>,
  label = 'restored',
  excludeId?: string,
): Promise<string> => {
  const collides = async (candidate: string): Promise<boolean> => {
    if (taken.has(candidate)) return true;
    const rows = excludeId
      ? await tx.query('SELECT 1 FROM pages WHERE name = $1 AND deleted_at IS NULL AND id <> $2 LIMIT 1', [candidate, excludeId])
      : await tx.query('SELECT 1 FROM pages WHERE name = $1 AND deleted_at IS NULL LIMIT 1', [candidate]);
    return rows.length > 0;
  };
  if (!(await collides(base))) return base;
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${base} (${label})` : `${base} (${label} ${n})`;
    if (!(await collides(candidate))) return candidate;
  }
};

// Column list for a full page fetch, including the hosted-database join.
const PAGE_COLUMNS =
  'p.id, p.name, p.data, p.database_id, p.parent_id, p.properties, p.deleted_at, p.created_at, p.updated_at, ' +
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
   * List page metadata in sidebar order (`position` ascending within each
   * sibling group; `created_at` breaks ties). Database *rows* (pages tagged
   * with a `database_id`) are excluded so the sidebar shows only top-level
   * pages; rows are listed through the database APIs instead. Each entry
   * carries `hostedDatabaseId` when the page hosts a database. Because the list
   * is position-ordered, `buildTree` (UI) yields each parent's children in
   * their manual order.
   */
  async listPages(): Promise<PageMeta[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT p.id, p.name, p.parent_id, p.deleted_at, p.created_at, p.updated_at, d.id AS hosted_database_id
       FROM ${PAGE_FROM}
       WHERE p.database_id IS NULL AND p.deleted_at IS NULL
       ORDER BY p.position ASC, p.created_at ASC`,
    );
    return rows.map(metaFromRow);
  }

  // ── Whole-space backup ───────────────────────────────────────────────────────

  /** Export every live page (full data, nesting, database membership) + every
   *  database — the entire workspace as one bundle. */
  async exportAll(): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}> {
    const pageRows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.deleted_at IS NULL ORDER BY p.created_at ASC`,
    );
    const dbRows = await this.db.query<DatabaseRowRecord>(
      'SELECT id, page_id, name, schema, created_at, updated_at FROM databases',
    );
    return {pages: pageRows.map(pageFromRow), databases: dbRows.map(databaseFromRow)};
  }

  /**
   * Restore a backup, transactionally. `copy` (default) imports the pages/
   * databases as fresh copies — new ids (via {@link remapBundle}), names suffixed
   * `" (imported)"` on clash, appended below existing pages. `overwrite` upserts
   * by id, replacing pages in place. Returns counts + the old→new id map.
   */
  async importBundle(req: ImportRequest): Promise<ImportResult> {
    return req.mode === 'overwrite'
      ? this.importOverwrite(req.pages, req.databases)
      : this.importCopy(req.pages, req.databases);
  }

  private async importCopy(pages: StoredPage[], databases: StoredDatabase[]): Promise<ImportResult> {
    const {pages: rp, databases: rd, idMap} = remapBundle(pages, databases, randomUUID);
    let renamed = 0;
    await this.db.begin(async (tx) => {
      const taken = new Set<string>();
      const names = new Map<string, string | null>();
      for (const p of rp) {
        if (!p.name) {
          names.set(p.id, null);
          continue;
        }
        const free = await freeName(tx, p.name, taken, 'imported');
        if (free !== p.name) renamed += 1;
        taken.add(free);
        names.set(p.id, free);
      }
      // Insert pages first (parent_id/database_id deferred so the FKs resolve).
      let i = 0;
      for (const p of rp) {
        await tx.query(
          `INSERT INTO pages (id, name, data, properties, position, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())`,
          [p.id, names.get(p.id) ?? null, JSON.stringify(p.data), JSON.stringify(p.properties ?? {}), 1_000_000 + i, p.createdAt],
        );
        i += 1;
      }
      for (const d of rd) {
        await tx.query(
          'INSERT INTO databases (id, page_id, name, schema, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())',
          [d.id, d.pageId, d.name, JSON.stringify(d.schema)],
        );
      }
      for (const p of rp) {
        if (p.parentId || p.databaseId) {
          await tx.query('UPDATE pages SET parent_id = $2, database_id = $3 WHERE id = $1', [p.id, p.parentId, p.databaseId]);
        }
      }
    });
    return {created: rp.length, overwritten: 0, renamed, idMap};
  }

  private async importOverwrite(pages: StoredPage[], databases: StoredDatabase[]): Promise<ImportResult> {
    let created = 0;
    let overwritten = 0;
    const idMap: Record<string, string> = {};
    await this.db.begin(async (tx) => {
      const taken = new Set<string>();
      for (const p of pages) {
        idMap[p.id] = p.id;
        const existing = await tx.query<{id: string}>('SELECT id FROM pages WHERE id = $1', [p.id]);
        if (existing.length > 0) overwritten += 1;
        else created += 1;
        // Keep the page's own name; suffix only if a *different* live page holds it.
        const name = p.name ? await freeName(tx, p.name, taken, 'imported', p.id) : null;
        if (name) taken.add(name);
        await tx.query(
          `INSERT INTO pages (id, name, data, properties, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, data = EXCLUDED.data, properties = EXCLUDED.properties,
             deleted_at = NULL, updated_at = now()`,
          [p.id, name, JSON.stringify(p.data), JSON.stringify(p.properties ?? {}), p.createdAt],
        );
      }
      for (const d of databases) {
        await tx.query(
          `INSERT INTO databases (id, page_id, name, schema, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET page_id = EXCLUDED.page_id, name = EXCLUDED.name, schema = EXCLUDED.schema, updated_at = now()`,
          [d.id, d.pageId, d.name, JSON.stringify(d.schema)],
        );
      }
      for (const p of pages) {
        await tx.query('UPDATE pages SET parent_id = $2, database_id = $3 WHERE id = $1', [p.id, p.parentId, p.databaseId]);
      }
    });
    return {created, overwritten, renamed: 0, idMap};
  }

  /** Fetch a single (live, non-trashed) page by id, or `null`. */
  async getPage(id: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id],
    );
    return rows.length > 0 ? pageFromRow(rows[0]) : null;
  }

  /** Fetch a (live, non-trashed) page by its (optional, unique) name. */
  async getPageByName(name: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.name = $1 AND p.deleted_at IS NULL`,
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
      // A new page is appended to the bottom of its sibling group (one past the
      // current max position). Like `parent_id`, `position` is set only on
      // insert — a routine content save (ON CONFLICT) never reorders the page.
      `INSERT INTO pages (id, name, data, parent_id, position, updated_at)
       VALUES ($1, $2, $3::jsonb, $4,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE parent_id IS NOT DISTINCT FROM $4),
         now())
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

  /**
   * Move a page within the sidebar tree: re-parent it to `parentId` (`null` =
   * top level) and renumber `orderedIds` — the full ordered list of sibling ids
   * under that parent, including this page — to sequential positions. Rejects a
   * move that would create a cycle (the new parent is the page itself or one of
   * its descendants) by returning `null`; also returns `null` when the page is
   * missing. Runs in one transaction so the tree never observes a half-move.
   */
  async movePage(
    id: string,
    parentId: string | null,
    orderedIds: string[],
  ): Promise<StoredPage | null> {
    const ok = await this.db.begin(async (tx) => {
      const exists = await tx.query<{id: string}>('SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (exists.length === 0) return false;

      if (parentId !== null) {
        // The new parent must not be the page itself or any of its descendants,
        // or the tree would form a cycle.
        const cycle = await tx.query<{id: string}>(
          `WITH RECURSIVE subtree AS (
             SELECT id FROM pages WHERE id = $1
             UNION ALL
             SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
           )
           SELECT id FROM subtree WHERE id = $2`,
          [id, parentId],
        );
        if (cycle.length > 0) return false;
      }

      await tx.query('UPDATE pages SET parent_id = $2, updated_at = now() WHERE id = $1', [id, parentId]);
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.query('UPDATE pages SET position = $2 WHERE id = $1', [orderedIds[i], i]);
      }
      return true;
    });
    return ok ? this.getPage(id) : null;
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

  /**
   * Shallow-merge structured property values into a page's `properties` (jsonb
   * `||`), leaving its document content and any unmentioned properties intact.
   * This is how a standalone page's owner/verification are set — database rows
   * still go through {@link updateRow}. Returns the updated page, or `null` if
   * it's missing.
   */
  async setPageProperties(id: string, patch: Record<string, unknown>): Promise<StoredPage | null> {
    // Read-merge-write in a transaction. We merge in JS and write the whole
    // object with a plain `$2::jsonb` replace (portable across the embedded and
    // wire-protocol PGlite backends, unlike the jsonb `||` merge operator).
    return this.db.begin(async (tx) => {
      const current = await tx.query<PageRow>(
        'SELECT properties FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (current.length === 0) return null;
      const merged = {...parseJson<Record<string, unknown>>(current[0].properties, {}), ...patch};
      const rows = await tx.query<PageRow>(
        `UPDATE pages
           SET properties = $2::jsonb, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
        [id, JSON.stringify(merged)],
      );
      return rows.length > 0 ? pageFromRow(rows[0]) : null;
    });
  }

  /**
   * The pages that link to `id` — its backlinks. A page links here if its
   * document holds an inline mention anchor referencing `id`, *or* its stored
   * properties reference `id` (a `relation`). A `LIKE` prefilter (over document
   * + properties) narrows the scan; {@link extractMentionIds} /
   * {@link propertiesReferencePage} then confirm a real reference so the id
   * appearing elsewhere doesn't count. Most-recently-updated first; excludes the
   * page itself.
   */
  async listBacklinks(id: string): Promise<PageMeta[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT p.id, p.name, p.parent_id, p.properties, p.deleted_at, p.created_at, p.updated_at, p.data,
              d.id AS hosted_database_id
         FROM pages p LEFT JOIN databases d ON d.page_id = p.id
        WHERE p.deleted_at IS NULL AND p.id <> $1
          AND (p.data::text LIKE $2 OR p.properties::text LIKE $2)
        ORDER BY p.updated_at DESC`,
      [id, `%${id}%`],
    );
    return rows
      .filter(
        (row) =>
          extractMentionIds(parseSnapshot(row.data)).includes(id) ||
          propertiesReferencePage(parseJson<Record<string, unknown>>(row.properties, {}), id),
      )
      .map(metaFromRow);
  }

  /**
   * Soft-delete a page: move it (and its whole `parent_id` subtree) to the
   * trash by stamping `deleted_at`, instead of removing the rows. All affected
   * rows get the same timestamp so {@link restorePage} can bring back exactly
   * the subtree that was deleted together. Returns `true` if anything was newly
   * trashed (a no-op when the page is missing or already trashed). The page's
   * hosted database and its rows are left in place; they ride along with the
   * host on restore and are removed by the FK cascade when it's finally purged.
   */
  async deletePage(id: string): Promise<boolean> {
    const rows = await this.db.query<{id: string}>(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM pages WHERE id = $1
         UNION ALL
         SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       )
       UPDATE pages SET deleted_at = now()
       WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL
       RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Restore a trashed page and the descendants that were trashed together with
   * it (matched by the shared `deleted_at` timestamp — a child trashed in a
   * separate, earlier operation stays in the trash). Returns the restored page,
   * or `null` if it was not in the trash.
   *
   * A page's name can be reused while it sits in the trash, so a restore can
   * collide with the unique-name index. Rather than fail, the restored page is
   * given a `" (restored)"` suffix to make its name free again.
   */
  async restorePage(id: string): Promise<StoredPage | null> {
    const ok = await this.db.begin(async (tx) => {
      const root = await tx.query<{deleted_at: Date | string | null}>(
        'SELECT deleted_at FROM pages WHERE id = $1',
        [id],
      );
      if (root.length === 0 || root[0].deleted_at == null) return false;

      // The subtree trashed together with the root (same `deleted_at`). All of
      // these rows are still trashed at this point, so the collision check below
      // (against live pages) naturally ignores them.
      const subtree = await tx.query<{id: string; name: string | null}>(
        `WITH RECURSIVE subtree AS (
           SELECT id, name FROM pages WHERE id = $1
           UNION ALL
           SELECT p.id, p.name FROM pages p JOIN subtree s ON p.parent_id = s.id
           WHERE p.deleted_at = (SELECT deleted_at FROM pages WHERE id = $1)
         )
         SELECT id, name FROM subtree`,
        [id],
      );

      const assigned = new Set<string>();
      for (const row of subtree) {
        const name = row.name ? await freeName(tx, row.name, assigned) : null;
        if (name) assigned.add(name);
        await tx.query('UPDATE pages SET name = $2, deleted_at = NULL, updated_at = now() WHERE id = $1', [
          row.id,
          name,
        ]);
      }
      return true;
    });
    return ok ? this.getPage(id) : null;
  }

  /**
   * List the trash: trashed pages whose parent isn't itself trashed (the roots
   * of each deleted subtree), most-recently-deleted first. A row deleted on its
   * own appears here (it can be restored back into its database), but rows whose
   * host page was deleted do not — they ride along with the host and reappear
   * when it is restored.
   */
  async listTrash(): Promise<PageMeta[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT p.id, p.name, p.parent_id, p.deleted_at, p.created_at, p.updated_at, d.id AS hosted_database_id
       FROM pages p
       LEFT JOIN databases d ON d.page_id = p.id
       LEFT JOIN pages par ON par.id = p.parent_id
       WHERE p.deleted_at IS NOT NULL
         AND (p.parent_id IS NULL OR par.deleted_at IS NULL)
       ORDER BY p.deleted_at DESC`,
    );
    return rows.map(metaFromRow);
  }

  /** Permanently delete a single trashed page (and, by cascade, its subtree,
   *  hosted database, and rows). Returns `true` if a trashed row was removed. */
  async purgePage(id: string): Promise<boolean> {
    const rows = await this.db.query(
      'DELETE FROM pages WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id',
      [id],
    );
    return rows.length > 0;
  }

  /** Permanently delete everything currently in the trash. Returns the count of
   *  directly-trashed pages removed (cascaded descendants aren't counted). */
  async emptyTrash(): Promise<number> {
    const rows = await this.db.query<{id: string}>(
      'DELETE FROM pages WHERE deleted_at IS NOT NULL RETURNING id',
    );
    return rows.length;
  }

  /**
   * The cleanup job: permanently delete trashed pages whose `deleted_at` is
   * older than `retentionMs`. `retentionMs <= 0` purges the whole trash at the
   * next sweep (no retention). Returns the count of directly-purged pages.
   */
  async purgeExpired(retentionMs: number): Promise<number> {
    const rows = await this.db.query<{id: string}>(
      `DELETE FROM pages
       WHERE deleted_at IS NOT NULL
         AND deleted_at <= now() - ($1::bigint * interval '1 millisecond')
       RETURNING id`,
      [Math.max(0, Math.trunc(retentionMs))],
    );
    return rows.length;
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
   * List a database's rows in manual order, projected for table/list rendering:
   * page title + manual `properties` + `exports` (named reactive cell values
   * pulled from each row page's snapshot). Ordered by `position` (set on insert
   * and rewritten by {@link reorderRows}), `created_at` breaking ties — so a
   * routine cell edit never reshuffles the list (unlike an updated-at order).
   */
  async listRows(databaseId: string): Promise<DatabaseRow[]> {
    const rows = await this.db.query<PageRow>(
      `SELECT id, name, data, properties, created_at, updated_at
       FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      [databaseId],
    );
    return rows.map(rowFromPage);
  }

  /** Create a row: a fresh page tagged with `database_id`, appended at the
   *  bottom of the database's manual order. Returns the page. */
  async createRow(databaseId: string, input: RowInput = {}): Promise<StoredPage> {
    const id = randomUUID();
    const rows = await this.db.query<PageRow>(
      `INSERT INTO pages (id, name, data, database_id, properties, position, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE database_id = $4), now())
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
   * Set the manual order of a database's rows. `orderedIds` is the full list of
   * its row ids in the desired order; each is renumbered to its index. Runs in
   * one transaction so the list never observes a half-reorder. Ids not belonging
   * to the database are ignored. Returns `true` once applied.
   */
  async reorderRows(databaseId: string, orderedIds: string[]): Promise<boolean> {
    await this.db.begin(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.query('UPDATE pages SET position = $3 WHERE id = $1 AND database_id = $2', [
          orderedIds[i],
          databaseId,
          i,
        ]);
      }
    });
    return true;
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
       WHERE id = $1 AND database_id = $2 AND deleted_at IS NULL
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
