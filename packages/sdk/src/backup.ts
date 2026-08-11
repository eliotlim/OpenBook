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
import type {AclLevel, AgentEditsPolicy, PageVisibility, StoredPage} from './types';
import type {StoredDatabase} from './database';
import type {LedgerAuditEvent} from './ledger';

/**
 * Version 3 (OB-699) is the first lossless whole-library contract: every asset
 * referenced by a live page is carried once by content hash, and every page's
 * stored visibility / ACL / agent-edit policy is explicit. Readers still accept
 * v1/v2, but must report their known omissions as a partial restore.
 */
export const BACKUP_VERSION = 3;

/**
 * One content-addressed asset carried by a backup (LGR-15): the evidence bytes
 * behind a ledger transaction's manifest. `id` IS the SHA-256 of the bytes —
 * the importer re-derives it and refuses a mismatch, so a bundle can never
 * plant bytes under a hash they do not answer to.
 */
export interface BackupAsset {
  /** Asset-store id: 64 lowercase hex chars, the SHA-256 of the bytes. */
  id: string;
  mime: string;
  /** Byte count of the decoded content. */
  size: number;
  /** The raw bytes, base64-encoded (JSON cannot carry binary). */
  bytesBase64: string;
  /** Page ids holding an `asset_refs` edge to this asset (restored where the page exists). */
  refs: string[];
}

/** v2 compatibility name: v2 stored the same entry shape under `ledger.assets`. */
export type LedgerBackupAsset = BackupAsset;

/** One ACL row in a v3 page-access manifest (the page id lives on its parent). */
export interface BackupPageAcl {
  subject: string | null;
  email: string | null;
  issuer: string | null;
  level: AclLevel;
  invitedBy: string | null;
  createdAt: string;
}

/**
 * The complete stored access posture of one live page in a v3 bundle. This is
 * deliberately separate from {@link StoredPage}: older content imports can keep
 * using that stable record without accidentally claiming backup completeness.
 */
export interface BackupPageAccess {
  pageId: string;
  visibility: PageVisibility;
  agentEdits: AgentEditsPolicy;
  acl: BackupPageAcl[];
}

/**
 * An inconsistency a scheduled v3 backup skipped so the rest of the library
 * could still be captured. Asset entries carry `refs`; a page-access snapshot
 * race carries the affected `pages`. Explicit exports remain strict and omit
 * this field entirely when complete.
 */
export interface BackupSkippedItem {
  /** Asset hash, or the stable section id `page-access`. */
  id: string;
  /** Pages that referenced a skipped/mismatched asset. */
  refs?: string[];
  /** Pages involved in a page-access snapshot race. */
  pages?: string[];
  /** Stable machine-readable reason. */
  reason: 'missing-bytes' | 'hash-mismatch' | 'size-mismatch' | 'page-set-changed';
}

/**
 * The ledger durability surface of a backup (LGR-15). The ledger's ENTITIES
 * (accounts/transactions/postings/reconciliations and their host pages) travel
 * as ordinary pages/databases in the bundle; this section carries what those
 * rows alone cannot restore:
 *
 *  - `settings` — the seeded ids (`ledgerDb`), the period records
 *    (`ledgerPeriods`), and the entry-number sequence (`ledgerEntrySeq`),
 *    verbatim as stored;
 *  - `audit` — the FULL append-only audit stream, seq order, hashes included.
 *    Restored verbatim so the tamper-evidence chain survives the round trip
 *    (the LGR-7 verifier re-checks it against the restored rows);
 *  - `assets` — the evidence bytes referenced by transaction manifests, so the
 *    verifier's receipt re-hash check still has bytes to answer with.
 *
 * Restore semantics are deliberately narrow (see the server's `importBundle`):
 * overwrite mode only, and ONLY into a library with no seeded ledger — a
 * library that already has one keeps its LGR-3 protections and the section is
 * skipped, reported via `ImportResult.ledger`.
 */
export interface LedgerBackupSection {
  /** Raw `settings` rows by key: `ledgerDb`, `ledgerPeriods`, `ledgerEntrySeq` (when present). */
  settings: Record<string, unknown>;
  /** The full audit stream, ascending `seq`, verbatim (hashes included). */
  audit: LedgerAuditEvent[];
  /**
   * v2 evidence assets referenced by ledger transaction manifests. v3 carries
   * the deduplicated, complete asset corpus at `LibraryBackup.assets` instead.
   */
  assets?: LedgerBackupAsset[];
}

export interface LibraryBackup {
  version: number;
  exportedAt: string;
  /** STAB-5 origin binding: the instance that authored this backup. */
  instanceId?: string;
  /** Informational provenance for claimed instances; `instanceId` is the binding key. */
  ownerSubject?: string;
  pages: StoredPage[];
  databases: StoredDatabase[];
  /** pageId → emoji icon (added client-side; ignored by the server). */
  icons?: Record<string, string>;
  /** LGR-15: the ledger durability surface; absent when no ledger is seeded. */
  ledger?: LedgerBackupSection;
  /** v3: every asset referenced by `pages`, once by content hash. */
  assets?: BackupAsset[];
  /** v3: exactly one access-state record for every page in `pages`. */
  pageAccess?: BackupPageAccess[];
  /** v3 additive: inconsistencies skipped by the scheduled writer. */
  skipped?: BackupSkippedItem[];
}

export type ImportMode = 'copy' | 'overwrite';

/** What the client sends to restore: the (already-selected) pages/databases + mode. */
export interface ImportRequest {
  /**
   * Present when restoring a backup file. Omitted by ordinary content imports.
   * Explicit v1/v2 values are accepted with a partial-restore diagnostic;
   * unknown future versions are refused before any writes.
   */
  version?: number;
  /** Origin fields copied from the backup envelope. */
  instanceId?: string;
  ownerSubject?: string;
  pages: StoredPage[];
  databases: StoredDatabase[];
  mode: ImportMode;
  /**
   * LGR-15: the bundle's ledger section, forwarded on a full overwrite restore.
   * Applied only when the target has no seeded ledger AND the selection carried
   * the ledger's own pages/databases; otherwise skipped and reported.
   */
  ledger?: LedgerBackupSection;
  /** v3 selected-page asset manifest. */
  assets?: BackupAsset[];
  /** v3 selected-page access-state manifest. */
  pageAccess?: BackupPageAccess[];
  /** v3 additive: skipped items carried from a scheduled backup. */
  skipped?: BackupSkippedItem[];
  /**
   * Explicitly install v3 access state whose `instanceId` is absent or differs
   * from the target. Omitted/false restores those pages restricted instead.
   */
  installForeignPageAccess?: boolean;
}

/**
 * What became of a bundle's {@link LedgerBackupSection} on import (LGR-15).
 *  - `restored` — settings + audit stream + evidence assets applied;
 *  - `skipped-existing-ledger` — the target already has a seeded ledger, whose
 *    LGR-3 protections stand (restore ledger bundles into a FRESH library);
 *  - `skipped-copy-mode` — copy mode re-ids every page, which would sever the
 *    audit stream's entity references; the section only applies in overwrite;
 *  - `skipped-incomplete` — the page selection did not carry the ledger's own
 *    host pages/databases, so the section had nothing sound to attach to.
 */
export type LedgerRestoreOutcome = 'restored' | 'skipped-existing-ledger' | 'skipped-copy-mode' | 'skipped-incomplete';

/** A known durability surface that a legacy backup format did not carry. */
export type PartialRestoreMissing =
  | 'complete-asset-manifest'
  | 'page-access-state'
  | 'ledger-durability-section'
  | 'scheduled-backup-skips';

/** Loud, machine-readable warning for an intentionally partial restore. */
export interface BackupRestoreDiagnostic {
  code: 'partial-restore';
  version: 1 | 2 | 3;
  missing: PartialRestoreMissing[];
  message: string;
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
  /** LGR-15: outcome of the bundle's ledger section; absent when none was sent. */
  ledger?: LedgerRestoreOutcome;
  /** Compatibility/security warnings; partial legacy and skipped foreign access restores are never silent. */
  diagnostics?: BackupRestoreDiagnostic[];
  /**
   * True when this apply was a **replay** of an already-imported bundle (ER-6):
   * the bundle's content hash matched a prior import, so nothing was written and
   * the recorded counts/`idMap` are echoed back. Lets the caller skip side effects
   * (e.g. appending a `space.import` provenance entry) on a no-op re-apply.
   */
  deduped?: boolean;
}

// ── Scheduled backups (OB-166) ────────────────────────────────────────────────

/**
 * Backup cadences, in increasing interval. The server keeps a rolling set per
 * cadence (grandfather-father-son rotation), so short cadences churn fast and
 * long ones are retained sparsely — automatic, tiered data safety on top of the
 * ad-hoc export.
 */
export type BackupCadence = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** A persisted scheduler failure and the exponential-backoff gate it armed. */
export interface BackupFailure {
  failedAt: string;
  retryAt: string;
  attempts: number;
  message: string;
}

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
  /** Master switch — backups run when true (the default; opt-out). */
  enabled: boolean;
  /**
   * True once the user has explicitly set the master switch (via `PUT /api/backups`).
   * Until then the switch follows the current default, so the default-on migration
   * can re-enable never-configured instances without overriding a real opt-out.
   * Absent/false in legacy configs written before this marker existed.
   */
  userSetEnabled?: boolean;
  /** Where backups are written; `null` = the server default (`<dataDir>/backups`). */
  dir: string | null;
  /** Which cadences are active. */
  cadences: Record<BackupCadence, boolean>;
  /** How many snapshots to retain per cadence before pruning the oldest. */
  keep: Record<BackupCadence, number>;
  /** Last successful run per cadence (ISO), so a reboot catches up overdue ones. */
  lastRun: Partial<Record<BackupCadence, string>>;
  /** Skipped-item count recorded by the latest successful run per cadence. */
  lastSkippedCount: Partial<Record<BackupCadence, number>>;
  /** Active failure/backoff state per cadence; cleared by the next success. */
  failures: Partial<Record<BackupCadence, BackupFailure>>;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  dir: null,
  cadences: {daily: true, weekly: true, monthly: true, yearly: true},
  keep: {daily: 7, weekly: 5, monthly: 12, yearly: 3},
  lastRun: {},
  lastSkippedCount: {},
  failures: {},
};

/** A derived, per-cadence view for the UI (last/next run + how many are on disk). */
export interface BackupCadenceStatus {
  cadence: BackupCadence;
  enabled: boolean;
  lastRun: string | null;
  nextDue: string | null;
  count: number;
  /** Skipped items in the latest successful snapshot. */
  lastSkippedCount: number | null;
  /** Persisted failure/backoff state, when the latest scheduled attempt failed. */
  lastError: BackupFailure | null;
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
 * `hostedDatabaseId`, a database's `pageId`, and `@`-mentions — both the EditorJS
 * HTML form (`data-page-id`) and the block-doc run form (an `m` attr, the shape
 * the block-native editor and importers emit)), and returns the rewritten
 * pages/databases plus the `oldId → newId` map. References to pages outside the
 * bundle are left as-is.
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
      // EditorJS HTML mention: `data-page-id=\"id\"` (the inner quotes are escaped
      // because the HTML lives inside a JSON string value once serialised).
      json = json.split(`data-page-id=\\"${oldId}\\"`).join(`data-page-id=\\"${nid}\\"`);
      // Block-doc mention run: an `m` attr (`{"a":{"m":"id"}}`) — structured JSON,
      // so the quotes are plain. Anchored on the exact bundle id (a unique token),
      // so it never rewrites an unrelated value.
      json = json.split(`"m":"${oldId}"`).join(`"m":"${nid}"`);
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
