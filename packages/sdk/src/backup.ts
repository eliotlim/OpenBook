/**
 * Whole-space backup & restore contract. A backup is one JSON bundle of every
 * live page (full data, nesting, database membership, properties) plus every
 * database; emoji `icons` are added client-side (they live in localStorage).
 *
 * Restore has two modes:
 *  - `copy` (default): import as new pages (fresh ids); names that clash with an
 *    existing live page get a `" (imported)"` suffix. Never clobbers.
 *  - `overwrite`: restore in place by id, replacing existing pages/databases. The
 *    UI double-confirms, quoting how many existing pages will be replaced.
 */
import type {StoredPage} from './types';
import type {StoredDatabase} from './database';

export const BACKUP_VERSION = 1;

export interface SpaceBackup {
  version: number;
  exportedAt: string;
  pages: StoredPage[];
  databases: StoredDatabase[];
  /** pageId → emoji icon (added client-side; ignored by the server). */
  icons?: Record<string, string>;
}

export type ImportMode = 'copy' | 'overwrite';

/** What the client sends to restore: the (already-selected) pages/databases + mode. */
export interface ImportRequest {
  pages: StoredPage[];
  databases: StoredDatabase[];
  mode: ImportMode;
}

export interface ImportResult {
  /** New pages created (copy mode, or overwrite of a not-yet-existing id). */
  created: number;
  /** Existing pages replaced (overwrite mode). */
  overwritten: number;
  /** Pages whose name was suffixed to avoid a clash (copy mode). */
  renamed: number;
  /** old page id → new page id (copy mode; identity in overwrite). */
  idMap: Record<string, string>;
}

// ── Scheduled backups (OB-166) ────────────────────────────────────────────────

/**
 * Backup cadences, in increasing interval. The server keeps a rolling set per
 * cadence (grandfather-father-son rotation), so short cadences churn fast and
 * long ones are retained sparsely — automatic, tiered data safety on top of the
 * ad-hoc export.
 */
export type BackupCadence = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const BACKUP_CADENCES: readonly BackupCadence[] = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/** Interval of each cadence, in milliseconds. */
export const BACKUP_CADENCE_MS: Record<BackupCadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

/** Scheduled-backup policy, persisted server-side in the `settings` table. */
export interface BackupConfig {
  /** Master switch — when false the scheduler is idle (the default). */
  enabled: boolean;
  /** Where backups are written; `null` = the server default (`<dataDir>/backups`). */
  dir: string | null;
  /** Which cadences are active. */
  cadences: Record<BackupCadence, boolean>;
  /** How many snapshots to retain per cadence before pruning the oldest. */
  keep: Record<BackupCadence, number>;
  /** Last successful run per cadence (ISO), so a reboot catches up overdue ones. */
  lastRun: Partial<Record<BackupCadence, string>>;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: false,
  dir: null,
  cadences: {daily: true, weekly: true, monthly: true, yearly: true},
  keep: {daily: 7, weekly: 5, monthly: 12, yearly: 3},
  lastRun: {},
};

/** A derived, per-cadence view for the UI (last/next run + how many are on disk). */
export interface BackupCadenceStatus {
  cadence: BackupCadence;
  enabled: boolean;
  lastRun: string | null;
  nextDue: string | null;
  count: number;
}

/** What `GET /api/backups` returns: the policy + resolved dir + derived status. */
export interface BackupStatus {
  config: BackupConfig;
  /** The resolved output directory (config.dir, or the server default). */
  resolvedDir: string | null;
  cadences: BackupCadenceStatus[];
}

/**
 * Pure: re-key a bundle for copy-mode import. Mints a fresh id for every page and
 * database, remaps every internal reference (`parentId`, `databaseId`,
 * `hostedDatabaseId`, a database's `pageId`, and `@`-mention `data-page-id`s
 * embedded in block HTML), and returns the rewritten pages/databases plus the
 * `oldId → newId` map. References to pages outside the bundle are left as-is.
 * Unit-tested; the store layer adds DB-aware name de-duplication on top.
 */
export function remapBundle(
  pages: StoredPage[],
  databases: StoredDatabase[],
  newId: () => string,
): {pages: StoredPage[]; databases: StoredDatabase[]; idMap: Record<string, string>} {
  const idMap: Record<string, string> = {};
  for (const p of pages) idMap[p.id] = newId();
  const dbMap: Record<string, string> = {};
  for (const d of databases) dbMap[d.id] = newId();

  const remapMentions = (data: StoredPage['data']): StoredPage['data'] => {
    let json = JSON.stringify(data);
    for (const [oldId, nid] of Object.entries(idMap)) {
      json = json.split(`data-page-id=\\"${oldId}\\"`).join(`data-page-id=\\"${nid}\\"`);
    }
    return JSON.parse(json) as StoredPage['data'];
  };

  const remappedPages = pages.map((p) => ({
    ...p,
    id: idMap[p.id],
    parentId: p.parentId && idMap[p.parentId] ? idMap[p.parentId] : null,
    databaseId: p.databaseId && dbMap[p.databaseId] ? dbMap[p.databaseId] : null,
    hostedDatabaseId: p.hostedDatabaseId && dbMap[p.hostedDatabaseId] ? dbMap[p.hostedDatabaseId] : null,
    data: remapMentions(p.data),
  }));
  const remappedDbs = databases.map((d) => ({...d, id: dbMap[d.id], pageId: idMap[d.pageId] ?? d.pageId}));
  return {pages: remappedPages, databases: remappedDbs, idMap};
}
