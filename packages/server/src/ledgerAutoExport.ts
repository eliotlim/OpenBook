/**
 * Ledger auto-export (LGR-7 insurance): whenever the ledger mutates, write the
 * canonical postings CSV to the owner-configured `ledgerAutoExportPath` —
 * debounced, atomically — so the book ALWAYS exists on disk in canonical form
 * even if the app never opens again.
 *
 * Shape mirrors `BackupScheduler` (the periodic-job reference): a single
 * unref'd timer, config read fresh per run (a policy change takes effect on
 * the next mutation, no restart). OFF by default: an unset/null path makes
 * every trigger a silent no-op. Timers and fs are injectable
 * (`parentDeath.ts` testability pattern) so tests drive it deterministically.
 *
 * SECURITY — this writer treats its own target as hostile (LGR-7 S2):
 *
 *  - **Fenced.** The target must be an absolute path INSIDE one of the allowed
 *    export roots (a dedicated `<dataDir>/exports` subtree — never the live
 *    PGlite data dir itself, which the export would otherwise be able to
 *    clobber — plus anything the operator adds out-of-band via
 *    `--ledger-export-root` / `OPENBOOK_LEDGER_EXPORT_ROOTS`). The roots are
 *    reachable only from the process command line/env — never from the HTTP
 *    surface — so no request can widen the fence it is checked against. Without
 *    this, a path setting is an arbitrary-file-overwrite primitive
 *    (`/etc/…`, `~/.ssh/authorized_keys`, `~/.zshrc`, or the server's own PGlite
 *    data dir), and because the CSV's `description` column is authored by ANY
 *    draft-writer while line-oriented consumers ignore RFC-4180 quoting, that
 *    primitive composes into code execution as the server user. A refused path
 *    is reported through `onError` — visibly, never a silent no-op.
 *  - **Fenced on REAL paths.** Roots and the target's parent directory are both
 *    resolved through `realpath`, so an intermediate DIRECTORY symlink planted
 *    inside a root cannot redirect the write out of the fence (see
 *    {@link fenceExportPath}).
 *  - **Unplantable temp.** The temp file carries a random suffix and is opened
 *    `O_CREAT|O_EXCL|O_NOFOLLOW` at mode 0600, so a co-tenant cannot pre-plant a
 *    symlink at a predictable `<path>.tmp` and have the write follow it (and
 *    then have `rename` move the LINK into place).
 *  - **Not world-readable.** 0600: the book is financial data.
 *
 * Atomicity is unchanged: write the temp file fully, fsync, then `rename` into
 * place — a crash mid-write never leaves a truncated CSV at the target.
 */

import {randomUUID} from 'node:crypto';
import {constants, realpathSync} from 'node:fs';
import {open, rename, rm} from 'node:fs/promises';
import {dirname, isAbsolute, resolve, sep} from 'node:path';
import type {PageStore} from './store';
import type {UnrefTimer} from './parentDeath';

/** How the export writes its bytes (injectable so tests can fail it precisely). */
export interface LedgerExportWriter {
  /** Create the temp file exclusively (no symlink follow) and write it. */
  writeTemp(tmpPath: string, data: string): Promise<void>;
  /** Move the finished temp file onto the target. */
  commit(tmpPath: string, target: string): Promise<void>;
}

export interface LedgerAutoExporterOptions {
  /**
   * Directories the export target must live inside. Anything outside is
   * REFUSED. Supplied by the process (data dir + operator-configured roots) —
   * never by a request. An empty list refuses every path (fail closed).
   */
  allowRoots?: readonly string[];
  /** Quiet window after the last mutation before the export runs (ms). Default 2000. */
  debounceMs?: number;
  /**
   * Ceiling on how long mutations may keep pushing the debounce out (ms).
   * Default 60_000. Without it a continuously-written book NEVER exports —
   * every mutation clears the pending timer — which is an insurance failure
   * precisely when the book is most active.
   */
  maxWaitMs?: number;
  /** Injectable timers (tests). Default global setTimeout/clearTimeout. */
  setTimeoutImpl?: (cb: () => void, ms: number) => UnrefTimer;
  clearTimeoutImpl?: (handle: UnrefTimer) => void;
  /** Injectable writer (tests — e.g. a write or a rename that fails mid-flight). */
  writer?: LedgerExportWriter;
  /** Clock (tests). */
  now?: () => number;
  /** Export-failure sink. Default `console.error` — insurance must not throw. */
  onError?: (err: unknown) => void;
}

/**
 * Resolve `target` and require it to sit inside one of `roots`. Throws
 * otherwise. `..` traversal, a relative path, and a root-prefix lookalike
 * (`/data-evil` vs `/data`) are all rejected.
 *
 * The comparison is made on REAL paths, never lexical ones (LGR-7 S1). A
 * lexical prefix check is defeated by an intermediate DIRECTORY symlink planted
 * inside an allowed root — `<root>/sub -> /outside` makes `<root>/sub/x.csv`
 * pass the fence while the bytes land on `/outside/x.csv` — and the writer's
 * `O_NOFOLLOW` only guards the FINAL component, so it cannot catch this. Both
 * the target's PARENT DIRECTORY and each root are therefore resolved through
 * `realpath` before comparing. The parent has to exist for the write to succeed
 * anyway, so a parent that cannot be resolved is a refusal (fail closed), and
 * a root that cannot be resolved simply matches nothing.
 *
 * Resolving both sides also removes a fail-closed asymmetry: with a symlinked
 * root (`/link -> /real`), `/link/a.csv` and `/real/a.csv` now both pass.
 */
export function fenceExportPath(target: string, roots: readonly string[]): string {
  if (!isAbsolute(target)) {
    throw new Error(`ledgerAutoExportPath must be an absolute path, got ${JSON.stringify(target)}`);
  }
  const abs = resolve(target);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(abs));
  } catch {
    throw new Error(
      `ledgerAutoExportPath ${abs} has no resolvable parent directory — refusing (the parent must exist to write into)`,
    );
  }
  const ok = roots.some((root) => {
    let base: string;
    try {
      base = realpathSync(resolve(root));
    } catch {
      return false; // an unresolvable root allows nothing
    }
    // A root that is already `/` must not become the `//` prefix no normal
    // absolute path satisfies — that would DISABLE the export rather than open
    // the fence, which is not what `--ledger-export-root /` asks for.
    const prefix = base.endsWith(sep) ? base : base + sep;
    return realParent === base || realParent.startsWith(prefix);
  });
  if (!ok) {
    throw new Error(
      `ledgerAutoExportPath ${abs} is outside the allowed export roots (${roots.length > 0 ? roots.join(', ') : 'none configured'})`,
    );
  }
  return abs;
}

/** The real writer: exclusive, no-follow, 0600, fsync'd, then renamed. */
const nodeWriter: LedgerExportWriter = {
  async writeTemp(tmpPath, data) {
    const fh = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync(); // durable before the rename makes it the live export
    } finally {
      await fh.close();
    }
  },
  commit: (tmpPath, target) => rename(tmpPath, target),
};

export class LedgerAutoExporter {
  private timer: UnrefTimer | null = null;
  private unsubscribe: (() => void) | null = null;
  /** When the currently-pending debounce window started (max-wait anchor). */
  private firstPendingAt: number | null = null;
  /** The export chain — runs settle strictly one after another (never overlap). */
  private inflight: Promise<string | null> = Promise.resolve(null);
  /**
   * Whether a SUCCESSOR is already chained behind the in-flight run. The chain
   * is COLLAPSED to depth 1: waiting runs are fully redundant of each other
   * (each is a full ledger read + CSV build + fsync producing the same file),
   * so under bursty writes an unconditional append would grow the chain
   * without bound.
   *
   * Released the moment that successor STARTS, never when it finishes. On
   * completion this would be DROP semantics: a mutation landing while a run is
   * in flight would find the flag still set, return early, and never export —
   * so if writes then stopped, the final state would never reach the file.
   * That is exactly the insurance failure the debounce ceiling exists to
   * prevent. Releasing at start also means the successor reads the ledger
   * fresh, after its predecessor settled.
   */
  private queued = false;

  constructor(
    private readonly store: PageStore,
    private readonly opts: LedgerAutoExporterOptions = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Subscribe to ledger mutations. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.ledger.onMutation(() => this.schedule());
  }

  /** Unsubscribe + cancel any pending debounce. A running export finishes. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      (this.opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    this.firstPendingAt = null;
  }

  /** Await the whole export chain (tests + graceful shutdown). */
  flush(): Promise<string | null> {
    return this.inflight;
  }

  /**
   * Debounce: each mutation re-arms the timer, so a burst produces ONE export —
   * but never past `maxWaitMs` since the first un-exported mutation, so a book
   * under constant write still gets its insurance copy.
   */
  private schedule(): void {
    const setTimeoutImpl =
      this.opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms) as unknown as UnrefTimer);
    const clearTimeoutImpl =
      this.opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));

    const debounceMs = this.opts.debounceMs ?? 2000;
    const maxWaitMs = this.opts.maxWaitMs ?? 60_000;
    const now = this.now();
    if (this.firstPendingAt === null) this.firstPendingAt = now;
    // Never push the run past the ceiling measured from the first pending
    // mutation (clamped at 0 so an elapsed ceiling fires on the next tick).
    const remainingCeiling = Math.max(0, this.firstPendingAt + maxWaitMs - now);
    const delay = Math.min(debounceMs, remainingCeiling);

    if (this.timer) clearTimeoutImpl(this.timer);
    const timer = setTimeoutImpl(() => {
      this.timer = null;
      this.firstPendingAt = null;
      // CHAIN, never overwrite: two runs must not interleave onto the same
      // target (each would write its own temp and race the rename/cleanup).
      // At most ONE run may wait behind the in-flight one — a second waiter
      // would only redo identical work.
      if (this.queued) return;
      this.queued = true;
      // Release the slot as this successor BEGINS, so the next mutation can
      // queue one behind IT rather than being dropped (see `queued`).
      const begin = (): Promise<string | null> => {
        this.queued = false;
        return this.runExport();
      };
      this.inflight = this.inflight.then(begin, begin);
    }, delay);
    timer.unref?.(); // never hold the process open for insurance
    this.timer = timer;
  }

  /**
   * One export: read the path from instance config (fresh — owner changes
   * apply immediately), fence it, build the canonical CSV, write an
   * unpredictable exclusive temp file, rename it into place. Returns the
   * written path, or null when auto-export is off or the path was refused.
   * Never throws — failures go to `onError` (default `console.error`).
   */
  async runExport(): Promise<string | null> {
    const writer = this.opts.writer ?? nodeWriter;
    let tmp: string | null = null;
    try {
      const configured = (await this.store.getInstanceConfig()).ledgerAutoExportPath;
      if (!configured) return null; // off (the default) — silent no-op
      // Fenced BEFORE anything is read or written: a refused path must never
      // even cause the book to be serialized.
      const target = fenceExportPath(configured, this.opts.allowRoots ?? []);
      const csv = await this.store.ledger.exportPostingsCsv();
      // Unpredictable name ⇒ a co-tenant cannot pre-plant a symlink here, and
      // two runs can never collide on the same temp file.
      tmp = `${target}.${randomUUID()}.tmp`;
      await writer.writeTemp(tmp, csv);
      await writer.commit(tmp, target);
      return target;
    } catch (err) {
      if (tmp) await rm(tmp, {force: true}).catch(() => {});
      (this.opts.onError ?? ((e) => console.error('OpenBook ledger auto-export failed:', e)))(err);
      return null;
    }
  }
}
