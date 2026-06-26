import {randomUUID} from './uuid';
import type {
  CommentInput,
  CommentRun,
  DatabaseInput,
  DatabaseRow,
  DatabaseSchema,
  DatabaseUpdate,
  ImportRequest,
  ImportResult,
  InstanceConfig,
  PageInput,
  PageMeta,
  PageSnapshot,
  Principal,
  RowInput,
  StoredComment,
  StoredDatabase,
  StoredEdit,
  StoredPage,
  StoredSuggestion,
  SuggestionInput,
  SuggestionStatus,
  SuggestionTarget,
  SuggestionUpdate,
  VerifiedVia,
} from '@book.dev/sdk';
import {DEFAULT_INSTANCE_CONFIG, emptyPageSnapshot, extractMentionIds, projectExports, propertiesReferencePage, remapBundle, stampSnapshotMtimes, type PluginPackage, type StoredPlugin} from '@book.dev/sdk';
import type {Db} from './dbCore';
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
  // Projected from `properties->>'sys_icon'` by the meta queries (PageMeta only).
  icon?: string | null;
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
  icon: row.icon ?? null,
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
    parentId: row.parent_id ?? null,
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
   * Embedded-mode (PGlite) self-maintenance: bound the WAL and reclaim dead
   * tuples. PGlite is PostgreSQL compiled to single-process WASM with **no
   * background workers** — no checkpointer, no autovacuum — so nothing advances
   * the checkpoint or vacuums unless explicitly asked (OB-164). Without this:
   *  - the WAL grows unbounded, so an unclean shutdown leaves no recent valid
   *    checkpoint → startup PANIC ("could not locate a valid checkpoint record");
   *  - `pages` accumulates the MVCC dead tuples left by save-on-edit `UPDATE`s →
   *    multi-GB heap bloat.
   * `CHECKPOINT` flushes + recycles WAL; `VACUUM (ANALYZE)` reclaims dead tuples
   * and refreshes the planner stats autovacuum would normally maintain. Real
   * Postgres does both itself, so the caller gates this to embedded mode.
   *
   * Both run as standalone statements — `VACUUM` cannot run inside a transaction
   * — so they go through plain `query`; the PGlite mutex still serializes them
   * against concurrent writers.
   */
  async maintain(): Promise<void> {
    await this.db.query('CHECKPOINT');
    await this.db.query('VACUUM (ANALYZE)');
  }

  /**
   * Force a WAL checkpoint. Run on graceful shutdown (embedded mode) so a hard
   * kill immediately after exit always has a recent on-disk checkpoint to
   * recover from. Cheaper than {@link maintain} (no vacuum), so it won't stall
   * close under load.
   */
  async checkpoint(): Promise<void> {
    await this.db.query('CHECKPOINT');
  }

  /** Current on-disk size of the database, in bytes. */
  async databaseSize(): Promise<number> {
    const rows = await this.db.query<{size: string | number}>(
      'SELECT pg_database_size(current_database()) AS size',
    );
    return Number(rows[0]?.size ?? 0);
  }

  /**
   * Heavy on-demand compaction (embedded PGlite). `VACUUM FULL` rewrites each
   * table to *physically* reclaim the dead-tuple bloat a plain `VACUUM` only
   * marks reusable — the one-shot tool for shrinking an already-bloated heap
   * (OB-164), versus the periodic {@link maintain} that keeps it flat. Bracketed
   * with `CHECKPOINT` so the WAL is flushed and recycled around the rewrite.
   *
   * `VACUUM FULL` takes an exclusive lock and, like all maintenance statements,
   * can't run inside a transaction — so it goes through plain `query`, and the
   * PGlite mutex serializes everything else against it for the duration. That's
   * why this is a user-initiated action (with a progress indicator), not a
   * background job. Returns the before/after on-disk size in bytes.
   */
  async compact(): Promise<{before: number; after: number}> {
    const before = await this.databaseSize();
    await this.db.query('CHECKPOINT');
    await this.db.query('VACUUM (FULL, ANALYZE)');
    await this.db.query('CHECKPOINT');
    const after = await this.databaseSize();
    return {before, after};
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
      `SELECT p.id, p.name, p.parent_id, p.deleted_at, p.created_at, p.updated_at, d.id AS hosted_database_id,
              (p.properties->>'sys_icon') AS icon
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

  /**
   * Re-import a page from the on-disk book mirror (OB-135/OB-136), with
   * **DB-wins** conflict handling (the DB is canonical; the disk is a derived
   * mirror). `base` is the DB `updatedAt` the file was rendered from (carried in
   * the file); `data` is the file's content.
   *
   *  - Page missing from the DB → recreate it from the file (a restored backup
   *    or a file dropped in) at the top level, keeping its id.
   *  - File content identical to the DB → `unchanged` (our own write-through
   *    echo, or an unmodified re-sync).
   *  - DB strictly newer than the file's base → **conflict**: never overwrite
   *    pglite; instead import the file as a new `"(conflicted copy <ts>)"` page
   *    so nothing is silently lost.
   *  - Otherwise (the file carries a newer/external edit, DB untouched since) →
   *    apply it to the existing page.
   */
  async importBookPage(
    record: {id: string; name: string | null; data: PageSnapshot},
    base: string,
    nowIso: string = new Date().toISOString(),
  ): Promise<{action: 'created' | 'updated' | 'conflict' | 'unchanged'; page: StoredPage}> {
    return this.db.begin(async (tx) => {
      const existingRows = await tx.query<PageRow>(
        `SELECT id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id
         FROM pages WHERE id = $1 AND deleted_at IS NULL`,
        [record.id],
      );

      // Not in the DB: recreate from the file (restored backup / dropped-in file).
      if (existingRows.length === 0) {
        const taken = new Set<string>();
        const name = record.name ? await freeName(tx, record.name, taken, 'imported') : null;
        const inserted = await tx.query<PageRow>(
          `INSERT INTO pages (id, name, data, position, updated_at)
           VALUES ($1, $2, $3::jsonb,
             (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE parent_id IS NULL), now())
           ON CONFLICT (id) DO NOTHING
           RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
             (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
          [record.id, name, JSON.stringify(record.data)],
        );
        // A trashed page with this id may exist (ON CONFLICT DO NOTHING returned
        // nothing) — fall through to a conflict copy rather than resurrect it.
        if (inserted.length > 0) return {action: 'created' as const, page: pageFromRow(inserted[0])};
      } else {
        const current = pageFromRow(existingRows[0]);
        // Identical content → nothing to do (our own mirror write-back, or an
        // unmodified re-sync). Compare the canonical JSON.
        if (JSON.stringify(current.data) === JSON.stringify(record.data)) {
          return {action: 'unchanged' as const, page: current};
        }
        // DB strictly newer than the file's base → conflict → DB wins.
        const dbNewer = current.updatedAt > base;
        if (!dbNewer) {
          const updated = await tx.query<PageRow>(
            `UPDATE pages SET data = $2::jsonb, updated_at = now() WHERE id = $1 AND deleted_at IS NULL
             RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
               (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
            [record.id, JSON.stringify(stampSnapshotMtimes(current.data, record.data, nowIso))],
          );
          return {action: 'updated' as const, page: pageFromRow(updated[0])};
        }
      }

      // Conflict (or a colliding-id trashed page): import the disk version as a
      // brand-new, suffixed page so the user can reconcile. Fresh id so it never
      // collides with the canonical row.
      const baseName = (record.name ?? 'Untitled').trim() || 'Untitled';
      const taken = new Set<string>();
      const name = await freeName(tx, `${baseName} (conflicted copy ${nowIso})`, taken, 'conflicted copy');
      const copy = await tx.query<PageRow>(
        `INSERT INTO pages (id, name, data, position, updated_at)
         VALUES ($1, $2, $3::jsonb,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE parent_id IS NULL), now())
         RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
        [randomUUID(), name, JSON.stringify(record.data)],
      );
      return {action: 'conflict' as const, page: pageFromRow(copy[0])};
    });
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
    // Stamp per-block mtimes relative to the page's prior content so an
    // unchanged block keeps its timestamp and a changed one is restamped — the
    // change signal the disk mirror, watcher, and conflict resolver read. The
    // read + write run in one transaction (serialized by the PGlite mutex) so a
    // concurrent save can't race the stamp.
    return this.db.begin(async (tx) => {
      const prior = await tx.query<PageRow>('SELECT data FROM pages WHERE id = $1', [id]);
      const priorData = prior.length > 0 ? parseSnapshot(prior[0].data) : null;
      const data = stampSnapshotMtimes(priorData, input.data ?? EMPTY_SNAPSHOT, new Date().toISOString());
      const rows = await tx.query<PageRow>(
        // A new page is appended to the bottom of its sibling group (one past the
        // current max position). Like `parent_id`, `position` is set only on
        // insert — a routine content save (ON CONFLICT) never reorders the page.
        //
        // The `WHERE` on DO UPDATE skips a no-op save: when the (re-stamped) name
        // and data are unchanged, re-saving would only leak a dead MVCC tuple —
        // pure bloat on PGlite, which has no autovacuum (OB-164). `IS DISTINCT
        // FROM` compares the *normalized* jsonb value, so a different key order or
        // whitespace alone doesn't count as a change. A skipped update also leaves
        // `updated_at` untouched, so the mirror/watcher don't see a phantom edit.
        `INSERT INTO pages (id, name, data, parent_id, position, updated_at)
         VALUES ($1, $2, $3::jsonb, $4,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE parent_id IS NOT DISTINCT FROM $4),
           now())
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               data = EXCLUDED.data,
               updated_at = now()
           WHERE pages.data IS DISTINCT FROM EXCLUDED.data
              OR pages.name IS DISTINCT FROM EXCLUDED.name
         RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
        [id, input.name ?? null, JSON.stringify(data), input.parentId ?? null],
      );
      // Empty result ⇒ the no-op `WHERE` skipped the write; the stored row is
      // already current, so return it unchanged.
      if (rows.length === 0) {
        const existing = await tx.query<PageRow>(
          `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.id = $1`,
          [id],
        );
        return pageFromRow(existing[0]);
      }
      return pageFromRow(rows[0]);
    });
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
              d.id AS hosted_database_id, (p.properties->>'sys_icon') AS icon
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
      `SELECT p.id, p.name, p.parent_id, p.deleted_at, p.created_at, p.updated_at, d.id AS hosted_database_id,
              (p.properties->>'sys_icon') AS icon
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
      `SELECT id, name, data, properties, parent_id, created_at, updated_at
       FROM pages WHERE database_id = $1 AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`,
      [databaseId],
    );
    return rows.map(rowFromPage);
  }

  /**
   * Create a row: a fresh page tagged with `database_id`, appended at the bottom
   * of the database's manual order. `input.parentId` nests it under another row
   * as a sub-item. Returns the page.
   */
  async createRow(databaseId: string, input: RowInput = {}): Promise<StoredPage> {
    const id = randomUUID();
    // A fresh row has no prior content, so every block is stamped "now".
    const data = stampSnapshotMtimes(null, input.data ?? emptyPageSnapshot(), new Date().toISOString());
    const rows = await this.db.query<PageRow>(
      `INSERT INTO pages (id, name, data, database_id, parent_id, properties, position, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $6, $5::jsonb,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE database_id = $4), now())
       RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at, NULL AS hosted_database_id`,
      [
        id,
        input.name ?? null,
        JSON.stringify(data),
        databaseId,
        JSON.stringify(input.properties ?? {}),
        input.parentId ?? null,
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

  // ── Plugins (installed extensions) ───────────────────────────────────────────

  async listPlugins(): Promise<StoredPlugin[]> {
    const rows = await this.db.query<PluginRow>(
      'SELECT id, manifest, files, signature, enabled, installed_at FROM plugins ORDER BY installed_at',
    );
    return rows.map(pluginFromRow);
  }

  async getPlugin(id: string): Promise<StoredPlugin | null> {
    const rows = await this.db.query<PluginRow>(
      'SELECT id, manifest, files, signature, enabled, installed_at FROM plugins WHERE id = $1',
      [id],
    );
    return rows.length > 0 ? pluginFromRow(rows[0]) : null;
  }

  /** Install or update a plugin (idempotent on id; updates re-enable). */
  async upsertPlugin(pkg: PluginPackage): Promise<StoredPlugin> {
    const rows = await this.db.query<PluginRow>(
      `INSERT INTO plugins (id, manifest, files, signature, enabled)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, TRUE)
       ON CONFLICT (id) DO UPDATE
         SET manifest = EXCLUDED.manifest,
             files = EXCLUDED.files,
             signature = EXCLUDED.signature,
             enabled = TRUE,
             installed_at = now()
       RETURNING id, manifest, files, signature, enabled, installed_at`,
      [pkg.manifest.id, JSON.stringify(pkg.manifest), JSON.stringify(pkg.files), pkg.signature ? JSON.stringify(pkg.signature) : null],
    );
    return pluginFromRow(rows[0]);
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<StoredPlugin | null> {
    const rows = await this.db.query<PluginRow>(
      `UPDATE plugins SET enabled = $2 WHERE id = $1
       RETURNING id, manifest, files, signature, enabled, installed_at`,
      [id, enabled],
    );
    return rows.length > 0 ? pluginFromRow(rows[0]) : null;
  }

  async removePlugin(id: string): Promise<boolean> {
    const rows = await this.db.query<{id: string}>('DELETE FROM plugins WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ── Suggestions + comments (the review layer) ────────────────────────────────

  /** A page's suggestions, newest first. Optionally filtered by status. */
  async listSuggestions(pageId: string, status?: SuggestionStatus): Promise<StoredSuggestion[]> {
    const rows = status
      ? await this.db.query<SuggestionRow>(
        `SELECT ${SUGGESTION_COLS} FROM suggestions WHERE page_id = $1 AND status = $2 ORDER BY created_at DESC`,
        [pageId, status],
      )
      : await this.db.query<SuggestionRow>(
        `SELECT ${SUGGESTION_COLS} FROM suggestions WHERE page_id = $1 ORDER BY created_at DESC`,
        [pageId],
      );
    return rows.map(suggestionFromRow);
  }

  async getSuggestion(id: string): Promise<StoredSuggestion | null> {
    const rows = await this.db.query<SuggestionRow>(
      `SELECT ${SUGGESTION_COLS} FROM suggestions WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? suggestionFromRow(rows[0]) : null;
  }

  async createSuggestion(input: SuggestionInput): Promise<StoredSuggestion> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<SuggestionRow>(
      `INSERT INTO suggestions
         (id, page_id, author_kind, author_name, kind, target, before_text, after_text, status, payload, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'open', $9::jsonb, now())
       RETURNING ${SUGGESTION_COLS}`,
      [
        id,
        input.pageId,
        input.authorKind,
        input.authorName,
        input.kind,
        JSON.stringify(input.target ?? {}),
        input.before ?? '',
        input.after ?? '',
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return suggestionFromRow(rows[0]);
  }

  async updateSuggestion(id: string, patch: SuggestionUpdate): Promise<StoredSuggestion | null> {
    const rows = await this.db.query<SuggestionRow>(
      `UPDATE suggestions
         SET status = COALESCE($2, status),
             updated_at = now()
       WHERE id = $1
       RETURNING ${SUGGESTION_COLS}`,
      [id, patch.status === undefined ? null : patch.status],
    );
    return rows.length > 0 ? suggestionFromRow(rows[0]) : null;
  }

  async deleteSuggestion(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM suggestions WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  /** A page's comments, oldest first (a thread reads top-to-bottom). */
  async listComments(pageId: string): Promise<StoredComment[]> {
    const rows = await this.db.query<CommentRowRecord>(
      `SELECT ${COMMENT_COLS} FROM comments WHERE page_id = $1 ORDER BY created_at ASC`,
      [pageId],
    );
    return rows.map(commentFromRow);
  }

  async createComment(input: CommentInput): Promise<StoredComment> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<CommentRowRecord>(
      `INSERT INTO comments (id, page_id, suggestion_id, block_id, parent_id, author_name, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING ${COMMENT_COLS}`,
      [
        id,
        input.pageId,
        input.suggestionId ?? null,
        input.blockId ?? null,
        input.parentId ?? null,
        input.authorName,
        JSON.stringify(input.body ?? []),
      ],
    );
    return commentFromRow(rows[0]);
  }

  async deleteComment(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM comments WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ── Multi-user: change provenance + instance policy (OB-165) ──────────────────

  /**
   * Append one change to the durable edit log, attributed to a verified
   * {@link Principal}. The author is always taken from the server-resolved
   * principal — never a client-sent field — so authorship can't be forged. The
   * newest row for a page is its "last edited by". Best-effort: callers log
   * after the mutation commits, so a lost log row never costs data.
   */
  async logEdit(entry: {pageId: string | null; author: Principal; kind: string; summary?: string}): Promise<void> {
    const a = entry.author;
    await this.db.query(
      `INSERT INTO edit_log
         (id, page_id, author_subject, author_issuer, author_name, verified_via, kind, assertion_kid, assertion_jti, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        entry.pageId,
        a.subject,
        a.issuer ?? '',
        a.name ?? '',
        a.verifiedVia,
        entry.kind,
        a.assertion?.kid ?? null,
        a.assertion?.jti ?? null,
        entry.summary ?? '',
      ],
    );
  }

  /** Read the edit log — a single page's history, or the whole instance's,
   *  newest first. */
  async listEdits(pageId?: string, limit = 100): Promise<StoredEdit[]> {
    const cap = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = pageId
      ? await this.db.query<EditRow>(
        `SELECT ${EDIT_COLS} FROM edit_log WHERE page_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [pageId, cap],
      )
      : await this.db.query<EditRow>(
        `SELECT ${EDIT_COLS} FROM edit_log ORDER BY created_at DESC LIMIT $1`,
        [cap],
      );
    return rows.map(editFromRow);
  }

  /** The instance's multi-user policy (guest gate + trusted issuers), with
   *  defaults filled in. Cheap — one settings row. */
  async getInstanceConfig(): Promise<InstanceConfig> {
    const rows = await this.db.query<{value: InstanceConfig | string}>(
      'SELECT value FROM settings WHERE key = \'instance\'',
    );
    const stored = rows.length > 0 ? parseJson<Partial<InstanceConfig>>(rows[0].value, {}) : {};
    return {...DEFAULT_INSTANCE_CONFIG, ...stored};
  }

  /** Shallow-merge a patch into the instance policy and persist it. */
  async updateInstanceConfig(patch: Partial<InstanceConfig>): Promise<InstanceConfig> {
    const next = {...(await this.getInstanceConfig()), ...patch};
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ('instance', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }
}

interface PluginRow {
  id: string;
  manifest: unknown;
  files: unknown;
  signature: unknown;
  enabled: boolean;
  installed_at: string | Date;
}

function pluginFromRow(row: PluginRow): StoredPlugin {
  return {
    manifest: row.manifest as StoredPlugin['manifest'],
    files: row.files as StoredPlugin['files'],
    signature: (row.signature as StoredPlugin['signature']) ?? undefined,
    enabled: row.enabled,
    installedAt: new Date(row.installed_at).toISOString(),
  };
}

// ── Suggestions + comments row mappers ───────────────────────────────────────

const SUGGESTION_COLS =
  'id, page_id, author_kind, author_name, kind, target, before_text, after_text, status, payload, created_at, updated_at';

interface SuggestionRow {
  id: string;
  page_id: string;
  author_kind: string;
  author_name: string;
  kind: string;
  target: SuggestionTarget | string | null;
  before_text: string;
  after_text: string;
  status: string;
  payload: Record<string, unknown> | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function suggestionFromRow(row: SuggestionRow): StoredSuggestion {
  return {
    id: row.id,
    pageId: row.page_id,
    authorKind: row.author_kind as StoredSuggestion['authorKind'],
    authorName: row.author_name,
    kind: row.kind as StoredSuggestion['kind'],
    target: parseJson<SuggestionTarget>(row.target, {}),
    before: row.before_text ?? '',
    after: row.after_text ?? '',
    status: row.status as StoredSuggestion['status'],
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const COMMENT_COLS = 'id, page_id, suggestion_id, block_id, parent_id, author_name, body, created_at';

interface CommentRowRecord {
  id: string;
  page_id: string;
  suggestion_id: string | null;
  block_id: string | null;
  parent_id: string | null;
  author_name: string;
  body: CommentRun[] | string | null;
  created_at: Date | string;
}

function commentFromRow(row: CommentRowRecord): StoredComment {
  return {
    id: row.id,
    pageId: row.page_id,
    suggestionId: row.suggestion_id ?? null,
    blockId: row.block_id ?? null,
    parentId: row.parent_id ?? null,
    authorName: row.author_name,
    body: parseJson<CommentRun[]>(row.body, []),
    createdAt: toIso(row.created_at),
  };
}

// ── Edit log row mapper ──────────────────────────────────────────────────────

const EDIT_COLS =
  'id, page_id, author_subject, author_issuer, author_name, verified_via, kind, assertion_kid, assertion_jti, summary, created_at';

interface EditRow {
  id: string;
  page_id: string | null;
  author_subject: string;
  author_issuer: string;
  author_name: string;
  verified_via: string;
  kind: string;
  assertion_kid: string | null;
  assertion_jti: string | null;
  summary: string;
  created_at: Date | string;
}

function editFromRow(row: EditRow): StoredEdit {
  return {
    id: row.id,
    pageId: row.page_id ?? null,
    authorSubject: row.author_subject,
    authorIssuer: row.author_issuer ?? '',
    authorName: row.author_name ?? '',
    verifiedVia: row.verified_via as VerifiedVia,
    kind: row.kind,
    assertionKid: row.assertion_kid ?? null,
    assertionJti: row.assertion_jti ?? null,
    summary: row.summary ?? '',
    createdAt: toIso(row.created_at),
  };
}
