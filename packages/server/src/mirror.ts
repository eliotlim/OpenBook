import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import {existsSync, watch, type FSWatcher} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  bookHtmlToPage,
  contentHash,
  pageToBookHtml,
  readBookHtmlMeta,
  slugify,
  BOOK_RUNTIME_DIR,
  BOOK_RUNTIME_FILE,
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
import {DirLock, DirLockedError, type DirLockInfo} from './dirLock';
import type {PageStore} from './store';

/** What the mirror last wrote for a page — drives dedup + own-write filtering. */
interface IndexEntry {
  /** Path relative to the mirror root. */
  path: string;
  /** Hash of the exact file bytes we wrote (so we ignore our own writes). */
  hash: string;
  /** The DB `updatedAt` the file was rendered from (the conflict base). */
  updatedAt: string;
}

/** Persisted mirror state — the write journal + the per-page index. */
interface MirrorState {
  version: 1;
  index: Record<string, IndexEntry>;
  /** Page ids with an un-flushed write or delete (survive a crash, replay on boot). */
  pending: Record<string, 'write' | 'delete'>;
  /**
   * Content hash of the viewer runtime bundle (`_openbook/viewer.js`) the mirror
   * last wrote — the bundle's own-write/dedup record. Present ⇔ the page files
   * were rendered WITH the runtime reference, so a presence flip against the
   * current {@link BookMirrorOptions.runtimeBundle} marks the one-time,
   * upgrade-class whole-folder rewrite (the reference block itself is a byte
   * constant, so nothing short of a flip ever re-renders pages for runtime
   * reasons). Absent on pre-runtime folders (additive, still version 1).
   */
  runtimeHash?: string;
}

export interface BookMirrorOptions {
  store: PageStore;
  /** Root folder the book files are written under. */
  dir: string;
  /** Re-import notifier — wired to the hub so open clients refresh live. */
  onImported?: (page: StoredPage) => void | Promise<void>;
  log?: (msg: string) => void;
  /** Debounce for batching DB→disk writes. Default 150ms. */
  writeDebounceMs?: number;
  /** Debounce for re-importing an externally-changed file. Default 250ms. */
  importDebounceMs?: number;
  /** Watch the folder for external edits + re-import. Default true. */
  watch?: boolean;
  /**
   * Write-amplification guardrail (ER-2). Off unless set here or via the
   * `OPENBOOK_WRITE_BUDGET` env flag (this option wins). A plain number is a
   * writes-per-interval shorthand; see {@link WriteBudgetSpec}.
   */
  writeBudget?: WriteBudgetSpec | number;
  /**
   * The viewer runtime bundle's JS source (the compiled `OpenBookViewer` IIFE).
   * When provided, ONE copy is kept at `_openbook/viewer.js` and every mirrored
   * page file carries the byte-constant runtime reference (see sdk
   * `bookRuntimeScripts`), so a `.book.html` opened from `file://` hydrates into
   * the interactive locked viewer. The bundle is (re)written only at open, and
   * only when its content hash changed (an app upgrade) or the file diverged —
   * never on page-save churn. Omit it and the mirror writes the plain static
   * files exactly as before (and strips a previously-written runtime).
   */
  runtimeBundle?: string;
}

const STATE_FILE = '.openbook-mirror.json';
const LOCK_FILE = '.openbook-mirror.lock';
const MAX_DEPTH = 64;

/**
 * Thrown by {@link BookMirror.create} when another **live** process already owns
 * the mirror directory (OB-241). A second `openbook-server` pointed at the same
 * book folder would otherwise watch + write-through the same files, and each
 * would see the other's writes as external edits — a mutual DB-wins conflict war
 * that mints duplicate "(conflicted copy)" pages on both sides. The caller
 * (server bootstrap) catches this and simply runs without a mirror.
 *
 * Backed by the reusable {@link DirLock}; the mirror translates its
 * {@link DirLockedError} into this type to preserve the public contract.
 */
export class MirrorLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly holder: DirLockInfo,
  ) {
    super(`book mirror: ${dir} is already owned by pid ${holder.pid} on ${holder.host} (since ${holder.startedAt})`);
    this.name = 'MirrorLockedError';
  }
}

/** Cumulative disk-write metrics, counted at the single chokepoint {@link BookMirror.atomicWrite}. */
export interface MirrorMetrics {
  /** Atomic file writes that reached disk (page files + state journal + lock). */
  writeCount: number;
  /** Total bytes written by those writes. */
  bytesWritten: number;
  /** `rename(tmp → final)` calls (one per successful atomic write). */
  renameCount: number;
}

/**
 * Write-amplification budget (OB-242 / ER-2). A guardrail for runaway disk churn
 * — the kind the OB-241 conflict storm produced (10+ GB of duplicate writes).
 * **Off by default**; only takes effect when {@link BookMirrorOptions.writeBudget}
 * or the `OPENBOOK_WRITE_BUDGET` env flag is set. When a dimension is exceeded the
 * mirror logs a warning **and throws** so the runaway surfaces loudly instead of
 * silently burning disk.
 */
export interface WriteBudgetSpec {
  /** Max atomic writes allowed per rolling interval. */
  writes?: number;
  /** Max bytes written per rolling interval. */
  bytes?: number;
  /** Max **brand-new** conflict copies for a single page id per copy window (ER-4). */
  copies?: number;
  /** Rolling window for `writes`/`bytes` (ms). Default 10_000. */
  intervalMs?: number;
  /** Rolling window for the per-page-id `copies` cap (ms). Default 10_000. */
  copyWindowMs?: number;
}

/** Normalised budget with windows resolved — the in-memory form the guard reads. */
interface ResolvedBudget {
  writes: number | null;
  bytes: number | null;
  copies: number | null;
  intervalMs: number;
  copyWindowMs: number;
}

/** Thrown by the mirror when an active {@link WriteBudgetSpec} dimension is exceeded. */
export class WriteBudgetError extends Error {
  constructor(
    readonly dimension: 'writes' | 'bytes' | 'copies',
    readonly observed: number,
    readonly limit: number,
    readonly detail?: string,
  ) {
    super(
      `book mirror: write budget exceeded — ${dimension} ${observed} > ${limit}` +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'WriteBudgetError';
  }
}

const DEFAULT_BUDGET_WINDOW_MS = 10_000;

/**
 * Parse a {@link WriteBudgetSpec} from an option object, a plain number (a bare
 * writes-per-interval shorthand), or the `OPENBOOK_WRITE_BUDGET` env string
 * (numeric or JSON). Returns `null` (the guard stays off) for an absent/blank or
 * unparseable value — a malformed flag must never change behaviour, only warn.
 */
function parseWriteBudget(
  raw: WriteBudgetSpec | number | string | undefined,
  log: (msg: string) => void,
): ResolvedBudget | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let spec: WriteBudgetSpec | null = null;
  if (typeof raw === 'number') spec = {writes: raw};
  else if (typeof raw === 'object') spec = raw;
  else {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) spec = {writes: Number(trimmed)};
    else {
      try {
        spec = JSON.parse(trimmed) as WriteBudgetSpec;
      } catch {
        log(`book mirror: ignoring unparseable OPENBOOK_WRITE_BUDGET=${raw}`);
        return null;
      }
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const resolved: ResolvedBudget = {
    writes: num(spec.writes),
    bytes: num(spec.bytes),
    copies: num(spec.copies),
    intervalMs: num(spec.intervalMs) ?? DEFAULT_BUDGET_WINDOW_MS,
    copyWindowMs: num(spec.copyWindowMs) ?? DEFAULT_BUDGET_WINDOW_MS,
  };
  // Nothing actionable configured → leave the guard off.
  if (resolved.writes === null && resolved.bytes === null && resolved.copies === null) return null;
  return resolved;
}

/**
 * The on-disk book-file mirror (OB-134/135/136). pglite stays canonical; this
 * writes a derived **folder per book** (one HTML file per page) in near-realtime,
 * watches it for external edits to re-import, and survives crashes:
 *
 *  - **Atomic writes** — every file is written to a temp name then renamed, so an
 *    external sync/backup tool never observes a half-written file.
 *  - **Journal** — a page with an un-flushed write/delete is recorded in the
 *    state file *before* the work and cleared only after it succeeds, so a crash
 *    mid-flush replays on the next start. `close()` drains the journal.
 *  - **Own-write filtering** — the index records the exact bytes we wrote; the
 *    watcher ignores a change whose bytes match, so the write-through never feeds
 *    back into a re-import loop.
 *  - **DB-wins conflicts** — re-import goes through {@link PageStore.importBookPage}.
 */
export class BookMirror {
  private readonly store: PageStore;
  private readonly dir: string;
  private readonly onImported?: (page: StoredPage) => void | Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly writeDebounceMs: number;
  private readonly importDebounceMs: number;
  private readonly doWatch: boolean;

  private readonly runtimeBundle: string | null;

  private index = new Map<string, IndexEntry>();
  private pending = new Map<string, 'write' | 'delete'>();
  /** Hash of the runtime bundle we last wrote (mirrors {@link MirrorState.runtimeHash}). */
  private runtimeHash: string | null = null;
  /**
   * Set when the runtime format flipped (bundle gained/lost) since the persisted
   * state: the one-time, upgrade-class whole-folder rewrite. Consumed by
   * {@link reconcileAll}, which enqueues every live page once and clears it.
   */
  private runtimeFormatFlipped = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private statePersist: Promise<void> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private importTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  /** True only during {@link close}'s authorized final drain (lets it bypass the closed-guard). */
  private closing = false;
  private lock: DirLock | null = null;

  // ── Write-amplification metrics + budget (ER-2) ──────────────────────────────
  /** Cumulative metrics (never reset); read via {@link metrics}. */
  private writeCount = 0;
  private bytesWritten = 0;
  private renameCount = 0;
  /** Active budget (null = off). Parsed once in {@link create}. */
  private budget: ResolvedBudget | null = null;
  /** Tumbling window for the writes/bytes budget. */
  private window = {start: 0, writes: 0, bytes: 0};
  /** Per-page-id rolling window for the conflict-copy cap (ER-4). */
  private copyWindow = new Map<string, {start: number; count: number}>();

  private constructor(opts: BookMirrorOptions) {
    this.store = opts.store;
    this.dir = opts.dir;
    this.onImported = opts.onImported;
    this.log = opts.log ?? (() => undefined);
    this.writeDebounceMs = opts.writeDebounceMs ?? 150;
    this.importDebounceMs = opts.importDebounceMs ?? 250;
    this.doWatch = opts.watch ?? true;
    this.runtimeBundle =
      typeof opts.runtimeBundle === 'string' && opts.runtimeBundle.length > 0 ? opts.runtimeBundle : null;
  }

  /**
   * Open the mirror under `dir`: load any prior state, replay un-flushed journal
   * entries, do a full reconcile so the folder matches the DB, then start
   * watching for external edits.
   */
  static async create(opts: BookMirrorOptions): Promise<BookMirror> {
    const mirror = new BookMirror(opts);
    // Read the write-amplification budget once at open (option wins over env).
    mirror.budget = parseWriteBudget(opts.writeBudget ?? process.env.OPENBOOK_WRITE_BUDGET, mirror.log);
    mirror.window.start = Date.now();
    await mkdir(mirror.dir, {recursive: true});
    // Single-owner guard (OB-241): claim the directory before doing any work, so a
    // second process can't watch + write-through the same folder and war with us.
    await mirror.acquireLock();
    try {
      await mirror.loadState();
      // Bring the folder-level viewer runtime (`_openbook/viewer.js`) up to date
      // BEFORE the reconcile: a runtime-format flip must be known when reconcile
      // decides what to rewrite, and a page opened right after boot should find
      // the bundle its reference points at.
      await mirror.ensureRuntime();
      // reconcile re-enqueues anything stale; flush drains both the reconciled set
      // and any journal entries a prior crash left un-flushed.
      await mirror.reconcileAll();
      await mirror.flush();
      if (mirror.doWatch) mirror.startWatch();
    } catch (err) {
      // A post-lock failure (e.g. a WriteBudgetError tripping during the bootstrap
      // reconcile) must not strand the single-owner lock OR leave a timer armed:
      // `reconcileAll` arms a debounced flush, so without teardown an orphaned
      // flush would fire ~writeDebounceMs later and write-through with NO lock held.
      // teardown() clears that timer (+ import timers + watchers) and marks closed;
      // then release the lock so the caller can degrade to running without a mirror.
      mirror.teardown();
      await mirror.releaseLock();
      throw err;
    }
    return mirror;
  }

  // ── State (journal + index) ──────────────────────────────────────────────────

  private get statePath(): string {
    return join(this.dir, STATE_FILE);
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const state = JSON.parse(raw) as MirrorState;
      this.index = new Map(Object.entries(state.index ?? {}));
      this.pending = new Map(Object.entries(state.pending ?? {}));
      this.runtimeHash = typeof state.runtimeHash === 'string' ? state.runtimeHash : null;
    } catch {
      // No prior state (first run) or unreadable — start clean.
      this.index = new Map();
      this.pending = new Map();
      this.runtimeHash = null;
    }
  }

  /** Persist the journal + index atomically (serialized so writes don't race). */
  private persistState(): Promise<void> {
    const state: MirrorState = {
      version: 1,
      index: Object.fromEntries(this.index),
      pending: Object.fromEntries(this.pending),
      ...(this.runtimeHash ? {runtimeHash: this.runtimeHash} : {}),
    };
    this.statePersist = this.statePersist
      .then(() => this.atomicWrite(this.statePath, JSON.stringify(state)))
      // Best-effort: the journal is re-derived from the (canonical) DB on boot,
      // so a failed persist (e.g. the dir was removed) must never crash the app.
      .catch((err) => this.log(`book mirror: state persist failed: ${String(err)}`));
    return this.statePersist;
  }

  // ── Folder-level viewer runtime (`_openbook/viewer.js`) ─────────────────────

  /**
   * Bring the shared viewer runtime up to date at open (create() only — the
   * page-save write path never touches it, by design):
   *
   *  - bundle provided + content hash changed since we last wrote it (an app
   *    upgrade) → rewrite `_openbook/viewer.js`. Page files are untouched: the
   *    reference block is a byte constant (sdk `bookRuntimeScripts`), so a bundle
   *    upgrade costs exactly ONE file write.
   *  - bundle provided + hash unchanged → verify the on-disk bytes (own-write
   *    dedup semantics, same as pages: an externally-diverged/deleted bundle is
   *    restored, canonical wins) and otherwise write nothing.
   *  - bundle newly ABSENT on a folder that had one → remove `_openbook/` and
   *    flag the format flip so every page sheds its reference.
   *
   * A presence flip either way marks {@link runtimeFormatFlipped}: the one-time,
   * upgrade-class whole-folder page rewrite (consumed by {@link reconcileAll}).
   * Writes go through {@link atomicWrite}, so they are budget-checked + counted.
   */
  private async ensureRuntime(): Promise<void> {
    const had = this.runtimeHash !== null;
    const has = this.runtimeBundle !== null;
    if (has) {
      const bundle = this.runtimeBundle!;
      const hash = contentHash(bundle);
      const abs = join(this.dir, BOOK_RUNTIME_FILE);
      let current: string | null = null;
      if (this.runtimeHash === hash) {
        // Same bundle as last time — skip the write only if the FILE still holds
        // it (never trust the recorded hash alone; see writePageFile's skip).
        try {
          current = await readFile(abs, 'utf8');
        } catch {
          current = null; // missing/unreadable → restore below.
        }
      }
      if (current !== bundle) {
        await mkdir(dirname(abs), {recursive: true});
        await this.atomicWrite(abs, bundle);
        this.log(`book mirror: wrote viewer runtime ${BOOK_RUNTIME_FILE} (${hash.slice(0, 12)}…)`);
      }
      this.runtimeHash = hash;
    } else if (had) {
      // Downgrade: the host no longer supplies a bundle — drop the folder copy so
      // no page's (now-removed) reference dangles at a stale runtime.
      await rm(join(this.dir, BOOK_RUNTIME_FILE), {force: true});
      try {
        await rmdir(join(this.dir, BOOK_RUNTIME_DIR));
      } catch {
        // Not empty / already gone — leave it.
      }
      this.runtimeHash = null;
    }
    if (had !== has) this.runtimeFormatFlipped = true;
    await this.persistState();
  }

  // ── Single-owner lock (OB-241) ───────────────────────────────────────────────

  private get lockPath(): string {
    return join(this.dir, LOCK_FILE);
  }

  /**
   * Claim exclusive ownership of the mirror directory via the reusable
   * {@link DirLock}. Throws {@link MirrorLockedError} when another **live** process
   * already holds it; a stale lock (the holder's pid is gone, or it's our own
   * crashed prior instance) is taken over. The lock file name starts with `.` so
   * the watcher ignores it. `DirLock` claims atomically (write-temp + `link`), so
   * two simultaneous starts can't both win (TOCTOU closed).
   */
  private async acquireLock(): Promise<void> {
    try {
      this.lock = await DirLock.acquire(this.lockPath);
    } catch (err) {
      // Translate to the mirror's public error type (the bootstrap caller catches
      // it to degrade to running without a mirror).
      if (err instanceof DirLockedError) throw new MirrorLockedError(this.dir, err.holder);
      throw err;
    }
  }

  private async releaseLock(): Promise<void> {
    await this.lock?.release();
    this.lock = null;
  }

  // ── Write-amplification metrics + budget (ER-2) ──────────────────────────────

  /**
   * Cumulative disk-write metrics since this instance opened. Counted at the
   * single chokepoint {@link atomicWrite}, so they cover page files and the state
   * journal (the single-owner lock is claimed by {@link DirLock}, outside this
   * chokepoint). Used by the soak suite to assert constant amplification and a
   * zero-write converged steady state.
   */
  metrics(): MirrorMetrics {
    return {writeCount: this.writeCount, bytesWritten: this.bytesWritten, renameCount: this.renameCount};
  }

  /**
   * Guard a pending write against the active budget **before** touching disk (so
   * a trip never leaves a `.tmp` orphan). Advances the tumbling writes/bytes
   * window and throws {@link WriteBudgetError} when a dimension is exceeded,
   * after logging a warning. No-op when the budget is off.
   */
  private checkWriteBudget(bytes: number): void {
    const b = this.budget;
    if (!b || (b.writes === null && b.bytes === null)) return;
    const now = Date.now();
    if (now - this.window.start > b.intervalMs) this.window = {start: now, writes: 0, bytes: 0};
    this.window.writes += 1;
    this.window.bytes += bytes;
    if (b.writes !== null && this.window.writes > b.writes) {
      this.log(`book mirror: WRITE BUDGET TRIPPED — ${this.window.writes} writes in ${b.intervalMs}ms (limit ${b.writes})`);
      throw new WriteBudgetError('writes', this.window.writes, b.writes, `${b.intervalMs}ms window`);
    }
    if (b.bytes !== null && this.window.bytes > b.bytes) {
      this.log(`book mirror: WRITE BUDGET TRIPPED — ${this.window.bytes} bytes in ${b.intervalMs}ms (limit ${b.bytes})`);
      throw new WriteBudgetError('bytes', this.window.bytes, b.bytes, `${b.intervalMs}ms window`);
    }
  }

  /**
   * Record a brand-new conflict copy minted for `pageId` and enforce the
   * per-page-id copy cap (ER-4). One external divergence reuses its existing copy
   * (no mint, no count), so this only grows for *distinct* divergent content;
   * blowing the cap means a regression has re-opened the OB-241 storm. Warns then
   * throws {@link WriteBudgetError}. No-op when the cap is off.
   */
  private recordConflictCopy(pageId: string): void {
    const cap = this.budget?.copies ?? null;
    if (cap === null) return;
    const windowMs = this.budget!.copyWindowMs;
    const now = Date.now();
    const w = this.copyWindow.get(pageId);
    if (!w || now - w.start > windowMs) {
      this.copyWindow.set(pageId, {start: now, count: 1});
      if (cap < 1) throw new WriteBudgetError('copies', 1, cap, `page ${pageId}`);
      return;
    }
    w.count += 1;
    if (w.count > cap) {
      this.log(`book mirror: COPY BUDGET TRIPPED — ${w.count} conflict copies of ${pageId} in ${windowMs}ms (limit ${cap})`);
      throw new WriteBudgetError('copies', w.count, cap, `page ${pageId}`);
    }
  }

  // ── Enqueue / flush ──────────────────────────────────────────────────────────

  /** Mark a page for (re)writing to disk. */
  enqueueWrite(pageId: string): void {
    if (this.closed) return;
    this.pending.set(pageId, 'write');
    void this.persistState();
    this.scheduleFlush();
  }

  /** Mark a page's file for deletion. */
  enqueueDelete(pageId: string): void {
    if (this.closed) return;
    this.pending.set(pageId, 'delete');
    void this.persistState();
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // A budget trip (ER-2) rejects this drain; on the timer-driven write-through
      // path there is no awaiter, so catch-log it (like the import path) rather than
      // let it surface as an unhandled promise rejection that could crash the host.
      void this.flush().catch((err) => this.log(`book mirror: scheduled flush failed: ${String(err)}`));
    }, this.writeDebounceMs);
  }

  /** Drain the journal: write/delete every pending page. Safe to call anytime. */
  async flush(): Promise<void> {
    // Coalesce concurrent callers onto one in-flight drain.
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    // Defense-in-depth (ER-5 review): once torn down, never touch disk again — an
    // orphaned/stray flush (e.g. a timer that outlived a failed create()) must be a
    // no-op rather than write-through with no lock held. close()'s own final drain
    // sets `closing` to bypass this.
    if (this.closed && !this.closing) return;
    // Process snapshots of the pending set until it's empty (new work can arrive
    // mid-drain). Each entry is cleared after its attempt — a transient failure
    // is recovered on the next reconcile (the DB is canonical), and a crash
    // before the attempt leaves the entry persisted in the journal for replay.
    while (this.pending.size > 0) {
      const batch = [...this.pending.entries()];
      for (const [pageId, op] of batch) {
        try {
          if (op === 'delete') await this.deletePageFile(pageId);
          else await this.writePageFile(pageId);
        } catch (err) {
          // A tripped write budget (ER-2) is a deliberate circuit-breaker, not a
          // transient per-page failure — surface it instead of logging on.
          if (err instanceof WriteBudgetError) {
            this.pending.delete(pageId);
            throw err;
          }
          this.log(`book mirror: failed to ${op} ${pageId}: ${String(err)}`);
        }
        this.pending.delete(pageId);
      }
      await this.persistState();
    }
  }

  // ── DB → disk ────────────────────────────────────────────────────────────────

  /** Enqueue every live page so the folder fully matches the DB. */
  async reconcileAll(): Promise<void> {
    const {pages, databases} = await this.store.exportAll();
    const live = new Set(pages.map((p) => p.id));
    const ctx = this.buildContext(pages, databases);
    // A runtime-format flip (folder gained/lost `_openbook/viewer.js`) re-renders
    // every page once — the deliberate upgrade-class rewrite. `updatedAt` can't
    // catch it (the DB rows didn't change), so it forces the enqueue here; the
    // per-page no-op skip in writePageFile keeps any actually-identical file
    // (there are none on a real flip) from touching disk.
    const rewriteAll = this.runtimeFormatFlipped;
    this.runtimeFormatFlipped = false;
    for (const p of pages) {
      const path = this.relPathFor(p.id, ctx);
      const entry = this.index.get(p.id);
      // (Re)write when new, moved, content changed since we last mirrored, or the
      // file went missing out-of-band (a crash mid-write, or an external delete).
      // The DB is canonical, so reconcile always restores the disk to match it.
      const missing = !entry || !existsSync(join(this.dir, entry.path));
      if (rewriteAll || missing || entry!.path !== path || entry!.updatedAt !== p.updatedAt) this.enqueueWrite(p.id);
    }
    // Prune files for pages that no longer exist (deleted subtrees, purges).
    for (const id of [...this.index.keys()]) if (!live.has(id)) this.enqueueDelete(id);
  }

  private async writePageFile(pageId: string): Promise<void> {
    // Defense-in-depth (ER-5 review): never write a page after teardown — guards the
    // same orphaned-flush window as drain(), at the single per-page write site.
    if (this.closed && !this.closing) return;
    const page = await this.store.getPage(pageId);
    if (!page) {
      // Gone since enqueue — treat as a delete.
      await this.deletePageFile(pageId);
      return;
    }
    const rel = await this.relPathForLive(page);
    const abs = join(this.dir, rel);
    // The runtime reference tracks bundle presence (byte-constant block, so this
    // adds NO per-write variance — see the SDK/server byte-compat contract:
    // spaceToBookFiles({runtime}) renders the identical bytes).
    const html = pageToBookHtml(
      {id: page.id, name: page.name, icon: pageIcon(page), updatedAt: page.updatedAt, data: page.data},
      {runtimeRef: this.runtimeBundle !== null},
    );
    const hash = contentHash(html);

    const prior = this.index.get(pageId);
    const moved = !!prior && prior.path !== rel;
    // A move/rename changes the path — remove the stale file first.
    if (moved) await this.removeRel(prior!.path);

    // No-op skip (ER-1): a converged steady state must do zero disk writes.
    //  - rendered hash !== prior.hash → content changed: write (cheap path, no
    //    extra read).
    //  - rendered hash === prior.hash → the canonical bytes are unchanged, but we
    //    must still confirm the FILE holds them before skipping. An external tool
    //    can diverge the file while our rendered canonical hash is unchanged
    //    (re-applying a stale-base edit); DB-wins requires we restore it, so the
    //    skip is gated on the *actual* on-disk bytes, never index.hash alone.
    if (!moved && prior && prior.hash === hash) {
      let current: string | null = null;
      try {
        current = await readFile(abs, 'utf8');
      } catch {
        current = null; // missing/unreadable → fall through and (re)write.
      }
      if (current === html) {
        // File already holds the canonical bytes — nothing to do.
        if (this.doWatch) this.attachBookFolder(dirname(abs));
        return;
      }
    }

    await mkdir(dirname(abs), {recursive: true});
    await this.atomicWrite(abs, html);
    this.index.set(pageId, {path: rel, hash, updatedAt: page.updatedAt});
    // Watch every folder we write into, so external edits to its files are
    // caught deterministically (rather than relying on the root watcher to
    // notice a freshly-created subfolder, which races the first write).
    if (this.doWatch) this.attachBookFolder(dirname(abs));
  }

  private async deletePageFile(pageId: string): Promise<void> {
    const entry = this.index.get(pageId);
    if (entry) await this.removeRel(entry.path);
    this.index.delete(pageId);
  }

  private async removeRel(rel: string): Promise<void> {
    await rm(join(this.dir, rel), {force: true});
    // Prune the book folder if it's now empty (e.g. a whole book was deleted, or
    // a root page renamed away). Best-effort: rmdir fails when others remain.
    const folder = dirname(join(this.dir, rel));
    if (folder !== this.dir) {
      try {
        if ((await readdir(folder)).length === 0) await rmdir(folder);
      } catch {
        // Not empty / already gone — leave it.
      }
    }
  }

  private async atomicWrite(abs: string, content: string): Promise<void> {
    // The single disk-write chokepoint (ER-2): budget-check first (so a trip
    // never leaves a `.tmp` orphan), then count what actually reached disk.
    const bytes = Buffer.byteLength(content, 'utf8');
    this.checkWriteBudget(bytes);
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs); // atomic on the same filesystem
    this.writeCount += 1;
    this.bytesWritten += bytes;
    this.renameCount += 1;
  }

  // ── Book path resolution ───────────────────────────────────────────────────────

  /** Relative path for a live page, walking ancestors via the store. */
  private async relPathForLive(page: StoredPage): Promise<string> {
    const chain: StoredPage[] = [page];
    let current = page;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      let parent: StoredPage | null = null;
      if (current.parentId) {
        parent = await this.store.getPage(current.parentId);
      } else if (current.databaseId) {
        const db = await this.store.getDatabase(current.databaseId);
        parent = db ? await this.store.getPage(db.pageId) : null;
      }
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }
    const root = chain[0];
    return `${folderName(root)}/${fileName(page)}`;
  }

  // ── Reconcile-time path resolution (from the in-memory snapshot) ──────────────

  private buildContext(pages: StoredPage[], databases: StoredDatabase[]): ReconcileContext {
    const byId = new Map(pages.map((p) => [p.id, p]));
    const dbHost = new Map(databases.map((d) => [d.id, d.pageId]));
    return {byId, dbHost};
  }

  private relPathFor(pageId: string, ctx: ReconcileContext): string {
    const page = ctx.byId.get(pageId)!;
    let root = page;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      let parentId: string | null = null;
      if (root.parentId) parentId = root.parentId;
      else if (root.databaseId) parentId = ctx.dbHost.get(root.databaseId) ?? null;
      const parent = parentId ? ctx.byId.get(parentId) : null;
      if (!parent) break;
      root = parent;
    }
    return `${folderName(root)}/${fileName(page)}`;
  }

  // ── disk → DB (the watcher + re-import) ───────────────────────────────────────

  private startWatch(): void {
    // The layout is exactly two levels deep (root/<book>/<page>.html), so we
    // watch the root for new book folders and each book folder for file changes.
    const attach = (target: string): void => {
      try {
        const w = watch(target, (_event, filename) => {
          if (!filename) return;
          const name = filename.toString();
          // The root watcher sees folder churn; (re)attach to keep coverage. The
          // runtime dir (`_openbook/`) is OURS, never a book folder: it holds no
          // `.book.html`, must never be watched for re-import, and a page slug
          // can't collide with it (slugify never yields an underscore).
          if (target === this.dir && !name.endsWith('.html') && !name.startsWith('.') && name !== BOOK_RUNTIME_DIR) {
            this.attachBookFolder(join(this.dir, name));
            return;
          }
          if (!name.endsWith('.html')) return;
          this.scheduleImport(join(target, name));
        });
        this.watchers.push(w);
      } catch (err) {
        this.log(`book mirror: cannot watch ${target}: ${String(err)}`);
      }
    };
    attach(this.dir);
    // Attach to existing book folders (derived from the index).
    const folders = new Set<string>();
    for (const entry of this.index.values()) {
      const folder = entry.path.split('/')[0];
      if (folder) folders.add(folder);
    }
    for (const f of folders) this.attachBookFolder(join(this.dir, f));
  }

  private attachedFolders = new Set<string>();
  private attachBookFolder(abs: string): void {
    if (this.attachedFolders.has(abs)) return;
    this.attachedFolders.add(abs);
    try {
      const w = watch(abs, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (name.endsWith('.html')) this.scheduleImport(join(abs, name));
      });
      this.watchers.push(w);
    } catch {
      this.attachedFolders.delete(abs);
    }
  }

  private scheduleImport(absPath: string): void {
    if (this.closed) return;
    const existing = this.importTimers.get(absPath);
    if (existing) clearTimeout(existing);
    this.importTimers.set(
      absPath,
      setTimeout(() => {
        this.importTimers.delete(absPath);
        void this.importFile(absPath).catch((err) => this.log(`book mirror: import ${absPath} failed: ${String(err)}`));
      }, this.importDebounceMs),
    );
  }

  /**
   * Re-import a single book file. Returns the action taken (or `'skipped'` when
   * the file is ours/unchanged or not a book page). Exposed for tests so they can
   * drive re-import without depending on filesystem-event timing.
   */
  async importFile(absPath: string): Promise<'skipped' | 'created' | 'updated' | 'conflict' | 'unchanged'> {
    let html: string;
    try {
      html = await readFile(absPath, 'utf8');
    } catch {
      return 'skipped'; // deleted between event and read
    }
    const rel = absPath.startsWith(this.dir) ? absPath.slice(this.dir.length).replace(/^[/\\]+/, '') : absPath;
    const meta = readBookHtmlMeta(html);
    if (!meta) return 'skipped';

    // Ignore our own writes: identical bytes to what the index recorded.
    const fileHash = contentHash(html);
    if (this.index.get(meta.id)?.hash === fileHash) return 'skipped';

    const record = bookHtmlToPage(html);
    if (!record) return 'skipped';

    const copiesBefore = this.store.copiesMinted;
    const result = await this.store.importBookPage({id: record.id, name: record.name, data: record.data}, meta.updatedAt);
    if (result.action !== 'unchanged') this.log(`re-imported ${rel}: ${result.action}`);
    // A *brand-new* conflict copy (not an OB-241 reuse) counts against the
    // per-page-id copy cap (ER-4) — the storm tripwire. Off unless a budget is set.
    if (result.action === 'conflict' && this.store.copiesMinted > copiesBefore) this.recordConflictCopy(record.id);
    if (result.action === 'unchanged') {
      // Record the bytes so an identical re-fire is ignored, no DB write needed.
      this.index.set(record.id, {path: rel, hash: fileHash, updatedAt: meta.updatedAt});
      return result.action;
    }

    // Re-mirror the canonical page at this id: for 'updated' it re-syncs the
    // hash; for 'conflict' it restores the DB-canonical content over the
    // externally-edited file (DB wins on disk too). A conflict also produced a
    // brand-new copy page, which gets its own file.
    //
    // ER-9 orphan-file guard: a 'conflict' on an id that maps to a *trashed* page
    // has NO live canonical row — the copy absorbed the dropped-in content (and gets
    // its own file below). enqueueWrite(record.id) would then route writePageFile →
    // getPage(null) → deletePageFile, which finds no index entry for the just-dropped
    // file (we never indexed it) and removes nothing — the file would leak forever
    // (reconcileAll only prunes indexed paths). Remove it directly at its imported
    // rel-path. Only 'conflict' can lack a canonical row; 'created'/'updated' always
    // have one, so the extra read is confined to the rare conflict path.
    if (result.action === 'conflict' && !(await this.store.getPage(record.id))) {
      await this.removeRel(rel);
    } else {
      this.enqueueWrite(record.id);
    }
    if (result.page.id !== record.id) this.enqueueWrite(result.page.id);
    await this.onImported?.(result.page);
    return result.action;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  /**
   * Stop the mirror's background work: mark it closed (so no further enqueue or
   * stray flush touches disk), cancel the debounced flush + every import timer, and
   * detach all watchers. Shared by {@link close} and by {@link create}'s failure
   * path, so a mirror that fails to open never leaves a timer armed to write-through
   * with no lock held. Idempotent.
   */
  private teardown(): void {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const t of this.importTimers.values()) clearTimeout(t);
    this.importTimers.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /** Stop watching, drain all pending writes, and persist. Call on shutdown. */
  async close(): Promise<void> {
    // Flush-on-exit (OB-132): the final drain must run, so authorize it past the
    // closed-guard via `closing` BEFORE teardown marks us closed. Always release the
    // single-owner lock afterwards, even if that drain trips the write budget
    // (ER-2/ER-5) — a corruption-class guard must never strand the lock.
    this.closing = true;
    this.teardown();
    try {
      await this.flush();
      await this.statePersist;
    } finally {
      this.closing = false;
      await this.releaseLock();
    }
  }
}

interface ReconcileContext {
  byId: Map<string, StoredPage>;
  dbHost: Map<string, string>;
}

/** A page's stored icon (`sys_icon` property), or empty. */
function pageIcon(page: StoredPage): string | null {
  const icon = (page.properties as Record<string, unknown>)?.sys_icon;
  return typeof icon === 'string' ? icon : null;
}

const folderName = (root: StoredPage): string => `${slugify(root.name ?? 'untitled')}--${root.id.slice(0, 8)}`;
const fileName = (page: StoredPage): string => `${slugify(page.name ?? 'untitled')}--${page.id.slice(0, 8)}.html`;
