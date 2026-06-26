import {mkdir, writeFile, rename, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {
  BACKUP_CADENCES,
  BACKUP_CADENCE_MS,
  BACKUP_VERSION,
  type BackupCadence,
  type BackupConfig,
  type BackupStatus,
  type SpaceBackup,
} from '@book.dev/sdk';
import type {PageStore} from './store';

/**
 * Scheduled, tiered backups (OB-166). On top of the ad-hoc export, the server
 * keeps a rolling set of whole-space snapshots per cadence (daily / weekly /
 * monthly / yearly) — a grandfather-father-son rotation — so a workspace
 * self-protects without the user remembering to export.
 *
 * Reuses the server's periodic-job shape (a single low-frequency `setInterval`,
 * `unref`'d so it never holds the process open) and the atomic write-then-rename
 * the book mirror uses. Snapshots are the canonical {@link SpaceBackup} JSON the
 * existing import already restores. Embedded/desktop + headless server only —
 * the in-webview store has no filesystem, so backups are reported unavailable
 * there.
 */
export interface BackupSchedulerOptions {
  /** Output dir when `config.dir` is null (e.g. `<dataDir>/backups`); null if none. */
  defaultDir: string | null;
  /** How often to check for due cadences (ms). Default 30 min. */
  intervalMs?: number;
  /** Clock injection (tests). */
  now?: () => number;
}

/** The subset the HTTP app needs (so `createApp` doesn't depend on the class). */
export interface BackupController {
  status(): Promise<BackupStatus>;
  runNow(cadence?: BackupCadence): Promise<{file: string; dir: string} | null>;
}

/** Make an ISO timestamp safe + lexically sortable as a filename segment. */
const fileStamp = (iso: string): string => iso.replace(/[:.]/g, '-');

export class BackupScheduler implements BackupController {
  private timer: ReturnType<typeof setInterval> | null = null;

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

  /** Start the periodic check (runs once immediately to catch up after downtime). */
  start(): void {
    if (this.timer) return;
    void this.tick();
    const interval = this.opts.intervalMs ?? 30 * 60 * 1000;
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
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
        const last = config.lastRun[cadence];
        const due = !last || this.now() - Date.parse(last) >= BACKUP_CADENCE_MS[cadence];
        if (due) await this.runCadence(cadence, dir);
      }
    } catch (err) {
      console.error('OpenBook scheduled backup failed:', err);
    }
  }

  /** Force a snapshot for one cadence now (the "Back up now" action). */
  async runNow(cadence: BackupCadence = 'daily'): Promise<{file: string; dir: string} | null> {
    const config = await this.store.getBackupConfig();
    const dir = this.resolvedDir(config);
    if (!dir) return null;
    const file = await this.runCadence(cadence, dir);
    return {file, dir};
  }

  async status(): Promise<BackupStatus> {
    const config = await this.store.getBackupConfig();
    const dir = this.resolvedDir(config);
    const cadences = await Promise.all(
      BACKUP_CADENCES.map(async (cadence) => {
        const last = config.lastRun[cadence] ?? null;
        const nextDue = last ? new Date(Date.parse(last) + BACKUP_CADENCE_MS[cadence]).toISOString() : null;
        const count = dir ? (await this.listSnapshots(join(dir, cadence))).length : 0;
        return {cadence, enabled: config.cadences[cadence], lastRun: last, nextDue, count};
      }),
    );
    return {config, resolvedDir: dir, cadences};
  }

  private async runCadence(cadence: BackupCadence, dir: string): Promise<string> {
    const file = await this.writeBackup(cadence, dir);
    await this.prune(cadence, dir);
    // Record the run last, so a failed write doesn't advance the clock.
    await this.store.updateBackupConfig({lastRun: {[cadence]: this.nowIso()}});
    return file;
  }

  private async writeBackup(cadence: BackupCadence, dir: string): Promise<string> {
    const {pages, databases} = await this.store.exportAll();
    const backup: SpaceBackup = {version: BACKUP_VERSION, exportedAt: this.nowIso(), pages, databases};
    const cadenceDir = join(dir, cadence);
    await mkdir(cadenceDir, {recursive: true});
    const name = `openbook-backup-${fileStamp(this.nowIso())}.openbook.json`;
    const abs = join(cadenceDir, name);
    const tmp = `${abs}.tmp`;
    // Atomic: write to a temp file, then rename into place (same pattern as the
    // book mirror) so a crash mid-write never leaves a truncated backup.
    await writeFile(tmp, JSON.stringify(backup), 'utf8');
    await rename(tmp, abs);
    return name;
  }

  /** Keep the newest `keep[cadence]` snapshots; delete the older ones. */
  private async prune(cadence: BackupCadence, dir: string): Promise<void> {
    const config = await this.store.getBackupConfig();
    const keep = Math.max(1, Math.trunc(config.keep[cadence] ?? 1));
    const cadenceDir = join(dir, cadence);
    // Filenames embed a sortable ISO stamp, so lexical sort is chronological.
    const files = (await this.listSnapshots(cadenceDir)).sort().reverse();
    for (const f of files.slice(keep)) {
      await rm(join(cadenceDir, f), {force: true});
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
