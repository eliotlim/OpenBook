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
  type StoredDatabase,
  type StoredPage,
} from '@book.dev/sdk';
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
}

const STATE_FILE = '.openbook-mirror.json';
const MAX_DEPTH = 64;

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

  private index = new Map<string, IndexEntry>();
  private pending = new Map<string, 'write' | 'delete'>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private statePersist: Promise<void> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private importTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  private constructor(opts: BookMirrorOptions) {
    this.store = opts.store;
    this.dir = opts.dir;
    this.onImported = opts.onImported;
    this.log = opts.log ?? (() => undefined);
    this.writeDebounceMs = opts.writeDebounceMs ?? 150;
    this.importDebounceMs = opts.importDebounceMs ?? 250;
    this.doWatch = opts.watch ?? true;
  }

  /**
   * Open the mirror under `dir`: load any prior state, replay un-flushed journal
   * entries, do a full reconcile so the folder matches the DB, then start
   * watching for external edits.
   */
  static async create(opts: BookMirrorOptions): Promise<BookMirror> {
    const mirror = new BookMirror(opts);
    await mkdir(mirror.dir, {recursive: true});
    await mirror.loadState();
    // reconcile re-enqueues anything stale; flush drains both the reconciled set
    // and any journal entries a prior crash left un-flushed.
    await mirror.reconcileAll();
    await mirror.flush();
    if (mirror.doWatch) mirror.startWatch();
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
    } catch {
      // No prior state (first run) or unreadable — start clean.
      this.index = new Map();
      this.pending = new Map();
    }
  }

  /** Persist the journal + index atomically (serialized so writes don't race). */
  private persistState(): Promise<void> {
    const state: MirrorState = {
      version: 1,
      index: Object.fromEntries(this.index),
      pending: Object.fromEntries(this.pending),
    };
    this.statePersist = this.statePersist
      .then(() => this.atomicWrite(this.statePath, JSON.stringify(state)))
      // Best-effort: the journal is re-derived from the (canonical) DB on boot,
      // so a failed persist (e.g. the dir was removed) must never crash the app.
      .catch((err) => this.log(`book mirror: state persist failed: ${String(err)}`));
    return this.statePersist;
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
      void this.flush();
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
    for (const p of pages) {
      const path = this.relPathFor(p.id, ctx);
      const entry = this.index.get(p.id);
      // (Re)write when new, moved, content changed since we last mirrored, or the
      // file went missing out-of-band (a crash mid-write, or an external delete).
      // The DB is canonical, so reconcile always restores the disk to match it.
      const missing = !entry || !existsSync(join(this.dir, entry.path));
      if (missing || entry!.path !== path || entry!.updatedAt !== p.updatedAt) this.enqueueWrite(p.id);
    }
    // Prune files for pages that no longer exist (deleted subtrees, purges).
    for (const id of [...this.index.keys()]) if (!live.has(id)) this.enqueueDelete(id);
  }

  private async writePageFile(pageId: string): Promise<void> {
    const page = await this.store.getPage(pageId);
    if (!page) {
      // Gone since enqueue — treat as a delete.
      await this.deletePageFile(pageId);
      return;
    }
    const rel = await this.relPathForLive(page);
    const abs = join(this.dir, rel);
    const html = pageToBookHtml({id: page.id, name: page.name, icon: pageIcon(page), updatedAt: page.updatedAt, data: page.data});
    const hash = contentHash(html);

    const prior = this.index.get(pageId);
    // A move/rename changes the path — remove the stale file first.
    if (prior && prior.path !== rel) await this.removeRel(prior.path);

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
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, abs); // atomic on the same filesystem
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
          // The root watcher sees folder churn; (re)attach to keep coverage.
          if (target === this.dir && !name.endsWith('.html') && !name.startsWith('.')) {
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

    const result = await this.store.importBookPage({id: record.id, name: record.name, data: record.data}, meta.updatedAt);
    if (result.action !== 'unchanged') this.log(`re-imported ${rel}: ${result.action}`);
    if (result.action === 'unchanged') {
      // Record the bytes so an identical re-fire is ignored, no DB write needed.
      this.index.set(record.id, {path: rel, hash: fileHash, updatedAt: meta.updatedAt});
      return result.action;
    }

    // Re-mirror the canonical page at this id: for 'updated' it re-syncs the
    // hash; for 'conflict' it restores the DB-canonical content over the
    // externally-edited file (DB wins on disk too). A conflict also produced a
    // brand-new copy page, which gets its own file.
    this.enqueueWrite(record.id);
    if (result.page.id !== record.id) this.enqueueWrite(result.page.id);
    await this.onImported?.(result.page);
    return result.action;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────

  /** Stop watching, drain all pending writes, and persist. Call on shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const t of this.importTimers.values()) clearTimeout(t);
    this.importTimers.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
    await this.flush();
    await this.statePersist;
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
