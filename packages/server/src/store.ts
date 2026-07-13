import {HTTPException} from 'hono/http-exception';
import {randomUUID} from './uuid';
import type {
  AccessCtx,
  AclEntry,
  AclLevel,
  AgentTokenMeta,
  AgentTokenScope,
  BackupConfig,
  CommentInput,
  CommentRun,
  DatabaseInput,
  DatabaseRow,
  DatabaseSchema,
  DatabaseUpdate,
  ImportRequest,
  ImportResult,
  EffectiveRole,
  InstanceConfig,
  Member,
  MemberRole,
  MemberSource,
  MemberStatus,
  PageAcl,
  PageInput,
  PageMeta,
  PageSnapshot,
  PageVisibility,
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
import {authorize, dateStart, DEFAULT_ACCOUNT_URL, DEFAULT_BACKUP_CONFIG, DEFAULT_INSTANCE_CONFIG, emptyPageSnapshot, extractMentionIds, isEmailAuthoritative, latestSnapshotAuthor, parseDay, projectExports, propertiesReferencePage, remapBundle, resolveAutoExpiry, stampSnapshotAuthors, stampSnapshotAuthorsPerBlock, stampSnapshotMtimes, verifiedSubject, type Decision, type EffectiveVisibility, type PluginPackage, type StoredPlugin} from '@book.dev/sdk';
import type {Db} from './dbCore';
import type {AgentTokenRow} from './agentTokens';
import {runMigrations} from './migrations';

/**
 * The `settings` key holding `{databaseId, hostPageId}` for the server-managed AI
 * usage DB (C1). Mirrors `USAGE_DB_KEY` in `./ai/usage`, duplicated here on purpose:
 * `store.ts` is bundled into `@book.dev/server/browser` (which must carry NO Node
 * imports), and `./ai/usage` transitively pulls in `./ai/providers` → `node:*`. The
 * import-overwrite guard test keeps the two literals in sync.
 */
const USAGE_DB_SETTING_KEY = 'aiUsageDb';

/**
 * Thrown by {@link PageStore.putAsset} when storing a NEW asset would push the
 * instance's total asset bytes past the configured storage budget (Assets A6).
 * A byte-identical re-upload of already-stored content never throws — it adds no
 * bytes (content-addressed dedup). The upload route maps this to a friendly 507
 * (Insufficient Storage). Carries the numbers for a useful message/log.
 */
export class AssetBudgetError extends Error {
  constructor(
    readonly currentBytes: number,
    readonly assetBytes: number,
    readonly budgetBytes: number,
  ) {
    super(
      `asset storage budget exceeded: storing ${assetBytes} more byte(s) would exceed the ` +
        `${budgetBytes}-byte budget (currently ${currentBytes} byte(s) stored)`,
    );
    this.name = 'AssetBudgetError';
  }
}

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

// One row of the `agent_tokens` table, as read for the redacted management view
// (the `token_hash` column is deliberately never selected into it).
interface AgentTokenDbRow {
  id: string;
  name: string;
  preview: string;
  subject: string;
  issuer: string;
  scope: string;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
}

const agentTokenMetaFromRow = (row: AgentTokenDbRow): AgentTokenMeta => ({
  id: row.id,
  name: row.name,
  scope: row.scope as AgentTokenScope,
  subject: row.subject,
  issuer: row.issuer,
  createdBy: row.created_by,
  createdAt: toIso(row.created_at),
  expiresAt: toIsoOrNull(row.expires_at),
  lastUsedAt: toIsoOrNull(row.last_used_at),
  preview: row.preview,
  revoked: row.revoked_at != null,
});

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
 * page's own row (so an overwrite of the same page keeps its name). Names are
 * not unique (migration 0015); this is a courtesy disambiguator for backup
 * import (`label='imported'`) and the mirror's conflict copies
 * (`label='conflicted copy'`), where two identically-named pages would be
 * indistinguishable to the user.
 */
const freeName = async (
  tx: Db,
  base: string,
  taken: Set<string>,
  label: string,
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

/**
 * Strip any trailing `(conflicted copy …)` suffix(es) from a page name (OB-241).
 * A conflict-of-conflict (the owner's in-the-wild case: a copy's OWN mirror file
 * diverges) would otherwise mint `X (conflicted copy T1) (conflicted copy T2)` and
 * deep-chain on every cycle. By re-deriving from the ORIGINAL base name and
 * re-adding exactly one level, the chain is capped at depth 1. This only shapes
 * the *new* copy's name — idempotent reuse keys on the full stored
 * `name LIKE '% (conflicted copy%'` + `data` (see {@link PageStore.importBookPage}),
 * so reuse semantics are unaffected by how the new name is derived. The
 * `[^()]*` class can't span nested parens, so an unrelated `(parenthetical)` in a
 * title is never touched.
 */
const stripConflictSuffix = (name: string): string => {
  for (;;) {
    const next = name.replace(/\s*\(conflicted copy[^()]*\)\s*$/u, '');
    if (next === name) return name;
    name = next;
  }
};

// Column list for a full page fetch, including the hosted-database join.
const PAGE_COLUMNS =
  'p.id, p.name, p.data, p.database_id, p.parent_id, p.properties, p.deleted_at, p.created_at, p.updated_at, ' +
  'd.id AS hosted_database_id';
const PAGE_FROM = 'pages p LEFT JOIN databases d ON d.page_id = p.id';

/**
 * Stable content hash of an import bundle (ER-6). Re-applying a byte-identical
 * bundle yields the same key, so the second apply short-circuits to the recorded
 * result instead of duplicating the whole workspace. Pages/databases are sorted by
 * id first so a reordered-but-identical bundle still matches; a genuinely distinct
 * bundle hashes differently and imports normally. SHA-256 (no collision-overwrite
 * risk across distinct bundles); runs in Node ≥ 19 and the browser PGlite home via
 * `globalThis.crypto.subtle`.
 */
async function bundleKey(req: ImportRequest): Promise<string> {
  const byId = <T extends {id: string}>(a: T, b: T): number => a.id.localeCompare(b.id);
  const canonical = JSON.stringify({
    mode: req.mode ?? 'copy',
    pages: [...req.pages].sort(byId),
    databases: [...req.databases].sort(byId),
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 hex of raw bytes — the content-addressed id of an asset (Assets A1).
 * Byte-identical inputs hash identically, so the asset store dedups on it; the id
 * is self-verifying (a content hash, never a guessable sequential handle). Uses
 * the same `globalThis.crypto.subtle` path as {@link bundleKey}, so it runs under
 * Node, the browser PGlite home, and the compiled sidecar alike.
 */
async function assetHash(bytes: Uint8Array): Promise<string> {
  // Copy into a definitely-`ArrayBuffer`-backed view so `subtle.digest`'s
  // `BufferSource` accepts it (a bare `Uint8Array` is `ArrayBufferLike`).
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a `BYTEA` value to a `Uint8Array`. PGlite returns a `Uint8Array` and
 * node-postgres a `Buffer` (a `Uint8Array` subclass); a wire backend may hand back
 * a `\x…` hex string. All three collapse here so `getAsset` always yields bytes.
 */
function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/**
 * The one and only OpenBook storage implementation: pages in Postgres. The
 * embedded (desktop) and remote (server) modes differ only in the {@link Db}
 * backend passed in.
 */
export class PageStore {
  constructor(private readonly db: Db) {}

  /**
   * Count of **brand-new** "(conflicted copy)" pages minted by
   * {@link importBookPage} (ER-2 metric). The OB-241 idempotent-reuse branch does
   * NOT increment this — only a genuinely distinct divergent edit does — so the
   * mirror's per-page-id copy cap (ER-4) can detect a storm regression without
   * being fooled by repeated re-applies of the same content.
   */
  private conflictCopiesMinted = 0;
  get copiesMinted(): number {
    return this.conflictCopiesMinted;
  }

  /**
   * A monotonically increasing "access epoch" bumped whenever anything that can
   * change a read/write decision is mutated — a page's visibility, a per-page
   * ACL grant, the instance policy (guest gate / trusted issuers / owner), the
   * member roster, a sign-in claim, or a page delete/restore. The live-stream
   * read gate (`streamGates`) caches its per-page `canReadPage` decision for a
   * connection's life and re-evaluates only when this epoch advances, so the
   * firehose doesn't re-authorize every `yupdate` frame yet a permission change
   * takes effect on the very next frame (Collab T1). Coarse by design: any access
   * mutation invalidates every cached decision — always safe (never stale-allows),
   * at most an occasional needless re-check.
   */
  private accessGen = 0;
  /** The current access epoch (see {@link accessGen}). */
  accessGeneration(): number {
    return this.accessGen;
  }
  /** Advance the access epoch — call after any read/write-affecting mutation. */
  private bumpAccess(): void {
    this.accessGen += 1;
  }

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
    // ER-6: re-applying the SAME bundle must be a no-op. `copy` mode re-IDs +
    // INSERTs the whole bundle as fresh pages on every call and the route appends
    // a `space.import` edit each time, so an idempotent re-apply (a future
    // workspace-sync/restore daemon re-POSTing its bundle — the OB-241 shape one
    // level up) would otherwise duplicate the entire workspace and grow the edit
    // log unbounded.
    //
    // The whole import runs in ONE transaction that CLAIMS the bundle's content
    // hash FIRST. A separate `SELECT … then import` is a check-then-act race: two
    // overlapping imports of the same bundle would both see no prior row and both
    // apply (copy mode re-IDs, so there's no page-level conflict to stop the
    // second) → the workspace is duplicated. Claiming the key up front closes that:
    //  - winner: its `INSERT … RETURNING` yields the key → it imports, then writes
    //    the real result into the claimed row before commit.
    //  - loser: `ON CONFLICT DO NOTHING` yields no row → it re-reads the committed
    //    result and returns a no-op `deduped`. On PGlite the mutex serializes whole
    //    transactions; on real Postgres the unique-index lock on `import_log.key`
    //    makes the loser block on the winner, then dedupe. A genuinely *distinct*
    //    bundle hashes differently and imports normally.
    // C1: a workspace restore must never rewrite the server-managed AI usage DB.
    // A crafted overwrite bundle could otherwise re-home / rewrite its attribution
    // rows (user/cost/tokens), its restricted host page, or the database itself —
    // bypassing the `/api/pages` + `/api/databases` managed write-gates (an
    // audit-integrity tamper, even for an admin). Load the managed ids here so the
    // dispatch below can strip any bundle entry that targets them. Read from
    // `settings` BEFORE the transaction (the ids are recorded once on first AI use
    // and stable thereafter — absent, so a no-op strip, until then); reading inside
    // would re-enter the PGlite mutex the tx already holds.
    const managedUsage = await this.getSetting<{databaseId: string; hostPageId: string | null}>(USAGE_DB_SETTING_KEY);
    const key = await bundleKey(req);
    return this.db.begin(async (tx) => {
      const claim = await tx.query<{key: string}>(
        `INSERT INTO import_log (key, result) VALUES ($1, '{}'::jsonb)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key],
      );
      if (claim.length === 0) {
        const prior = await tx.query<{result: ImportResult | string}>('SELECT result FROM import_log WHERE key = $1', [key]);
        const recorded = parseJson<ImportResult>(prior[0]?.result, {created: 0, overwritten: 0, renamed: 0, idMap: {}});
        return {...recorded, deduped: true};
      }
      // Drop any bundle entry that targets the server-managed AI usage DB before it
      // reaches the writers — so overwrite mode can't tamper with the audit rows and
      // recordSyncedAttributionTx never credits a skipped (managed) page.
      const {pages, databases} = await this.stripManagedUsage(tx, req.pages, req.databases, managedUsage);
      const result =
        req.mode === 'overwrite'
          ? await this.importOverwriteTx(tx, pages, databases)
          : await this.importCopyTx(tx, pages, databases);
      // OB-170: a page may carry verified per-block authorship from the instance it
      // was authored on. Credit that as a `synced` edit-log entry — in the SAME
      // transaction so a crash can't leave the claimed key committed without its
      // attribution (which a later re-apply would then skip as `deduped`, losing it).
      await this.recordSyncedAttributionTx(tx, pages, result.idMap);
      await tx.query('UPDATE import_log SET result = $2::jsonb WHERE key = $1', [key, JSON.stringify(result)]);
      return result;
    });
  }

  /** Credit the carried verified author of each imported page (OB-170), on the
   *  import transaction so attribution commits atomically with the pages. */
  private async recordSyncedAttributionTx(tx: Db, pages: StoredPage[], idMap: Record<string, string>): Promise<void> {
    for (const p of pages) {
      const subject = latestSnapshotAuthor(p.data);
      if (!subject) continue;
      const pageId = idMap[p.id] ?? p.id;
      // ER-6: skip when an identical `page.synced` credit already exists for this
      // (page, subject). The bundle-level content hash already makes re-applying
      // the same bundle a no-op; this is the second line of defence so that
      // re-importing *overlapping* pages by id (overwrite mode, or a partly-changed
      // re-export) can't pile up duplicate attribution rows for the same author.
      const seen = await tx.query<{id: string}>(
        `SELECT id FROM edit_log
         WHERE page_id = $1 AND author_subject = $2 AND kind = 'page.synced' LIMIT 1`,
        [pageId, subject],
      );
      if (seen.length > 0) continue;
      await this.logEditOn(tx, {
        pageId,
        author: {
          kind: 'user',
          subject,
          issuer: subject.includes('#') ? subject.slice(0, subject.indexOf('#')) : '',
          name: '',
          verifiedVia: 'synced',
        },
        kind: 'page.synced',
        summary: 'attributed from a synced edit',
      });
    }
  }

  /**
   * Strip every bundle entry that targets the server-managed AI usage DB (C1),
   * mirroring {@link AiUsageLog.isManagedPage} against the CURRENT store state (not
   * the bundle's own untrusted claim). Dropped are:
   *  - the usage DB's restricted host page (by id);
   *  - any page CLAIMING to belong to the usage DB (`databaseId === usageDbId`) —
   *    an overwrite bundle could otherwise inject a forged attribution row;
   *  - any page whose id currently IS an attribution row (its stored `database_id`
   *    is the usage DB) — even when the bundle re-homes it elsewhere, so a rewrite /
   *    detach of a real row is blocked;
   *  - the usage database itself (by id), so its schema (managed marker, retention)
   *    and host page can't be re-homed.
   * A normal (non-managed) page/database in the same bundle is untouched, and when
   * no usage DB is seeded this is a no-op. Server-internal writes (seed, attribution,
   * the auto-expiry sweep) never flow through import, so they stay unaffected.
   */
  private async stripManagedUsage(
    tx: Db,
    pages: StoredPage[],
    databases: StoredDatabase[],
    managed: {databaseId: string; hostPageId: string | null} | null,
  ): Promise<{pages: StoredPage[]; databases: StoredDatabase[]}> {
    if (!managed?.databaseId) return {pages, databases};
    const kept: StoredPage[] = [];
    for (const p of pages) {
      if (p.id === managed.hostPageId) continue;
      if (p.databaseId === managed.databaseId) continue;
      const cur = await tx.query<{database_id: string | null}>('SELECT database_id FROM pages WHERE id = $1', [p.id]);
      if (cur[0]?.database_id === managed.databaseId) continue;
      kept.push(p);
    }
    return {pages: kept, databases: databases.filter((d) => d.id !== managed.databaseId)};
  }

  private async importCopyTx(tx: Db, pages: StoredPage[], databases: StoredDatabase[]): Promise<ImportResult> {
    const {pages: rp, databases: rd, idMap} = remapBundle(pages, databases, randomUUID);
    let renamed = 0;
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
    return {created: rp.length, overwritten: 0, renamed, idMap};
  }

  private async importOverwriteTx(tx: Db, pages: StoredPage[], databases: StoredDatabase[]): Promise<ImportResult> {
    let created = 0;
    let overwritten = 0;
    const idMap: Record<string, string> = {};
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
   *
   * **Convergence invariant (OB-241 / ER-4):** one external divergence ⇒ at most
   * one conflict copy per (page-id, content). A cloud-sync daemon that re-applies
   * the *same* stale-base file forever reuses its existing copy (idempotent), so
   * the re-import loop settles; only a *distinct* divergent edit earns a new copy.
   * {@link copiesMinted} counts just the new mints, and the mirror caps them per
   * page-id within a window so a regression can't silently re-open the storm.
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
      // suffixed copy so nothing is silently lost (DB-wins, no data loss).
      const dataJson = JSON.stringify(record.data);

      // Idempotency (OB-241): an external sync tool (Dropbox/iCloud/Syncthing) can
      // re-apply the *same* divergent file over and over — each carrying the same
      // stale base — and the conflict-restore keeps rewriting the canonical bytes
      // back over it, so the file diverges again on the very next re-apply. Minting
      // a fresh copy each time produced an unbounded "(conflicted copy)" storm
      // (10+ GB of duplicate pages/files). Before inserting, reuse an existing
      // conflict copy that already holds this exact content, so one external
      // divergence yields at most ONE copy and the re-import loop converges. The
      // safety guarantee is unchanged: the divergent content is still preserved.
      const existingCopy = await tx.query<PageRow>(
        `SELECT id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id
         FROM pages
         WHERE deleted_at IS NULL AND id <> $1 AND name LIKE '% (conflicted copy%' AND data = $2::jsonb
         ORDER BY created_at ASC
         LIMIT 1`,
        [record.id, dataJson],
      );
      if (existingCopy.length > 0) return {action: 'conflict' as const, page: pageFromRow(existingCopy[0])};

      // A genuinely distinct divergent edit → mint a fresh copy. Fresh id so it
      // never collides with the canonical row. Strip any existing
      // "(conflicted copy …)" suffix first (OB-241): a conflict-of-conflict re-adds
      // exactly one level instead of deep-chaining `(…)(…)(…)`. Reuse semantics
      // above are unaffected — they key on the stored name + data, not this derivation.
      const baseName = stripConflictSuffix((record.name ?? 'Untitled').trim()).trim() || 'Untitled';
      const taken = new Set<string>();
      const name = await freeName(tx, `${baseName} (conflicted copy ${nowIso})`, taken, 'conflicted copy');
      const copy = await tx.query<PageRow>(
        `INSERT INTO pages (id, name, data, position, updated_at)
         VALUES ($1, $2, $3::jsonb,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM pages WHERE parent_id IS NULL), now())
         RETURNING id, name, data, database_id, parent_id, properties, created_at, updated_at,
           (SELECT id FROM databases WHERE page_id = pages.id) AS hosted_database_id`,
        [randomUUID(), name, dataJson],
      );
      // Count it only after the row lands (ER-2): the counter advances solely for
      // genuinely new content, so the convergence invariant — one external
      // divergence ⇒ at most one conflict copy per (page-id, content) — holds, and
      // the mirror's per-page-id cap (ER-4) can spot a storm regression without
      // being fooled by repeated re-applies of the same content.
      this.conflictCopiesMinted += 1;
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

  /**
   * Fetch a (live, non-trashed) page by name. Names are not unique (migration
   * 0015); when several live pages share one, the most recently updated wins,
   * so the lookup stays deterministic.
   */
  async getPageByName(name: string): Promise<StoredPage | null> {
    const rows = await this.db.query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.name = $1 AND p.deleted_at IS NULL
       ORDER BY p.updated_at DESC, p.id LIMIT 1`,
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
   *
   * ER-7: a keyless create (no `id`) mints a fresh UUID each call, so a retried/
   * replayed create POST would otherwise duplicate the page (the client-side OB-241
   * analogue). When the caller carries an `idempotencyKey`, the create is deduped
   * PER-PRINCIPAL — a replay with the same (principal, key) returns the page the
   * first call minted. The key is *claimed* before the page is written (an `INSERT
   * … ON CONFLICT DO NOTHING` on the per-principal PK) so even on a non-serialized
   * backend two racing replays can't both create a page. Scoping the claim to the
   * resolved principal subject means one principal's key can never collide with or
   * overwrite another's write.
   *
   * The per-principal guarantee rests on subject UNIQUENESS — verified jws users
   * (`iss#sub`) and the local owner (`local:owner`). When there is no resolved
   * principal subject we skip the claim entirely and fall through to a normal
   * (non-idempotent) create, rather than key on a shared sentinel that would let
   * unrelated keyless callers collide. (Anonymous guests share one subject and are
   * the write-excluded class under a locked instance, so they're not relied on here.)
   */
  async upsertPage(input: PageInput, author?: Principal): Promise<StoredPage> {
    const clientKey = input.idempotencyKey?.trim();
    const subject = author?.subject;
    if (!input.id && clientKey && subject) {
      return this.db.begin(async (tx) => {
        const newId = randomUUID();
        const claim = await tx.query<{page_id: string}>(
          `INSERT INTO write_keys (author_subject, client_key, page_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (author_subject, client_key) DO NOTHING
           RETURNING page_id`,
          [subject, clientKey, newId],
        );
        // The key was already claimed by an earlier create from THIS principal →
        // this is a replay. Return the page that create minted (whatever its
        // current state), so the replay never produces a second page.
        if (claim.length === 0) {
          const keyed = await tx.query<{page_id: string}>(
            'SELECT page_id FROM write_keys WHERE author_subject = $1 AND client_key = $2',
            [subject, clientKey],
          );
          const keyedId = keyed[0]?.page_id ?? newId;
          const rows = await tx.query<PageRow>(`SELECT ${PAGE_COLUMNS} FROM ${PAGE_FROM} WHERE p.id = $1`, [keyedId]);
          if (rows.length > 0) return pageFromRow(rows[0]);
          // The keyed page was hard-purged — re-create it under its recorded id so
          // the key stays consistent across any further replays (rare edge).
          return this.upsertPageTx(tx, keyedId, input, author);
        }
        return this.upsertPageTx(tx, newId, input, author);
      });
    }
    const id = input.id ?? randomUUID();
    return this.db.begin((tx) => this.upsertPageTx(tx, id, input, author));
  }

  /**
   * The page upsert body, run on a caller-supplied transaction so the ER-7 key
   * claim and the page write commit atomically.
   *
   * `authorsByBlock` overrides the single-principal attribution for the
   * server-authoritative persist path (Collab T9): when the SERVER writes one
   * converged snapshot merging edits from several writers, each changed block is
   * attributed to the verified subject of the principal whose update actually
   * changed it (see {@link saveServerDoc}), rather than crediting every changed
   * block to one `author`. Absent ⇒ the normal single-`author` stamp.
   */
  private async upsertPageTx(
    tx: Db,
    id: string,
    input: PageInput,
    author?: Principal,
    authorsByBlock?: ReadonlyMap<string, string>,
  ): Promise<StoredPage> {
    // Stamp per-block mtimes relative to the page's prior content so an
    // unchanged block keeps its timestamp and a changed one is restamped — the
    // change signal the disk mirror, watcher, and conflict resolver read. The
    // read + write run in one transaction (serialized by the PGlite mutex) so a
    // concurrent save can't race the stamp. The same prior read also stamps
    // per-block verified authorship (OB-170), so attribution travels with the
    // snapshot through any later sync.
    const prior = await tx.query<PageRow>('SELECT data FROM pages WHERE id = $1', [id]);
    const priorData = prior.length > 0 ? parseSnapshot(prior[0].data) : null;
    const stamped = stampSnapshotMtimes(priorData, input.data ?? EMPTY_SNAPSHOT, new Date().toISOString());
    const data = authorsByBlock
      ? stampSnapshotAuthorsPerBlock(priorData, stamped, authorsByBlock)
      : stampSnapshotAuthors(priorData, stamped, verifiedSubject(author));
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
  }

  /**
   * Durably checkpoint the block document of an EXISTING page from the server's
   * canonical Yjs doc (Collab T9 — server-authoritative persistence). Unlike
   * {@link upsertPage} this never creates a page and never touches its name: it
   * replaces only the block document (`editor: 'blocks'` + `blockdoc`) on the page's
   * prior snapshot, then runs the SAME transactional stamp + no-op-skip write as
   * every other content save — so OB-241's per-block mtimes, the disk mirror, the
   * conflict-copy machinery, and the idempotent-write skip all apply unchanged.
   *
   * Attribution is per-block (`authorsByBlock`: `blockId → verified subject`) so the
   * merged checkpoint credits each changed block to the principal whose ingested
   * update actually changed it (OB-170), never "the server". Returns the updated
   * page, or `null` when the page no longer exists (deleted mid-session) — a server
   * checkpoint must never resurrect a deleted page.
   */
  async saveServerDoc(
    id: string,
    blockdoc: unknown,
    authorsByBlock: ReadonlyMap<string, string>,
  ): Promise<StoredPage | null> {
    return this.db.begin(async (tx) => {
      const prior = await tx.query<{name: string | null; data: PageSnapshot | string | null}>(
        'SELECT name, data FROM pages WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (prior.length === 0) return null; // deleted mid-session — do not resurrect
      const priorData = parseSnapshot(prior[0].data);
      // Replace only the block document; keep every other snapshot facet (legacy
      // editorjs/values/names, etc.). upsertPageTx re-reads prior + stamps mtimes.
      const data = {...priorData, editor: 'blocks', blockdoc};
      return this.upsertPageTx(tx, id, {id, name: prior[0].name, data}, undefined, authorsByBlock);
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
        // No-op-skip (ER-9): only write rows whose position actually changes — the
        // same `IS DISTINCT FROM` guard `upsertPage` uses — so a renumber that leaves
        // most siblings put doesn't churn a dead MVCC tuple per row (PGlite has no
        // autovacuum, OB-164).
        await tx.query('UPDATE pages SET position = $2 WHERE id = $1 AND position IS DISTINCT FROM $2', [orderedIds[i], i]);
      }
      return true;
    });
    // NOTE (Collab T1, access epoch): reparenting deliberately does NOT bumpAccess
    // today — a page's read decision is independent of its parent because ancestor
    // visibility-INHERITANCE isn't implemented (see `effectiveVisibility`, which only
    // resolves a page's OWN `inherit` to the instance default, not to an ancestor).
    // WHEN the ancestor-walk lands, a move (and a parent's visibility/ACL change)
    // becomes read-access-relevant for the whole subtree → add a `bumpAccess()` here
    // (and bump on a parent's visibility/ACL mutation for its descendants) so the
    // live read-gate cache can't serve a now-stale decision.
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
    // Trashing a page removes it from every reader's view — invalidate the live
    // read-gate cache so an open relay stops emitting its updates (Collab T1).
    if (rows.length > 0) this.bumpAccess();
    return rows.length > 0;
  }

  /**
   * Restore a trashed page and the descendants that were trashed together with
   * it (matched by the shared `deleted_at` timestamp — a child trashed in a
   * separate, earlier operation stays in the trash). Returns the restored page,
   * or `null` if it was not in the trash.
   *
   * Names are not unique (migration 0015), so a restore always keeps the page's
   * original name — even when a live page created meanwhile carries the same one.
   */
  async restorePage(id: string): Promise<StoredPage | null> {
    const ok = await this.db.begin(async (tx) => {
      const root = await tx.query<{deleted_at: Date | string | null}>(
        'SELECT deleted_at FROM pages WHERE id = $1',
        [id],
      );
      if (root.length === 0 || root[0].deleted_at == null) return false;

      // The subtree trashed together with the root (same `deleted_at`).
      await tx.query(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM pages WHERE id = $1
           UNION ALL
           SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
           WHERE p.deleted_at = (SELECT deleted_at FROM pages WHERE id = $1)
         )
         UPDATE pages SET deleted_at = NULL, updated_at = now()
         WHERE id IN (SELECT id FROM subtree)`,
        [id],
      );
      return true;
    });
    if (ok) this.bumpAccess(); // restored pages re-enter readers' views (Collab T1)
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

  /**
   * Auto-expiry (TTL) sweep: for every database whose
   * {@link DatabaseSchema.autoExpiry} resolves to an active rule
   * ({@link resolveAutoExpiry}), soft-delete its rows whose expiry-basis
   * timestamp is at or before `now − days`. Rows are moved to the trash — the
   * same restorable soft-delete {@link deletePage} performs (`deleted_at` set),
   * NEVER hard-deleted here; the later {@link purgeExpired} sweep decides when a
   * trashed row is finally purged.
   *
   * Each database is swept in isolation, scoped strictly to its own
   * `database_id`, so one database's TTL can never touch another's rows. `now`
   * is injectable for deterministic tests (defaults to the wall clock). Returns
   * the number of rows newly trashed across all databases.
   *
   * Basis handling:
   *  - `created` / `lastEdited` → one bounded `UPDATE … WHERE created_at`
   *    (resp. `updated_at`) `<= cutoff` — no row scan.
   *  - a `date` property id → a bounded scan of the database's live rows, parsing
   *    the stored value ({@link dateStart} + {@link parseDay}) and trashing those
   *    on/before the cutoff day. (A `created_time` property basis collapses to
   *    `created` in {@link resolveAutoExpiry}, so it never reaches the scan.)
   */
  async sweepExpiredRows(opts: {now?: Date} = {}): Promise<number> {
    const now = opts.now ?? new Date();
    const dbRows = await this.db.query<DatabaseRowRecord>(
      'SELECT id, page_id, name, schema, created_at, updated_at FROM databases',
    );
    let trashed = 0;
    for (const raw of dbRows) {
      const schema = parseJson<DatabaseSchema>(raw.schema, EMPTY_SCHEMA);
      const rule = resolveAutoExpiry(schema);
      if (!rule) continue;
      const cutoffIso = new Date(now.getTime() - rule.days * 86_400_000).toISOString();
      if (rule.kind === 'created' || rule.kind === 'lastEdited') {
        // A single bounded UPDATE, scoped to THIS database only.
        const col = rule.kind === 'created' ? 'created_at' : 'updated_at';
        const deleted = await this.db.query<{id: string}>(
          `UPDATE pages SET deleted_at = now()
             WHERE database_id = $1 AND deleted_at IS NULL AND ${col} <= $2::timestamptz
           RETURNING id`,
          [raw.id, cutoffIso],
        );
        trashed += deleted.length;
        continue;
      }
      // date-property basis: the date lives in `pages.properties` (JSONB, not a
      // comparable column), so scan the database's live rows and parse each value.
      // Bounded to this database's rows.
      //
      // NOTE: date-property expiry is DAY-GRANULAR. `parseDay` normalises the
      // stored value to a local-midnight Date and compares it against a `cutoffMs`
      // derived from a UTC `now − days`. Because the day is anchored at local
      // midnight while the cutoff is a UTC instant, the effective boundary can
      // shift by up to ~a day relative to a naive UTC-day reading. That coarseness
      // is acceptable for a retention feature (nothing is hard-deleted — rows only
      // move to the restorable trash); do not treat it as sub-day-precise.
      const scan = await this.db.query<{id: string; properties?: Record<string, unknown> | string | null}>(
        'SELECT id, properties FROM pages WHERE database_id = $1 AND deleted_at IS NULL',
        [raw.id],
      );
      const cutoffMs = new Date(cutoffIso).getTime();
      const expired: string[] = [];
      for (const r of scan) {
        const props = parseJson<Record<string, unknown>>(r.properties, {});
        const day = parseDay(dateStart(props[rule.propertyId]));
        if (day && day.getTime() <= cutoffMs) expired.push(r.id);
      }
      if (expired.length === 0) continue;
      const placeholders = expired.map((_, i) => `$${i + 2}`).join(', ');
      const deleted = await this.db.query<{id: string}>(
        `UPDATE pages SET deleted_at = now()
           WHERE database_id = $1 AND deleted_at IS NULL AND id IN (${placeholders})
         RETURNING id`,
        [raw.id, ...expired],
      );
      trashed += deleted.length;
    }
    // Trashed rows leave every reader's view — invalidate the live read-gate cache
    // (Collab T1), matching deletePage's bumpAccess.
    if (trashed > 0) this.bumpAccess();
    return trashed;
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
  async createRow(databaseId: string, input: RowInput = {}, author?: Principal): Promise<StoredPage> {
    const id = randomUUID();
    // A fresh row has no prior content, so every block is stamped "now" and
    // attributed to its (verified) creator (OB-170).
    const stamped = stampSnapshotMtimes(null, input.data ?? emptyPageSnapshot(), new Date().toISOString());
    const data = stampSnapshotAuthors(null, stamped, verifiedSubject(author));
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
        // No-op-skip (ER-9): the `position IS DISTINCT FROM $3` guard (the pattern
        // `upsertPage` uses) writes only rows that actually moved, so a reorder that
        // leaves most rows in place doesn't leak a dead MVCC tuple per row (PGlite has
        // no autovacuum, OB-164).
        await tx.query('UPDATE pages SET position = $3 WHERE id = $1 AND database_id = $2 AND position IS DISTINCT FROM $3', [
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

  async createSuggestion(input: SuggestionInput, author?: Principal): Promise<StoredSuggestion> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<SuggestionRow>(
      `INSERT INTO suggestions
         (id, page_id, author_kind, author_name, kind, target, before_text, after_text, status, payload,
          author_subject, author_issuer, author_verified, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'open', $9::jsonb, $10, $11, $12, now())
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
        author?.subject ?? null,
        author?.issuer ?? null,
        author?.verifiedVia ?? null,
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

  async createComment(input: CommentInput, author?: Principal): Promise<StoredComment> {
    const id = input.id ?? randomUUID();
    const rows = await this.db.query<CommentRowRecord>(
      `INSERT INTO comments
         (id, page_id, suggestion_id, block_id, parent_id, author_name, body,
          author_subject, author_issuer, author_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING ${COMMENT_COLS}`,
      [
        id,
        input.pageId,
        input.suggestionId ?? null,
        input.blockId ?? null,
        input.parentId ?? null,
        input.authorName,
        JSON.stringify(input.body ?? []),
        author?.subject ?? null,
        author?.issuer ?? null,
        author?.verifiedVia ?? null,
      ],
    );
    return commentFromRow(rows[0]);
  }

  /** Fetch a single comment by id (for access gating on its parent page). */
  async getComment(id: string): Promise<StoredComment | null> {
    const rows = await this.db.query<CommentRowRecord>(
      `SELECT ${COMMENT_COLS} FROM comments WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? commentFromRow(rows[0]) : null;
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
    await this.logEditOn(this.db, entry);
  }

  /** Append one edit-log row on a caller-supplied {@link Db} — the store's
   *  connection (best-effort, post-commit) or an open transaction (e.g. import
   *  attribution, where it must commit atomically with the pages). */
  private async logEditOn(
    db: Db,
    entry: {pageId: string | null; author: Principal; kind: string; summary?: string},
  ): Promise<void> {
    const a = entry.author;
    await db.query(
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

  /**
   * Prune edit-log entries older than `retentionMs` (a periodic job, like the
   * trash sweep). The log gains a row per mutation and PGlite has no autovacuum,
   * so an unbounded log bloats the embedded heap (the OB-164 class of problem) —
   * this bounds it. `retentionMs <= 0` keeps the log forever (no-op). Returns the
   * number of entries pruned.
   */
  async purgeOldEdits(retentionMs: number): Promise<number> {
    if (!(retentionMs > 0)) return 0;
    const rows = await this.db.query<{id: string}>(
      `DELETE FROM edit_log
       WHERE created_at <= now() - ($1::bigint * interval '1 millisecond')
       RETURNING id`,
      [Math.trunc(retentionMs)],
    );
    return rows.length;
  }

  /**
   * Prune the idempotency ledgers (ER-6 `import_log`, ER-7 `write_keys`) older than
   * `retentionMs` — the same periodic sweep as the edit log, for the same reason
   * (bound growth on the autovacuum-less embedded store, OB-164). `retentionMs`
   * doubles as the dedup window: once a key is pruned, re-applying its bundle /
   * replaying its create is treated as new. `<= 0` keeps the ledgers forever (no-op).
   * Returns the number of rows pruned across both tables.
   */
  async purgeOldIdempotencyKeys(retentionMs: number): Promise<number> {
    if (!(retentionMs > 0)) return 0;
    const ms = Math.trunc(retentionMs);
    const imports = await this.db.query<{key: string}>(
      `DELETE FROM import_log
       WHERE created_at <= now() - ($1::bigint * interval '1 millisecond') RETURNING key`,
      [ms],
    );
    const writes = await this.db.query<{page_id: string}>(
      `DELETE FROM write_keys
       WHERE created_at <= now() - ($1::bigint * interval '1 millisecond') RETURNING page_id`,
      [ms],
    );
    return imports.length + writes.length;
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

  // ── Generic settings key/value ───────────────────────────────────────────────
  //
  // Small JSON blobs keyed by name in the `settings` table (the same table the AI
  // config, instance policy, and backups config use). Used by subsystems that need
  // a bit of durable state without their own table — e.g. the AI usage-attribution
  // log (its managed database id + the admin pricing override).

  /** Read a JSON settings value by key, or `null` when unset. */
  async getSetting<T>(key: string): Promise<T | null> {
    const rows = await this.db.query<{value: T | string}>('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows.length === 0) return null;
    return parseJson<T | null>(rows[0].value, null);
  }

  /** Upsert a JSON settings value by key. */
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  // ── Agent Personal-Access-Tokens (AGENT-6) ───────────────────────────────────

  /**
   * Insert a minted agent token. The plaintext is NEVER stored — only its SHA-256
   * `tokenHash` (UNIQUE) + a non-secret `preview`. `subject`/`issuer` are the
   * MINTER's own verified identity (bound by the route, never client-chosen). Returns
   * the redacted {@link AgentTokenMeta} (no secret).
   */
  async createAgentToken(input: {
    name: string;
    tokenHash: string;
    preview: string;
    subject: string;
    issuer: string;
    scope: AgentTokenScope;
    createdBy: string;
    expiresAt: Date | null;
  }): Promise<AgentTokenMeta> {
    const rows = await this.db.query<AgentTokenDbRow>(
      `INSERT INTO agent_tokens (id, name, token_hash, preview, subject, issuer, scope, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, name, preview, subject, issuer, scope, created_by, created_at, expires_at, last_used_at, revoked_at`,
      [randomUUID(), input.name, input.tokenHash, input.preview, input.subject, input.issuer, input.scope, input.createdBy, input.expiresAt],
    );
    return agentTokenMetaFromRow(rows[0]);
  }

  /** Count LIVE (non-revoked, unexpired) tokens — the mint-cap check. */
  async countActiveAgentTokens(): Promise<number> {
    const rows = await this.db.query<{n: number | string}>(
      'SELECT count(*)::int AS n FROM agent_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())',
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** List every token (redacted), newest first — revoked/expired ones included and
   *  flagged, for provenance. The secret hash is never selected. */
  async listAgentTokens(): Promise<AgentTokenMeta[]> {
    const rows = await this.db.query<AgentTokenDbRow>(
      `SELECT id, name, preview, subject, issuer, scope, created_by, created_at, expires_at, last_used_at, revoked_at
       FROM agent_tokens ORDER BY created_at DESC`,
    );
    return rows.map(agentTokenMetaFromRow);
  }

  /**
   * Resolve a presented token by its hash — returns the row ONLY when it is LIVE
   * (not revoked, not past `expires_at`). An absent/revoked/expired hash ⇒ `null`,
   * so the caller HARD-401s rather than downgrading to a guest.
   */
  async resolveAgentToken(tokenHash: string): Promise<AgentTokenRow | null> {
    const rows = await this.db.query<{id: string; name: string; subject: string; issuer: string; scope: string}>(
      `SELECT id, name, subject, issuer, scope FROM agent_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {id: r.id, name: r.name, subject: r.subject, issuer: r.issuer, scope: r.scope as AgentTokenScope};
  }

  /** Best-effort debounced `last_used_at` touch (skips a write within ~60s of the
   *  last so a busy agent doesn't write on every request). */
  async touchAgentTokenUsed(id: string): Promise<void> {
    await this.db.query(
      `UPDATE agent_tokens SET last_used_at = now() WHERE id = $1
         AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [id],
    );
  }

  /** Revoke a token by id (sets `revoked_at`; the row lingers for provenance).
   *  Returns `true` when a not-yet-revoked row was revoked. */
  async revokeAgentToken(id: string): Promise<boolean> {
    const rows = await this.db.query<{id: string}>(
      'UPDATE agent_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [id],
    );
    return rows.length > 0;
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
    const current = await this.getInstanceConfig();
    const next = {...current, ...patch};
    // Un-claim guard (OB-190; OB-182 §2.6, B2). A claim is **one-way**: once an
    // instance has an `ownerSubject`, this writer must NEVER let it be cleared or
    // re-pointed. The shallow merge above would otherwise honour a patch carrying
    // `ownerSubject: undefined` (erasing the pin → next read is unclaimed → the
    // rule-0 anonymous-world-write short-circuit re-opens). Re-setting the same
    // value is idempotent and allowed; the first claim (from unset) is allowed —
    // the transactional first-writer-wins CAS for the claim itself is OB-191.
    if (current.ownerSubject && next.ownerSubject !== current.ownerSubject) {
      // 409 (not a 500): clearing/re-pointing a claimed owner is a conflicting
      // request, so `PUT /api/instance {ownerSubject:null}` surfaces as 409.
      throw new HTTPException(409, {
        message: 'ownerSubject is claim-once and cannot be cleared or changed (OB-182 §2.6)',
      });
    }
    // Config footgun guard (OB-182 §2.4, Sasha N2): `emailAuthority` MUST be a
    // trusted issuer. If it names an issuer the instance doesn't trust, no token
    // from it ever verifies, so every persona / email-ACL grant silently stops
    // matching (it fails *safe* → deny, but invisibly). Reject the write instead
    // of letting the policy drift into that dead state.
    assertEmailAuthorityTrusted(next);
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ('instance', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    this.bumpAccess(); // guest gate / issuers / owner all change decisions (Collab T1)
    return next;
  }

  /**
   * Atomically claim instance ownership (OB-182 §2.6 B2, the TOCTOU close). Binds
   * `ownerSubject` to a verified subject via a **compare-and-set**: the UPDATE
   * only matches while `ownerSubject` is still unset (`WHERE NOT (value ?
   * 'ownerSubject')`), so a racing second claimant's update affects **0 rows** and
   * loses — first-writer-wins, never a read-modify-write of the whole blob. At the
   * claim, in the **same transaction**, the §2.6 bootstrap fires atomically: set
   * `ownerSubject`; set `defaultVisibility='members'` (Fork 1); downgrade
   * `guestAccess 'write'→'read'` (Fork 2, defense in depth); default
   * `emailAuthority` to account.book.pub. Existing policy (trustedIssuers,
   * audience, …) is preserved. Returns the resulting config and whether THIS call
   * won the claim (`claimed:false` ⇒ already owned — the caller should 409/observe
   * the winner). Caller verifies the subject is its own jws subject (route).
   */
  async claimOwnership(subject: string): Promise<{config: InstanceConfig; claimed: boolean}> {
    return this.db.begin(async (tx) => {
      // Ensure a settings row exists to target, without clobbering any stored
      // policy (an empty `{}` merges under DEFAULT_INSTANCE_CONFIG on read).
      await tx.query(
        'INSERT INTO settings (key, value) VALUES (\'instance\', \'{}\'::jsonb) ON CONFLICT (key) DO NOTHING',
      );
      // Lock + read the row. `FOR UPDATE` serializes a concurrent claimant on real
      // Postgres (the second blocks here, then re-reads the committed, now-claimed
      // row); PGlite already serializes via its single-connection mutex.
      const rows = await tx.query<{value: InstanceConfig | string}>(
        'SELECT value FROM settings WHERE key = \'instance\' FOR UPDATE',
      );
      const current: InstanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        ...parseJson<Partial<InstanceConfig>>(rows[0]?.value, {}),
      };
      // Already claimed ⇒ this caller lost the race (or it's a re-claim attempt).
      if (current.ownerSubject) return {config: current, claimed: false};

      const next: InstanceConfig = {
        ...current,
        ownerSubject: subject,
        defaultVisibility: current.defaultVisibility ?? 'members',
        guestAccess: current.guestAccess === 'write' ? 'read' : current.guestAccess,
        emailAuthority: current.emailAuthority ?? DEFAULT_ACCOUNT_URL,
      };
      assertEmailAuthorityTrusted(next);

      const updated = await tx.query<{value: unknown}>(
        `UPDATE settings SET value = $1::jsonb
           WHERE key = 'instance' AND NOT (value ? 'ownerSubject')
           RETURNING value`,
        [JSON.stringify(next)],
      );
      // CAS lost (a concurrent claim slipped in between read and write) ⇒ 0 rows.
      // Re-read so we return the *winning* config, not our rejected one.
      if (updated.length === 0) {
        const after = await tx.query<{value: InstanceConfig | string}>(
          'SELECT value FROM settings WHERE key = \'instance\'',
        );
        return {
          config: {...DEFAULT_INSTANCE_CONFIG, ...parseJson<Partial<InstanceConfig>>(after[0]?.value, {})},
          claimed: false,
        };
      }
      this.bumpAccess(); // a fresh owner claim narrows the guest gate (Collab T1)
      return {config: next, claimed: true};
    });
  }

  /**
   * Re-point a CLAIMED `ownerSubject` (the claim-once escape hatch). Issuer or
   * subject drift — an account migration, a re-issued identity — leaves the real
   * owner permanently mismatched against the pinned `iss#sub`, and
   * {@link updateInstanceConfig} correctly refuses to touch it (409). This is the
   * one sanctioned mutation: swap the pin to another verified subject, WITHOUT
   * re-running the §2.6 claim bootstrap (visibility/guest-gate/authority were set
   * at the original claim and must not be re-tightened by a repair). WHO may call
   * this is the route's job (machine owner over the trusted local transport, to
   * their own verified subject only — never clearable, so the rule-0
   * anonymous-world-write short-circuit can never be re-opened by a repair).
   * Repairing an UNCLAIMED instance is refused — that's a claim, and claims go
   * through the {@link claimOwnership} CAS.
   */
  async repairOwnership(subject: string): Promise<InstanceConfig> {
    return this.db.begin(async (tx) => {
      const rows = await tx.query<{value: InstanceConfig | string}>(
        'SELECT value FROM settings WHERE key = \'instance\' FOR UPDATE',
      );
      const current: InstanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        ...parseJson<Partial<InstanceConfig>>(rows[0]?.value, {}),
      };
      if (!current.ownerSubject) {
        throw new HTTPException(409, {message: 'this instance is unclaimed — ownership must be claimed, not repaired'});
      }
      if (current.ownerSubject === subject) return current; // idempotent no-op
      const next: InstanceConfig = {...current, ownerSubject: subject};
      await tx.query(
        'UPDATE settings SET value = $1::jsonb WHERE key = \'instance\'',
        [JSON.stringify(next)],
      );
      this.bumpAccess(); // the owner rung of every decision just moved (Collab T1)
      return next;
    });
  }

  // ── Scheduled-backup policy (OB-166) ──────────────────────────────────────────

  /** The scheduled-backup policy, with defaults filled in. */
  async getBackupConfig(): Promise<BackupConfig> {
    const rows = await this.db.query<{value: BackupConfig | string}>(
      'SELECT value FROM settings WHERE key = \'backups\'',
    );
    const stored = rows.length > 0 ? parseJson<Partial<BackupConfig>>(rows[0].value, {}) : {};
    return {
      ...DEFAULT_BACKUP_CONFIG,
      ...stored,
      // Nested records merge so a newly-added cadence keeps its default.
      cadences: {...DEFAULT_BACKUP_CONFIG.cadences, ...stored.cadences},
      keep: {...DEFAULT_BACKUP_CONFIG.keep, ...stored.keep},
      lastRun: {...stored.lastRun},
    };
  }

  /** Shallow-merge a patch into the backup policy and persist it. */
  async updateBackupConfig(patch: Partial<BackupConfig>): Promise<BackupConfig> {
    const current = await this.getBackupConfig();
    const next: BackupConfig = {
      ...current,
      ...patch,
      cadences: {...current.cadences, ...patch.cadences},
      keep: {...current.keep, ...patch.keep},
      lastRun: {...current.lastRun, ...patch.lastRun},
    };
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ('backups', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }

  // ── Sharing & access: roster, per-page visibility + ACL (OB-189) ──────────────
  //
  // Storage ops behind the OB-182 §1 `authorize()` decision. This layer is pure
  // CRUD + the §4.3 invite-claim rewrite; it does NOT enforce access on routes or
  // streams (that wiring — `requireAccess`, principal-aware fan-out, the request →
  // `AccessCtx` build — is OB-190) and it does not resolve `inherit` up the parent
  // chain (the effective-visibility walk is assembled by OB-190 from these reads).

  /** Every roster row, newest first. */
  async listMembers(): Promise<Member[]> {
    const rows = await this.db.query<MemberRow>(
      `SELECT ${MEMBER_COLS} FROM members ORDER BY created_at DESC`,
    );
    return rows.map(memberFromRow);
  }

  /**
   * Add a roster row (OB-182 §2.1). A row is an EMAIL PERSONA (`email` set,
   * `subject` NULL until claimed) or a SUBJECT/handle MEMBER (`subject` set).
   * `status` is **required and always written explicitly** — an email invite must
   * pass `status='invited'` and never inherit the column's `'active'` default
   * (Sasha N1). For an email row, `issuer` pins the email-authority (B1); it
   * defaults to the instance's `emailAuthority` when omitted.
   */
  async addMember(input: AddMemberInput): Promise<Member> {
    const email = normalizeEmail(input.email);
    const subject = input.subject ?? null;
    if (!email && !subject) throw new Error('a member needs a subject or an email');
    const issuer = input.issuer ?? (await this.getInstanceConfig()).emailAuthority ?? DEFAULT_ACCOUNT_URL;
    const rows = await this.db.query<MemberRow>(
      `INSERT INTO members (id, subject, email, issuer, role, status, source, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${MEMBER_COLS}`,
      [randomUUID(), subject, email, issuer, input.role ?? 'viewer', input.status, input.source ?? 'local', input.invitedBy ?? null],
    );
    this.bumpAccess(); // a new roster grant can change decisions (Collab T1)
    return memberFromRow(rows[0]);
  }

  /** Patch a roster row's bound subject / role / status (activate, suspend, …). */
  async updateMember(id: string, patch: MemberPatch): Promise<Member | null> {
    const rows = await this.db.query<MemberRow>(
      `UPDATE members SET
         subject = COALESCE($2, subject),
         role    = COALESCE($3, role),
         status  = COALESCE($4, status)
       WHERE id = $1
       RETURNING ${MEMBER_COLS}`,
      [id, patch.subject ?? null, patch.role ?? null, patch.status ?? null],
    );
    if (rows.length > 0) this.bumpAccess(); // role/status change alters decisions (Collab T1)
    return rows.length > 0 ? memberFromRow(rows[0]) : null;
  }

  /** Remove a roster row by id. */
  async removeMember(id: string): Promise<boolean> {
    const rows = await this.db.query('DELETE FROM members WHERE id = $1 RETURNING id', [id]);
    if (rows.length > 0) this.bumpAccess(); // a revoked grant removes access (Collab T1)
    return rows.length > 0;
  }

  /**
   * Reconcile the bound workspace's roster into the local `members` table (OB-199)
   * — the durable side of "instance ↔ workspace". The desired set (already
   * owner-reconciled + deduped + site-owner-filtered by the caller) is projected
   * onto `source='managed'` rows ONLY; `source='local'` rows (the OB-191 invite
   * path) are never read-for-write nor deleted, so a local invite and a managed
   * member coexist. The whole reconcile runs in one transaction:
   *
   *  - **upsert** a managed row per desired entry (insert when absent; on an
   *    existing managed row only the `role` is reconciled — `subject`/`status` are
   *    owned by the claim flow and never downgraded by a later sync);
   *  - **remove** managed rows no longer in the desired set (dropped from the
   *    workspace) — never a local row;
   *  - **skip** a desired entry whose identity a LOCAL row already covers (don't
   *    clobber the local invite, and don't collide on the unique index — coexist).
   *
   * Each entry is stored in one of the two roster shapes (§2.1): a `subject`-keyed
   * member (`status='active'`) when a bound subject is known, else an `email`
   * persona (`status='invited'`, bound on first sign-in by {@link claimMemberships}).
   * Idempotent — an unchanged roster is a no-op.
   */
  async syncManagedRoster(desired: ManagedMemberInput[]): Promise<RosterSyncResult> {
    return this.db.begin(async (tx) => {
      const rows = await tx.query<MemberRow>(`SELECT ${MEMBER_COLS} FROM members`);
      // Index existing rows by their identity keys, partitioned by provenance.
      const managedBySubject = new Map<string, MemberRow>();
      const managedByEmail = new Map<string, MemberRow>();
      const localSubjects = new Set<string>();
      const localEmails = new Set<string>();
      for (const row of rows) {
        const email = row.email ? row.email.toLowerCase() : null;
        if (row.source === 'managed') {
          if (row.subject) managedBySubject.set(row.subject, row);
          if (email) managedByEmail.set(email, row);
        } else {
          if (row.subject) localSubjects.add(row.subject);
          if (email) localEmails.add(email);
        }
      }

      const kept = new Set<string>();
      let added = 0;
      let updated = 0;
      let skipped = 0;

      const reconcileRole = async (row: MemberRow, role: MemberRole): Promise<void> => {
        kept.add(row.id);
        // Only the role is reconciled — never the binding (subject/status), which a
        // claimed managed persona owns; a later sync must not unbind or demote it.
        if (row.role !== role) {
          await tx.query('UPDATE members SET role = $2 WHERE id = $1', [row.id, role]);
          updated += 1;
        }
      };

      for (const want of desired) {
        if (want.subject) {
          const existing = managedBySubject.get(want.subject);
          if (existing) {
            await reconcileRole(existing, want.role);
            continue;
          }
          // A local invite already grants this subject — leave it authoritative.
          if (localSubjects.has(want.subject)) {
            skipped += 1;
            continue;
          }
          await tx.query(
            `INSERT INTO members (id, subject, email, issuer, role, status, source)
             VALUES ($1, $2, NULL, $3, $4, 'active', 'managed')`,
            [randomUUID(), want.subject, want.issuer, want.role],
          );
          added += 1;
        } else if (want.email) {
          const email = want.email.toLowerCase();
          const existing = managedByEmail.get(email);
          if (existing) {
            await reconcileRole(existing, want.role);
            continue;
          }
          // A local invite/persona already owns this email — don't clobber/collide.
          if (localEmails.has(email)) {
            skipped += 1;
            continue;
          }
          await tx.query(
            `INSERT INTO members (id, subject, email, issuer, role, status, source)
             VALUES ($1, NULL, $2, $3, $4, 'invited', 'managed')`,
            [randomUUID(), email, want.issuer, want.role],
          );
          added += 1;
        }
      }

      // Remove managed rows the workspace dropped — local rows are untouched.
      let removed = 0;
      for (const row of rows) {
        if (row.source !== 'managed' || kept.has(row.id)) continue;
        await tx.query('DELETE FROM members WHERE id = $1', [row.id]);
        removed += 1;
      }

      // Any roster change can alter a live decision (Collab T1); a pure no-op
      // reconcile leaves the epoch untouched so caches survive.
      if (added > 0 || updated > 0 || removed > 0) this.bumpAccess();
      return {added, updated, removed, skipped};
    });
  }

  /**
   * Resolve the principal's request-time roster role (OB-182 §2.1 / S3) — the
   * input to `AccessCtx.role`. Only `status='active'` rows bound to the
   * principal's `subject` count; a pure subject/handle member matches on subject
   * alone (any trusted issuer), a persona row additionally requires the ACTIVE
   * persona email under the pinned authority (`lower(email)==principal.email` AND
   * `issuer==emailAuthority`, B1). `invited`/`suspended` rows grant nothing, and
   * an email match NEVER yields a role directly. Returns the highest matching
   * role (admin ≻ viewer), or `null`. Non-`jws` principals always resolve to
   * `null` (N8 — guest/local/unverified are never roster members).
   */
  async resolveMemberRole(principal: Principal, cfg?: InstanceConfig): Promise<MemberRole | null> {
    if (principal.verifiedVia !== 'jws') return null;
    const config = cfg ?? (await this.getInstanceConfig());
    const emailOk = isEmailAuthoritative(principal, config) && !!principal.email;
    const personaEmail = principal.email?.toLowerCase();
    const rows = await this.db.query<{role: string; email: string | null; issuer: string}>(
      'SELECT role, email, issuer FROM members WHERE status = \'active\' AND subject = $1',
      [principal.subject],
    );
    let best: MemberRole | null = null;
    for (const row of rows) {
      const matches =
        row.email === null
          ? true // pure subject/handle member — bound subject is enough
          : emailOk && row.email.toLowerCase() === personaEmail && row.issuer === config.emailAuthority;
      if (matches) best = higherRole(best, row.role);
    }
    return best;
  }

  /**
   * The caller's *effective* instance role (P1-8) — what {@link InstanceInfo.youRole}
   * returns. Mirrors the `authorize()` ownership ladder so the UI reads from the
   * SAME source of truth as write enforcement:
   *
   *  - `owner` — the claimed owner (`jws` && `subject===ownerSubject`), or the
   *    loopback owner (`verifiedVia==='local'`).
   *  - `admin` / `viewer` — the active-persona roster role (via {@link resolveMemberRole}).
   *  - `null` — no special role (a guest / signed-in stranger).
   *
   * The `local` rung is here for defensive parity with `authorize()` (rule 1), NOT
   * the desktop request path: `resolvePrincipal` only ever yields `guest | jws |
   * unverified` — a `local` principal never arrives over a request (app.ts), and the
   * in-webview {@link LocalDataClient} hardcodes `owner` without calling this. Over
   * the desktop-owner IPC path this therefore returns `owner` when signed-in +
   * claimed, or `null` when the instance is still unclaimed (the caller is a guest
   * here); write in that unclaimed case is preserved by the CLIENT's coarse
   * guest-gate fallback (default `guestAccess:'write'`) — which must not be deleted
   * on the mistaken belief that the `local` rung covers the desktop owner.
   *
   * UI-only: a viewer renders read-only chrome, everyone else keeps whatever the
   * server's per-page `authorize()` actually grants.
   */
  async resolveEffectiveRole(principal: Principal, cfg?: InstanceConfig): Promise<EffectiveRole | null> {
    if (principal.verifiedVia === 'local') return 'owner'; // rule 1 (loopback owner)
    const config = cfg ?? (await this.getInstanceConfig());
    if (
      config.ownerSubject != null &&
      principal.verifiedVia === 'jws' &&
      principal.subject === config.ownerSubject
    ) {
      return 'owner'; // rule 2 (claimed owner)
    }
    return this.resolveMemberRole(principal, config); // rule 4 (roster) → admin | viewer | null
  }

  /** A page's stored visibility scope (raw — `inherit` not yet resolved), or
   *  `null` when the page doesn't exist. */
  async getPageVisibility(pageId: string): Promise<PageVisibility | null> {
    const rows = await this.db.query<{visibility: string}>(
      'SELECT visibility FROM pages WHERE id = $1',
      [pageId],
    );
    return rows.length > 0 ? (rows[0].visibility as PageVisibility) : null;
  }

  /** Set a page's visibility scope. Returns `false` when the page is missing.
   *  Deliberately does NOT touch `updated_at`: visibility is an access attribute,
   *  not document content, so it must not look like an edit to the mirror/mtimes. */
  async setPageVisibility(pageId: string, visibility: PageVisibility): Promise<boolean> {
    const rows = await this.db.query(
      'UPDATE pages SET visibility = $2 WHERE id = $1 RETURNING id',
      [pageId, visibility],
    );
    if (rows.length > 0) this.bumpAccess(); // scope change alters who may read (Collab T1)
    return rows.length > 0;
  }

  /** Every ACL grant on a page (OB-182 §2.3), oldest first. */
  async getPageAcl(pageId: string): Promise<PageAcl[]> {
    const rows = await this.db.query<AclRow>(
      `SELECT ${ACL_COLS} FROM page_acl WHERE page_id = $1 ORDER BY created_at ASC`,
      [pageId],
    );
    return rows.map(aclFromRow);
  }

  /**
   * Upsert a per-page ACL grant (OB-182 §2.3). Exactly one grantee key — `subject`
   * XOR `email`; an email grant pins the `issuer` (defaults to the instance's
   * `emailAuthority`, B1). `page_acl` is PK-less, so the grant is keyed on
   * `(page_id, subject)` or `(page_id, lower(email))` [Quinn]: any existing grant
   * for that key is replaced (delete-then-insert in one transaction).
   */
  async setPageAcl(pageId: string, grant: AclGrantInput): Promise<PageAcl> {
    const email = normalizeEmail(grant.email);
    const subject = grant.subject ?? null;
    if (!subject === !email) {
      throw new Error('a page ACL grant needs exactly one of subject or email');
    }
    const issuer = email
      ? (grant.issuer ?? (await this.getInstanceConfig()).emailAuthority ?? DEFAULT_ACCOUNT_URL)
      : null;
    return this.db.begin(async (tx) => {
      if (subject) {
        await tx.query('DELETE FROM page_acl WHERE page_id = $1 AND subject = $2', [pageId, subject]);
      } else {
        await tx.query('DELETE FROM page_acl WHERE page_id = $1 AND lower(email) = $2', [pageId, email]);
      }
      const rows = await tx.query<AclRow>(
        `INSERT INTO page_acl (page_id, subject, email, issuer, level, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${ACL_COLS}`,
        [pageId, subject, email, issuer, grant.level, grant.invitedBy ?? null],
      );
      return aclFromRow(rows[0]);
    }).then((acl) => {
      this.bumpAccess(); // a new per-page grant changes read decisions (Collab T1)
      return acl;
    });
  }

  /** Remove a per-page ACL grant, keyed on `(page_id, subject)` or
   *  `(page_id, lower(email))` [Quinn]. */
  async removePageAcl(pageId: string, key: AclKey): Promise<boolean> {
    const rows =
      'subject' in key
        ? await this.db.query('DELETE FROM page_acl WHERE page_id = $1 AND subject = $2 RETURNING page_id', [
          pageId,
          key.subject,
        ])
        : await this.db.query(
          'DELETE FROM page_acl WHERE page_id = $1 AND lower(email) = $2 RETURNING page_id',
          [pageId, normalizeEmail(key.email)],
        );
    if (rows.length > 0) this.bumpAccess(); // a revoked grant removes read access (Collab T1)
    return rows.length > 0;
  }

  /**
   * The invite-claim rewrite (OB-182 §4.3 step 3) — the storage primitive that
   * binds an email persona to the now-signed-in subject. MANDATORY (N10): once a
   * principal presents an authoritative persona JWS, every `invited` roster row
   * and every `email` ACL grant under the same pinned issuer is rewritten to be
   * subject-keyed, so all future lookups go by subject and a later email change
   * can never silently re-open access. Runs in one transaction:
   *  - `members`: bind `subject` + flip `status` `'invited'→'active'` (email kept).
   *  - `page_acl`: rewrite to `subject`, clearing `email`/`issuer` — first dropping
   *    any email grant that would collide with an existing subject grant on the
   *    same page (the `(page_id, subject)` unique index).
   * A no-op for a non-authoritative principal. Returns the rows touched.
   *
   * Note: *triggering* this on sign-in / per request is enforcement wiring — left
   * to OB-190/191; this method is the complete, reusable storage operation.
   */
  async claimMemberships(principal: Principal): Promise<{members: number; acls: number}> {
    const config = await this.getInstanceConfig();
    if (!isEmailAuthoritative(principal, config) || !principal.email || !config.emailAuthority) {
      return {members: 0, acls: 0};
    }
    const email = principal.email.toLowerCase();
    const authority = config.emailAuthority;
    const subject = principal.subject;
    return this.db.begin(async (tx) => {
      const members = await tx.query(
        `UPDATE members SET subject = $1, status = 'active'
          WHERE status = 'invited' AND subject IS NULL AND lower(email) = $2 AND issuer = $3
          RETURNING id`,
        [subject, email, authority],
      );
      await tx.query(
        `DELETE FROM page_acl pa
          WHERE pa.email IS NOT NULL AND lower(pa.email) = $1 AND pa.issuer = $2
            AND EXISTS (SELECT 1 FROM page_acl s WHERE s.page_id = pa.page_id AND s.subject = $3)`,
        [email, authority, subject],
      );
      const acls = await tx.query(
        `UPDATE page_acl SET subject = $1, email = NULL, issuer = NULL
          WHERE email IS NOT NULL AND lower(email) = $2 AND issuer = $3
          RETURNING page_id`,
        [subject, email, authority],
      );
      // A claim re-keys invited grants to the now-signed-in subject — its access
      // is live this same request, so invalidate the live read-gate cache too.
      if (members.length > 0 || acls.length > 0) this.bumpAccess();
      return {members: members.length, acls: acls.length};
    });
  }

  // ── Access enforcement: AccessCtx build + default-deny reads (OB-190) ─────────
  //
  // The request → `authorize()` wiring (contract §1.4). The pure decision lives in
  // the SDK; this layer composes its inputs from storage — the active-persona role
  // (ONLY ever via {@link resolveMemberRole}, jws-gated + authority-pinned, S3/N8),
  // the post-`inherit` effective visibility (inherit→default + db-row→host page,
  // N9; the ancestor PARENT walk is OB-207, deliberately NOT here), and the
  // email-authority gate — then calls `authorize`. The `…For` reads are
  // **default-deny by construction**: a route that forgets to gate still gets only
  // what the caller may read.

  /**
   * Resolve the page-INDEPENDENT inputs to a decision once (config, the principal's
   * role, the email-authority gate) so a list/stream pass evaluates many pages
   * against one roster lookup. `role` is sourced **only** from
   * {@link resolveMemberRole} (single producer — no alternate role path, N8).
   */
  async accessBase(principal: Principal, cfg?: InstanceConfig): Promise<AccessBase> {
    const full = cfg ?? (await this.getInstanceConfig());
    const role = await this.resolveMemberRole(principal, full);
    return {
      full,
      role,
      config: {
        guestAccess: full.guestAccess,
        ownerSubject: full.ownerSubject,
        defaultVisibility: full.defaultVisibility,
        emailAuthority: full.emailAuthority,
      },
      emailIsAuthoritative: isEmailAuthoritative(principal, full),
    };
  }

  /** The page's stored scope + database membership (NO `deleted_at` filter, so it
   *  resolves a trashed page or a database row alike), or `null` if absent. */
  private async pageAccessRow(pageId: string): Promise<{visibility: PageVisibility; databaseId: string | null} | null> {
    const rows = await this.db.query<{visibility: string; database_id: string | null}>(
      'SELECT visibility, database_id FROM pages WHERE id = $1',
      [pageId],
    );
    if (rows.length === 0) return null;
    return {visibility: rows[0].visibility as PageVisibility, databaseId: rows[0].database_id ?? null};
  }

  /** Resolve `inherit` to an effective scope (§2.2/N9): a database row via its
   *  database HOST PAGE, an ordinary page straight to the instance default. The
   *  ancestor PARENT walk (and the host's own parent walk) is OB-207.
   *
   *  Collab T1 (access epoch) hook: because this does NOT yet walk ancestors, a
   *  page's read decision depends only on its OWN visibility/ACL — so `movePage`
   *  needs no `bumpAccess`. WHEN OB-207 makes a parent's scope inheritable, a
   *  parent's visibility/ACL change AND a reparent both become read-relevant for the
   *  whole subtree, and each must then `bumpAccess()` (see the note in `movePage`)
   *  so the live read-gate cache (`streamGates`) can't serve a stale decision. */
  private async effectiveVisibility(
    row: {visibility: PageVisibility; databaseId: string | null},
    base: AccessBase,
  ): Promise<EffectiveVisibility> {
    const fallback = (base.full.defaultVisibility ?? 'members') as EffectiveVisibility;
    if (row.visibility !== 'inherit') return row.visibility;
    if (row.databaseId) {
      const db = await this.getDatabase(row.databaseId);
      if (db) {
        const host = await this.pageAccessRow(db.pageId);
        if (host && host.visibility !== 'inherit') return host.visibility as EffectiveVisibility;
      }
    }
    return fallback;
  }

  /** The per-page ACL grants as `authorize()` consumes them (nulls → absent). */
  private async aclEntries(pageId: string): Promise<AclEntry[]> {
    const acl = await this.getPageAcl(pageId);
    return acl.map((a) => ({
      ...(a.subject ? {subject: a.subject} : {}),
      ...(a.email ? {email: a.email} : {}),
      ...(a.issuer ? {issuer: a.issuer} : {}),
      level: a.level,
    }));
  }

  /**
   * The full {@link authorize} decision for a principal on one page. `exists` is
   * false when the page row is gone (caller maps to 404 / hide-existence). Pass a
   * shared {@link AccessBase} to amortise the roster lookup across a batch.
   */
  async decidePageAccess(
    principal: Principal,
    pageId: string,
    base?: AccessBase,
  ): Promise<{decision: Decision; exists: boolean}> {
    const row = await this.pageAccessRow(pageId);
    if (!row) return {decision: {canRead: false, canWrite: false, reason: 'no-page'}, exists: false};
    const b = base ?? (await this.accessBase(principal));
    const effectiveVisibility = await this.effectiveVisibility(row, b);
    const acl = await this.aclEntries(pageId);
    const decision = authorize(
      principal,
      {visibility: row.visibility, acl},
      {config: b.config, role: b.role, effectiveVisibility, emailIsAuthoritative: b.emailIsAuthoritative},
    );
    return {decision, exists: true};
  }

  /**
   * The write decision for CREATING a brand-new top-level page (no row to gate
   * yet): `authorize` against a synthetic page at the instance default scope with
   * no ACL — so only local-owner / owner / admin may create on a claimed instance
   * (a viewer / jws non-member / guest gets `canWrite:false`). Parent-derived
   * create rights are an OB-207 refinement.
   */
  async decideCreateAccess(principal: Principal, base?: AccessBase): Promise<Decision> {
    const b = base ?? (await this.accessBase(principal));
    const effectiveVisibility = (b.full.defaultVisibility ?? 'members') as EffectiveVisibility;
    return authorize(
      principal,
      {visibility: 'inherit', acl: []},
      {config: b.config, role: b.role, effectiveVisibility, emailIsAuthoritative: b.emailIsAuthoritative},
    );
  }

  /**
   * Page-independent read fast-path: `true` ⇒ the principal reads every page,
   * `false` ⇒ none, `null` ⇒ decide per page. Covers exactly the rungs of
   * `authorize` that don't look at the page (rule-0 unclaimed short-circuit,
   * local-owner, owner, admin); ACL + visibility scope stay per-page.
   */
  private blanketRead(principal: Principal, base: AccessBase): boolean | null {
    const {config} = base;
    const privileged = principal.verifiedVia === 'jws' || principal.verifiedVia === 'local';
    if (config.ownerSubject === undefined) return config.guestAccess !== 'off' || privileged;
    if (principal.verifiedVia === 'local') return true;
    if (principal.verifiedVia === 'jws' && principal.subject === config.ownerSubject) return true;
    if (base.role === 'admin') return true;
    return null;
  }

  /** May the principal read this page? (existence-aware: a missing page ⇒ false). */
  async canReadPage(principal: Principal, pageId: string, base?: AccessBase): Promise<boolean> {
    const {decision, exists} = await this.decidePageAccess(principal, pageId, base);
    return exists && decision.canRead;
  }

  /** May the principal read this database? Inherits its HOST PAGE's read decision. */
  async canReadDatabase(principal: Principal, databaseId: string, base?: AccessBase): Promise<boolean> {
    const db = await this.getDatabase(databaseId);
    if (!db) return false;
    return this.canReadPage(principal, db.pageId, base);
  }

  /** Filter a page-meta list to the readable subset (default-deny). */
  async filterReadablePages(principal: Principal, metas: PageMeta[], base?: AccessBase): Promise<PageMeta[]> {
    if (metas.length === 0) return metas;
    const b = base ?? (await this.accessBase(principal));
    const blanket = this.blanketRead(principal, b);
    if (blanket !== null) return blanket ? metas : [];
    const out: PageMeta[] = [];
    for (const meta of metas) {
      if (await this.canReadPage(principal, meta.id, b)) out.push(meta);
    }
    return out;
  }

  /** The live page list, filtered to what the principal may read. */
  async listPagesFor(principal: Principal): Promise<PageMeta[]> {
    return this.filterReadablePages(principal, await this.listPages());
  }

  /** Filter a database's rows to the readable subset (default-deny). A row is a
   *  page, so its own visibility/ACL governs — defaulting to the host page (N9). */
  async filterReadableRows(
    principal: Principal,
    rows: DatabaseRow[],
    base?: AccessBase,
  ): Promise<DatabaseRow[]> {
    if (rows.length === 0) return rows;
    const b = base ?? (await this.accessBase(principal));
    const blanket = this.blanketRead(principal, b);
    if (blanket !== null) return blanket ? rows : [];
    const out: DatabaseRow[] = [];
    for (const row of rows) {
      if (await this.canReadPage(principal, row.id, b)) out.push(row);
    }
    return out;
  }

  /** A database's rows, gated on host-page read then filtered per row. */
  async listRowsFor(principal: Principal, databaseId: string): Promise<DatabaseRow[]> {
    const base = await this.accessBase(principal);
    if (!(await this.canReadDatabase(principal, databaseId, base))) return [];
    return this.filterReadableRows(principal, await this.listRows(databaseId), base);
  }

  /** Read-gated single page (live only — a trashed page reads as absent, as today). */
  async getPageFor(principal: Principal, id: string): Promise<StoredPage | null> {
    const {decision, exists} = await this.decidePageAccess(principal, id);
    if (!exists || !decision.canRead) return null;
    return this.getPage(id);
  }

  // ── Assets: content-addressed binary store (OB-ASSETS A1) ────────────────────

  /**
   * Store binary `bytes` under their SHA-256 content hash (dedup: byte-identical
   * uploads collapse to ONE row). Returns the id. `ON CONFLICT DO NOTHING` keeps
   * the first-seen `mime`/`size` for a given content — mime is metadata *about the
   * bytes*, and the bytes (hence the id) are what a caller re-uploads, so a second
   * upload of the same content is a pure no-op. Does NOT gate or ref — the route
   * gates the upload and refs the asset to a page.
   *
   * `mime` MUST already be a sanitized, safe-to-serve type (the route runs
   * `safeAssetMime` before calling in — an allowlisted image or
   * `application/octet-stream`). Because only sanitized mimes are ever stored, the
   * first-seen-mime dedup above can never be poisoned into serving an executable
   * type (the stored-XSS defense; see the upload route).
   *
   * `opts.maxTotalBytes` (Assets A6) enforces a per-instance total-storage budget:
   * storing a NEW asset that would push `SUM(size)` past the budget throws
   * {@link AssetBudgetError} (→ route 507) instead of inserting. A byte-identical
   * re-upload of already-stored content is always allowed — dedup adds no bytes, so
   * the budget can never wedge a workspace out of re-saving content it already holds.
   * The check + insert are ONE statement so no window exists between reading `SUM`
   * and inserting on the embedded store (PGlite serializes every query through its
   * mutex). On real Postgres under READ COMMITTED two concurrent uploads can each
   * read the same pre-insert `SUM` and both pass — a BOUNDED overshoot of at most
   * one in-flight asset per racing writer (≤10 MiB each), which is fine for a
   * generous soft budget; the periodic GC reclaims any slack. Absent/negative budget
   * ⇒ unbudgeted (legacy behavior).
   */
  async putAsset(bytes: Uint8Array, mime: string, opts: {maxTotalBytes?: number} = {}): Promise<{id: string}> {
    const id = await assetHash(bytes);
    // Bind a Buffer. PGlite accepts a bare Uint8Array or a Buffer; the remote
    // postgres.js (porsager) driver serializes a Buffer to BYTEA. Buffer is the
    // shape both accept — belt-and-braces, not strictly required by either today.
    const buf = Buffer.from(bytes);
    const budget = opts.maxTotalBytes;
    if (budget != null && budget >= 0) {
      // Atomic budget-guarded insert. The row lands only if the asset already
      // exists (dedup — no new bytes) OR the running total plus this asset's size
      // stays within budget. `RETURNING id` is non-empty ONLY on a fresh insert;
      // an empty result means either a dedup no-op (id already present) or a budget
      // rejection (new content that didn't fit) — distinguished by a follow-up
      // existence check below.
      // `$5`/`$6` are a separate bigint copy of the size + the budget so the size
      // parameter ($4, the int4 `size` column) isn't deduced into the bigint SUM
      // arithmetic too (PGlite rejects a parameter with two inferred types).
      const inserted = await this.db.query<{id: string}>(
        `INSERT INTO assets (id, bytes, mime, size)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (SELECT 1 FROM assets WHERE id = $1)
            OR COALESCE((SELECT SUM(size) FROM assets), 0) + $5::bigint <= $6::bigint
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, buf, mime, bytes.byteLength, bytes.byteLength, budget],
      );
      if (inserted.length > 0) return {id}; // freshly stored within budget
      // No fresh insert: either the content was already present (dedup — fine) or
      // it's new and over budget. A present row ⇒ dedup; an absent one ⇒ reject.
      const exists = await this.db.query<{one: number}>('SELECT 1 AS one FROM assets WHERE id = $1', [id]);
      if (exists.length > 0) return {id};
      throw new AssetBudgetError(await this.assetStorageBytes(), bytes.byteLength, budget);
    }
    await this.db.query(
      `INSERT INTO assets (id, bytes, mime, size) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, buf, mime, bytes.byteLength],
    );
    return {id};
  }

  /** Total bytes currently held in the asset store (`SUM(size)`, 0 when empty) —
   *  the figure the A6 storage budget is measured against. */
  async assetStorageBytes(): Promise<number> {
    const rows = await this.db.query<{total: string | number | null}>(
      'SELECT COALESCE(SUM(size), 0) AS total FROM assets',
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** Fetch an asset's bytes + mime + size by content-hash id, or `null` if absent.
   *  UNGATED — call {@link getAssetFor} on the request path.
   *
   *  BYTEA comes back as a `Uint8Array` from PGlite and from postgres.js alike (and
   *  as a `\x…` hex string from some other drivers); {@link toBytes} normalizes all
   *  three. All current tests run on PGlite — the postgres.js path shares the exact
   *  same SQL and is covered by the driver's documented BYTEA↔Uint8Array contract. */
  async getAsset(id: string): Promise<{bytes: Uint8Array; mime: string; size: number} | null> {
    const rows = await this.db.query<{bytes: Uint8Array | string; mime: string; size: number | string}>(
      'SELECT bytes, mime, size FROM assets WHERE id = $1',
      [id],
    );
    if (rows.length === 0) return null;
    return {bytes: toBytes(rows[0].bytes), mime: rows[0].mime, size: Number(rows[0].size)};
  }

  /**
   * Record that `pageId` references `assetId` — the reachability/gating edge. An
   * asset inherits the read-gate of every page that references it, so ref-ing it to
   * a page the caller can write makes it reachable to that page's readers.
   * Idempotent (composite PK ⇒ a repeat ref is a no-op).
   */
  async refAsset(assetId: string, pageId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO asset_refs (asset_id, page_id) VALUES ($1, $2)
       ON CONFLICT (asset_id, page_id) DO NOTHING`,
      [assetId, pageId],
    );
  }

  /** Drop a page's reference to an asset (the inverse of {@link refAsset}). */
  async unrefAsset(assetId: string, pageId: string): Promise<void> {
    await this.db.query('DELETE FROM asset_refs WHERE asset_id = $1 AND page_id = $2', [assetId, pageId]);
  }

  /** The page ids that reference an asset — its reachability set (the pages whose
   *  read-gate the asset inherits). Empty ⇒ the asset is unreachable. */
  async pagesReferencingAsset(assetId: string): Promise<string[]> {
    const rows = await this.db.query<{page_id: string}>(
      'SELECT page_id FROM asset_refs WHERE asset_id = $1',
      [assetId],
    );
    return rows.map((r) => r.page_id);
  }

  /**
   * May the principal read this asset? True iff they can read at least one page
   * that references it — the asset inherits its referencing pages' read-gate. An
   * asset with no reachable/readable referencing page is invisible (default-deny,
   * no existence oracle: an absent asset and an unreadable one answer alike). The
   * roster lookup is amortised across the (usually one) referencing pages via a
   * shared {@link AccessBase}.
   */
  async canReadAsset(principal: Principal, assetId: string): Promise<boolean> {
    const pageIds = await this.pagesReferencingAsset(assetId);
    if (pageIds.length === 0) return false;
    const base = await this.accessBase(principal);
    for (const pageId of pageIds) {
      if (await this.canReadPage(principal, pageId, base)) return true;
    }
    return false;
  }

  /** Read-gated asset fetch: the bytes+mime iff the principal can read a referencing
   *  page, else `null` (route → 404, no existence oracle). */
  async getAssetFor(
    principal: Principal,
    id: string,
  ): Promise<{bytes: Uint8Array; mime: string; size: number} | null> {
    if (!(await this.canReadAsset(principal, id))) return null;
    return this.getAsset(id);
  }

  /**
   * Garbage-collect assets no page document actually uses (Assets A6). Folded into
   * the OB-164 maintenance job so orphaned binary blobs don't accumulate on the
   * autovacuum-less embedded store.
   *
   * **Why the document scan is the source of truth (the safety property).**
   * `asset_refs` can be STALE: A2 refs an asset to its *hosting* page at upload,
   * but a block that MOVES to a different page keeps only the original page's ref
   * (block-move re-ref is a deferred follow-up). So an asset can have ZERO refs
   * while a moved block on ANOTHER page still renders it. Trusting `asset_refs`
   * alone would reap that asset → a broken image. Instead we treat every page's
   * stored document as the truth: an asset is reapable only when its 64-hex content
   * id appears in NO page's `data` OR `properties` — the `image` block's plain-text
   * `assetId` always lands in the `data` blockdoc JSON projection, and `properties`
   * (cover config, future uploadable file-attachment fields) is scanned too so an
   * assetId that starts landing there the day such a feature ships is not silently
   * reaped. The `NOT EXISTS asset_refs` clause is a cheap, conservative pre-filter
   * (an asset that still has any ref is kept regardless), and the id-in-document scan
   * is the confirming check that makes the GC block-move-safe: 0 refs but present in a
   * page document ⇒ KEPT.
   *
   * **Includes TRASHED pages (data-loss fix).** The scan does NOT filter on
   * `deleted_at` — a soft-deleted page is restorable for the whole trash-retention
   * window (30d by default), far longer than the 24h GC grace. If the scan skipped
   * trashed pages, an asset kept ONLY by the document of a page that was just trashed
   * (the 0-ref block-move/copy case this scan exists for) would be reaped 24h later,
   * and restoring the page within retention would surface a permanently broken image.
   * Keeping an asset while ANY page's document (live or trashed) references it aligns
   * asset GC with trash retention: the asset becomes reapable only once its last
   * holding page is HARD-purged (which also cascade-drops any `asset_refs`).
   *
   * **Grace period.** Only assets older than `graceMs` (default 24h) are eligible,
   * so a just-uploaded asset that hasn't been saved into a page's document yet (the
   * upload lands before the autosave) is never reaped out from under a pending save.
   *
   * Conservative by construction — a false reap is a lost image, so anything
   * ambiguous is kept. The FK `asset_refs.asset_id → assets(id) ON DELETE CASCADE`
   * cleans up any (already-absent, by the pre-filter) refs when the row goes.
   * Returns what it reaped, for the maintenance-job log.
   */
  async gcUnreferencedAssets(opts: {graceMs?: number} = {}): Promise<{reaped: number; bytes: number; ids: string[]}> {
    const graceMs = Math.max(0, Math.trunc(opts.graceMs ?? 24 * 60 * 60 * 1000));
    const rows = await this.db.query<{id: string; size: number | string}>(
      `DELETE FROM assets a
       WHERE a.created_at <= now() - ($1::bigint * interval '1 millisecond')
         AND NOT EXISTS (SELECT 1 FROM asset_refs r WHERE r.asset_id = a.id)
         AND NOT EXISTS (
           SELECT 1 FROM pages p
           WHERE position(a.id IN p.data::text) > 0
              OR position(a.id IN p.properties::text) > 0
         )
       RETURNING a.id, a.size`,
      [graceMs],
    );
    let bytes = 0;
    const ids: string[] = [];
    for (const r of rows) {
      bytes += Number(r.size) || 0;
      ids.push(r.id);
    }
    return {reaped: rows.length, bytes, ids};
  }
}

/**
 * The page-independent inputs to an {@link authorize} decision, resolved once per
 * request/event by {@link PageStore.accessBase} and threaded through a batch so a
 * list/stream pass needs only one roster lookup.
 */
export interface AccessBase {
  /** The full instance policy (for default-visibility resolution). */
  full: InstanceConfig;
  /** The principal's active-persona role — ONLY from `resolveMemberRole` (N8). */
  role: MemberRole | null;
  /** The slice `authorize` consumes. */
  config: AccessCtx['config'];
  /** Whether the principal's email may drive persona / email-ACL matching (B1). */
  emailIsAuthoritative: boolean;
}

// ── Sharing & access: input shapes + row mappers (OB-189) ────────────────────

/** Input to {@link PageStore.addMember}. `status` is required (Sasha N1). */
export interface AddMemberInput {
  /** Bound `iss#sub`; omit/null for an unclaimed email persona. */
  subject?: string | null;
  /** Persona email (lowercased on write); omit for a subject/handle member. */
  email?: string | null;
  /** Pinned email-authority for a persona (B1); defaults to the instance's
   *  `emailAuthority` when omitted. */
  issuer?: string;
  role?: MemberRole;
  /** Explicit lifecycle — an email invite MUST pass `'invited'` (Sasha N1). */
  status: MemberStatus;
  /** Row provenance (OB-199); defaults to `'local'` (a hand-issued invite). The
   *  managed-roster sync passes `'managed'`. */
  source?: MemberSource;
  invitedBy?: string | null;
}

/** Patch to {@link PageStore.updateMember}; only provided fields change. */
export interface MemberPatch {
  subject?: string | null;
  role?: MemberRole;
  status?: MemberStatus;
}

/**
 * One desired managed-roster member (OB-199), already resolved by the syncer
 * (owner-reconciled, deduped, site-owner-filtered). Exactly one identity key is
 * authoritative: a bound `subject` (preferred — stored as a subject member) or an
 * `email` persona. `issuer` pins the email-authority for a persona row (B1).
 */
export interface ManagedMemberInput {
  subject: string | null;
  email: string | null;
  issuer: string;
  role: MemberRole;
}

/** Counts from a {@link PageStore.syncManagedRoster} reconcile (observability). */
export interface RosterSyncResult {
  /** Managed rows inserted (new workspace members). */
  added: number;
  /** Managed rows whose role was reconciled. */
  updated: number;
  /** Managed rows removed (dropped from the workspace). */
  removed: number;
  /** Desired entries skipped because a local invite already covers them. */
  skipped: number;
}

/** Input to {@link PageStore.setPageAcl} — exactly one grantee key. */
export interface AclGrantInput {
  subject?: string | null;
  email?: string | null;
  /** Pinned email-authority for an email grant (B1); defaults to the instance's
   *  `emailAuthority`. Ignored for a subject grant. */
  issuer?: string | null;
  level: AclLevel;
  invitedBy?: string | null;
}

/** Key identifying one ACL grant for removal: by subject XOR by email. */
export type AclKey = {subject: string} | {email: string};

/**
 * Config footgun guard (OB-182 §2.4, Sasha N2): `emailAuthority` MUST be one of
 * `trustedIssuers`. If it names an issuer the instance doesn't trust, no token
 * from it ever verifies, so every persona / email-ACL grant silently stops
 * matching — it fails *safe* (→ deny) but invisibly. Reject the write instead of
 * letting the policy drift into that dead state. Shared by `updateInstanceConfig`
 * and `claimOwnership`.
 */
function assertEmailAuthorityTrusted(config: InstanceConfig): void {
  if (config.emailAuthority && !config.trustedIssuers.some((i) => i.issuer === config.emailAuthority)) {
    throw new Error(`emailAuthority ${config.emailAuthority} must be one of trustedIssuers (OB-182 §2.4)`);
  }
}

/** Lowercase + trim an email, or `null`. */
function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Pick the higher-privilege role (admin ≻ viewer) across matching roster rows. */
function higherRole(current: MemberRole | null, next: string): MemberRole | null {
  if (next === 'admin' || current === 'admin') return 'admin';
  if (next === 'viewer' || current === 'viewer') return 'viewer';
  return current;
}

const MEMBER_COLS = 'id, subject, email, issuer, role, status, source, invited_by, created_at';

interface MemberRow {
  id: string;
  subject: string | null;
  email: string | null;
  issuer: string;
  role: string;
  status: string;
  source: string;
  invited_by: string | null;
  created_at: Date | string;
}

function memberFromRow(row: MemberRow): Member {
  return {
    id: row.id,
    subject: row.subject ?? null,
    email: row.email ?? null,
    issuer: row.issuer,
    role: row.role as MemberRole,
    status: row.status as MemberStatus,
    source: (row.source as MemberSource) ?? 'local',
    invitedBy: row.invited_by ?? null,
    createdAt: toIso(row.created_at),
  };
}

const ACL_COLS = 'page_id, subject, email, issuer, level, invited_by, created_at';

interface AclRow {
  page_id: string;
  subject: string | null;
  email: string | null;
  issuer: string | null;
  level: string;
  invited_by: string | null;
  created_at: Date | string;
}

function aclFromRow(row: AclRow): PageAcl {
  return {
    pageId: row.page_id,
    subject: row.subject ?? null,
    email: row.email ?? null,
    issuer: row.issuer ?? null,
    level: row.level as AclLevel,
    invitedBy: row.invited_by ?? null,
    createdAt: toIso(row.created_at),
  };
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
  'id, page_id, author_kind, author_name, kind, target, before_text, after_text, status, payload, ' +
  'author_subject, author_issuer, author_verified, created_at, updated_at';

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
  author_subject: string | null;
  author_issuer: string | null;
  author_verified: string | null;
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
    ...authorFields(row),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Project the server-stamped author identity columns (OB-165), omitting nulls. */
function authorFields(row: {
  author_subject: string | null;
  author_issuer: string | null;
  author_verified: string | null;
}): {authorSubject?: string; authorIssuer?: string; authorVerified?: VerifiedVia} {
  const out: {authorSubject?: string; authorIssuer?: string; authorVerified?: VerifiedVia} = {};
  if (row.author_subject) out.authorSubject = row.author_subject;
  if (row.author_issuer) out.authorIssuer = row.author_issuer;
  if (row.author_verified) out.authorVerified = row.author_verified as VerifiedVia;
  return out;
}

const COMMENT_COLS =
  'id, page_id, suggestion_id, block_id, parent_id, author_name, body, ' +
  'author_subject, author_issuer, author_verified, created_at';

interface CommentRowRecord {
  id: string;
  page_id: string;
  suggestion_id: string | null;
  block_id: string | null;
  parent_id: string | null;
  author_name: string;
  body: CommentRun[] | string | null;
  author_subject: string | null;
  author_issuer: string | null;
  author_verified: string | null;
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
    ...authorFields(row),
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
