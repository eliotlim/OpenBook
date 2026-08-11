import {mkdir, open, rename, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {
  BACKUP_CADENCES,
  BACKUP_CADENCE_MS,
  type BackupCadence,
  type BackupConfig,
  type BackupFailure,
  type BackupStatus,
} from '@book.dev/sdk';
import type {PageStore} from './store';

/**
 * Scheduled, tiered backups (OB-166). On top of the ad-hoc export, the server
 * keeps a rolling set of whole-space snapshots per cadence (daily / weekly /
 * monthly / yearly) — a grandfather-father-son rotation — so a library
 * self-protects without the user remembering to export.
 *
 * Reuses the server's periodic-job shape (a single low-frequency `setInterval`,
 * `unref`'d so it never holds the process open) and the atomic write-then-rename
 * the book mirror uses. Snapshots are the canonical {@link LibraryBackup} JSON the
 * existing import already restores. Embedded/desktop + headless server only —
 * the in-webview store has no filesystem, so backups are reported unavailable
 * there.
 */
export interface BackupSchedulerOptions {
  /** Output dir when `config.dir` is null (e.g. `<dataDir>/backups`); null if none. */
  defaultDir: string | null;
  /** How often to check for due cadences (ms). Default 30 min. */
  intervalMs?: number;
  /** Idle delay before the first catch-up check (ms). Default 15 sec. */
  catchUpDelayMs?: number;
  /** Initial persisted failure backoff (ms). Default 1 hour. */
  failureBackoffBaseMs?: number;
  /** Maximum persisted failure backoff (ms). Default 24 hours. */
  failureBackoffMaxMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

/** The subset the HTTP app needs (so `createApp` doesn't depend on the class). */
export interface BackupController {
  status(): Promise<BackupStatus>;
  runNow(cadence?: BackupCadence): Promise<{file: string; dir: string; skippedCount: number} | null>;
}

/** Make an ISO timestamp safe + lexically sortable as a filename segment. */
const fileStamp = (iso: string): string => iso.replace(/[:.]/g, '-');
const TMP_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;

export class BackupScheduler implements BackupController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly store: PageStore,
    private readonly opts: BackupSchedulerOptions,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private resolvedDir(config: BackupConfig): string | null {
    return config.dir ?? this.opts.defaultDir;
  }

  /** Start the periodic check after a short idle delay to catch up after downtime. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const interval = this.opts.intervalMs ?? 30 * 60 * 1000;
    const catchUpDelay = Math.max(0, this.opts.catchUpDelayMs ?? 15_000);
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      if (!this.started) return;
      // Fire-and-forget: tick contains its own error boundary, so a catch-up
      // failure can neither reject startup nor prevent the periodic checks.
      void this.tick();
      this.timer = setInterval(() => void this.tick(), interval);
      this.timer.unref?.();
    }, catchUpDelay);
    this.catchUpTimer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run any enabled cadence whose interval has elapsed since its last run. */
  async tick(): Promise<void> {
    try {
      const config = await this.store.getBackupConfig();
      if (!config.enabled) return;
      const dir = this.resolvedDir(config);
      if (!dir) return;
      for (const cadence of BACKUP_CADENCES) {
        if (!config.cadences[cadence]) continue;
        const failure = config.failures[cadence];
        if (failure && this.now() < Date.parse(failure.retryAt)) continue;
        const last = config.lastRun[cadence];
        const due = !last || this.now() - Date.parse(last) >= BACKUP_CADENCE_MS[cadence];
        if (!due) continue;
        try {
          await this.runCadence(cadence, dir);
        } catch (err) {
          await this.recordFailure(cadence, err);
          console.error('OpenBook scheduled backup failed:', err);
        }
      }
    } catch (err) {
      console.error('OpenBook scheduled backup failed:', err);
    }
  }

  /** Force a snapshot for one cadence now (the "Back up now" action).
   *  Manual runs deliberately use the scheduled writer's skip-and-record
   *  semantics, so one inconsistent item does not abort the snapshot. */
  async runNow(cadence: BackupCadence = 'daily'): Promise<{file: string; dir: string; skippedCount: number} | null> {
    const config = await this.store.getBackupConfig();
    const dir = this.resolvedDir(config);
    if (!dir) return null;
    const result = await this.runCadence(cadence, dir);
    return {...result, dir};
  }

  async status(): Promise<BackupStatus> {
    const config = await this.store.getBackupConfig();
    const dir = this.resolvedDir(config);
    const cadences = await Promise.all(
      BACKUP_CADENCES.map(async (cadence) => {
        const last = config.lastRun[cadence] ?? null;
        const lastError = config.failures[cadence] ?? null;
        const nextDue = lastError?.retryAt ?? (last ? new Date(Date.parse(last) + BACKUP_CADENCE_MS[cadence]).toISOString() : null);
        const count = dir ? (await this.listSnapshots(join(dir, cadence))).length : 0;
        return {
          cadence,
          enabled: config.cadences[cadence],
          lastRun: last,
          nextDue,
          count,
          lastSkippedCount: config.lastSkippedCount[cadence] ?? null,
          lastError,
        };
      }),
    );
    return {config, resolvedDir: dir, cadences};
  }

  private async runCadence(cadence: BackupCadence, dir: string): Promise<{file: string; skippedCount: number}> {
    const result = await this.writeBackup(cadence, dir);
    await this.prune(cadence, dir);
    // Record the run last, so a failed write doesn't advance the clock. A
    // successful retry clears the active error/backoff for this cadence.
    const config = await this.store.getBackupConfig();
    const failures = {...config.failures};
    delete failures[cadence];
    await this.store.updateBackupConfig({
      lastRun: {[cadence]: this.nowIso()},
      lastSkippedCount: {[cadence]: result.skippedCount},
      failures,
    });
    return result;
  }

  private async writeBackup(cadence: BackupCadence, dir: string): Promise<{file: string; skippedCount: number}> {
    const cadenceDir = join(dir, cadence);
    await mkdir(cadenceDir, {recursive: true});
    const name = `openbook-backup-${fileStamp(this.nowIso())}.openbook.json`;
    const abs = join(cadenceDir, name);
    const tmp = `${abs}.tmp`;
    // Atomic + bounded: serialize directly into the temp file and await every
    // append. PageStore yields one verified asset at a time, so neither this
    // writer nor the store accumulates the raw/base64/JSON asset corpus.
    const handle = await open(tmp, 'w');
    let isOpen = true;
    let skippedCount = 0;
    try {
      const result = await this.store.exportAllTo(async (chunk) => {
        await handle.writeFile(chunk, {encoding: 'utf8'});
      }, this.nowIso(), {skipInconsistent: true});
      skippedCount = result.skipped.length;
      await handle.sync();
      await handle.close();
      isOpen = false;
      await rename(tmp, abs);
    } catch (err) {
      if (isOpen) await handle.close().catch(() => undefined);
      await rm(tmp, {force: true}).catch(() => undefined);
      throw err;
    }
    return {file: name, skippedCount};
  }

  private async recordFailure(cadence: BackupCadence, err: unknown): Promise<void> {
    const config = await this.store.getBackupConfig();
    const attempts = (config.failures[cadence]?.attempts ?? 0) + 1;
    const base = Math.max(1, this.opts.failureBackoffBaseMs ?? 60 * 60 * 1000);
    const cap = Math.max(base, this.opts.failureBackoffMaxMs ?? 24 * 60 * 60 * 1000);
    const delay = Math.min(cap, base * (2 ** Math.min(attempts - 1, 20)));
    const failure: BackupFailure = {
      failedAt: this.nowIso(),
      retryAt: new Date(this.now() + delay).toISOString(),
      attempts,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 4096),
    };
    await this.store.updateBackupConfig({failures: {...config.failures, [cadence]: failure}});
  }

  /** Keep the newest `keep[cadence]` snapshots; delete the older ones. */
  private async prune(cadence: BackupCadence, dir: string): Promise<void> {
    const config = await this.store.getBackupConfig();
    const keep = Math.max(1, Math.trunc(config.keep[cadence] ?? 1));
    const cadenceDir = join(dir, cadence);
    // Filenames embed a sortable ISO stamp, so lexical sort is chronological.
    const entries = await readdir(cadenceDir);
    const files = entries.filter((entry) => entry.endsWith('.openbook.json')).sort().reverse();
    for (const f of files.slice(keep)) {
      await rm(join(cadenceDir, f), {force: true});
    }
    for (const orphan of entries.filter((entry) => entry.endsWith('.openbook.json.tmp'))) {
      const tmpPath = join(cadenceDir, orphan);
      let mtimeMs: number;
      try {
        ({mtimeMs} = await stat(tmpPath));
      } catch (err) {
        // A concurrent writer may have renamed its tmp after our readdir.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (this.now() - mtimeMs > TMP_ORPHAN_MAX_AGE_MS) {
        await rm(tmpPath, {force: true});
      }
    }
  }

  private async listSnapshots(cadenceDir: string): Promise<string[]> {
    try {
      const entries = await readdir(cadenceDir);
      return entries.filter((e) => e.endsWith('.openbook.json'));
    } catch {
      return []; // directory not created yet
    }
  }
}
