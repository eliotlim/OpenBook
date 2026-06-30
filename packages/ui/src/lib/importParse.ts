/**
 * The main-thread **seam** that runs an import parse off the main thread in a Web
 * Worker, with a guaranteed main-thread fallback, a startup-liveness watchdog,
 * and abort-on-close. The dialog calls {@link parseImportInWorker}; everything
 * below — worker construction, the message-protocol wiring, the watchdog, and
 * the fallback — is internal.
 *
 * **Bundling (the lib→consumer crux).** This package ships as a **prebuilt Vite
 * library** that externalizes its deps; web (Next/Turbopack) and desktop (Tauri/
 * Vite) consume `dist/index.js` as-is. A plain `new Worker(new URL('./w.ts',
 * import.meta.url))` lib-builds to a *separate* chunk referenced by an absolute
 * `/assets/…` path with `@vite-ignore` — which the consumer never copies, so it
 * 404s downstream and the worker silently never loads (it'd degrade straight to
 * the main-thread freeze T7 set out to fix). Instead the worker is imported with
 * `?worker&inline`, so its code is **embedded inside `dist/index.js`** (a blob)
 * and needs no downstream asset resolution — it runs off-thread identically in
 * every consumer.
 *
 * **Never hangs, never breaks desktop.** Worker-infrastructure failures
 * (construction throws, the script fails to load, an `onerror`/`messageerror`
 * before a reply, a `postMessage` throw, or — the watchdog case — *no first
 * message at all* within a startup window) transparently fall back to a
 * main-thread parse. A *parse* failure the worker reports (`{type:'error'}`) is a
 * real, humanised error and rejects (no pointless re-parse of the same bad
 * input). Closing the dialog aborts + terminates the in-flight worker.
 */
import ImportParseWorker from './importWorker?worker&inline';
import {
  runImportParse,
  type ImportParseProgress,
  type ImportParseRequest,
  type ImportParseResponse,
  type ImportParseResult,
} from './importParseCore';
import type {ImportSource} from './importContent';

export type {ImportParseProgress, ImportParseResult} from './importParseCore';

/** Factory for the parse worker — injectable so tests supply a fake. */
export type ImportWorkerFactory = () => Worker;

/** How long (ms) to wait for the worker's *first* message before assuming it
 *  never started and falling back. Generous: an inline blob worker starts in
 *  single-digit ms, so this only ever trips on a genuinely dead worker. */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Construct the inline parse worker, or return `null` when the environment can't
 * host one (SSR/Node, or a webview that rejects the worker). Guarded by a
 * `typeof Worker` check and a try/catch so the caller routes to the main-thread
 * fallback instead of throwing.
 */
export function defaultImportWorkerFactory(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new ImportParseWorker();
  } catch {
    return null;
  }
}

/** Options for {@link parseImportInWorker}. */
export interface ParseImportOptions {
  /** Progress ticks (worker path only — a main-thread parse blocks until done). */
  onProgress?: (p: ImportParseProgress) => void;
  /**
   * Worker factory override. `undefined` (default) uses
   * {@link defaultImportWorkerFactory}; a function injects a fake (tests); `null`
   * forces the main-thread path.
   */
  workerFactory?: ImportWorkerFactory | null;
  /** Abort + terminate the in-flight worker (e.g. the dialog closes/unmounts).
   *  Rejects the parse with an `AbortError` the caller can ignore. */
  signal?: AbortSignal;
  /** Startup-liveness watchdog window in ms (`0` disables it; for tests). */
  startupTimeoutMs?: number;
}

function safeCreate(factory: () => Worker | null): Worker | null {
  try {
    return factory();
  } catch {
    return null;
  }
}

function runOnMainThread(
  source: ImportSource,
  onProgress?: (p: ImportParseProgress) => void,
): Promise<ImportParseResult> {
  try {
    return Promise.resolve(runImportParse(source, onProgress));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

function abortError(): Error {
  const e = new Error('Import parse aborted');
  e.name = 'AbortError';
  return e;
}

/** True for the abort signal we raise on close — the dialog ignores it (no error UI). */
export function isImportAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Parse a source into the IR + summary, **off the main thread** when a Web
 * Worker is available, else inline. Either way the same contract holds: a bad
 * zip rejects with a readable message, never an uncaught worker error, and the
 * dialog never hangs.
 *
 * The zip bytes are sent by structured *clone* (not transferred): a transfer
 * would neuter the caller's buffer, breaking the main-thread fallback if the
 * worker then fails. The one-time copy is cheap next to the parse it unblocks.
 */
export function parseImportInWorker(
  source: ImportSource,
  opts: ParseImportOptions = {},
): Promise<ImportParseResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const factory: (() => Worker | null) | null =
    opts.workerFactory === undefined ? defaultImportWorkerFactory : opts.workerFactory;
  const worker = factory ? safeCreate(factory) : null;
  if (!worker) return runOnMainThread(source, opts.onProgress);

  return new Promise<ImportParseResult>((resolve, reject) => {
    let settled = false;
    let started = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const signal = opts.signal;

    const disarm = (): void => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    const cleanup = (): void => {
      disarm();
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    // Worker-infra failure (load error, clone error, or a silent never-started
    // worker via the watchdog) → fall back to a main-thread parse exactly once.
    const fallback = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      runOnMainThread(source, opts.onProgress).then(resolve, reject);
    };
    // Dialog closed/unmounted → kill the worker and reject as aborted; the caller
    // recognises {@link isImportAbortError} and shows nothing.
    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort);

    worker.onerror = fallback;
    worker.onmessageerror = fallback;
    worker.onmessage = (e: MessageEvent<ImportParseResponse>): void => {
      const msg = e.data;
      // The first reply of ANY kind proves the worker loaded and began running
      // (it posts a `ready` heartbeat the instant its script evaluates), so the
      // startup watchdog can stand down — a slow-but-alive parse is never killed.
      if (!started) {
        started = true;
        disarm();
      }
      // `ready` and `progress` are non-terminal — acknowledge and keep waiting.
      if (msg.type === 'ready') return;
      if (msg.type === 'progress') {
        opts.onProgress?.(msg.progress);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (msg.type === 'result') resolve(msg.result);
      else reject(new Error(msg.message));
    };

    // Startup-liveness watchdog: a worker that loaded posts its first message
    // within the window; *no* first message means it never started — failed to
    // load, was killed before any output, or was OOM-reaped before posting, all
    // cases where browsers don't reliably fire `error`. Fall back rather than
    // hang the spinner forever. (A mid-parse death strictly *after* the first
    // tick can't be distinguished from a slow-but-alive synchronous parse without
    // parser heartbeats, so it is out of scope here.)
    const timeout = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    if (timeout > 0) {
      watchdog = setTimeout(() => {
        if (!started) fallback();
      }, timeout);
    }

    const req: ImportParseRequest = {type: 'parse', source};
    try {
      worker.postMessage(req);
    } catch {
      // postMessage itself threw (e.g. an un-cloneable source) — fall back.
      fallback();
    }
  });
}
