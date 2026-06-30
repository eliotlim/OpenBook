/// <reference lib="webworker" />
/**
 * The import-parse **Web Worker** — runs `unzipSync` + the Notion/Markdown parse
 * + IR build + summarize OFF the main thread, so a large import never freezes
 * the UI (the loading spinner keeps animating). Imported by
 * {@link file://./importParse.ts} with `?worker&inline`, so its bundled code is
 * **embedded** (a blob/data-URI) inside the prebuilt lib's `dist/index.js` and
 * needs no downstream asset resolution — it loads off-thread identically in the
 * web (Next/Turbopack) and desktop (Tauri/Vite) consumers.
 *
 * It imports ONLY {@link file://./importParseCore.ts} (never the spawn-side), so
 * there is no nested-worker reference. A parse failure is caught and posted back
 * as a friendly `{type:'error'}` — never an uncaught worker error that would
 * slip past the dialog's try/catch.
 */
import {runImportParse, type ImportParseRequest, type ImportParseResponse} from './importParseCore';

/**
 * A distinctive, worker-ONLY sentinel. Because this module is reachable solely
 * through the `?worker&inline` import (never on the main thread), this literal
 * appears in a shipped bundle *only* inside the embedded worker code — so its
 * presence in a consumer build proves the parse really runs off-thread (vs. the
 * main-thread fallback). It also rides the `ready` heartbeat below for a runtime
 * "alive in worker scope" signal.
 */
const WORKER_SCOPE_MARKER = 'ob-import-worker-scope/v1';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: ImportParseResponse): void => ctx.postMessage(msg);

// Posted the instant the worker script evaluates — before any parse — so the
// seam's startup watchdog can confirm the worker genuinely loaded off-thread
// (the failure mode a prebuilt-lib worker is most prone to) rather than waiting
// on the first parse tick.
post({type: 'ready', marker: WORKER_SCOPE_MARKER});

ctx.onmessage = (e: MessageEvent<ImportParseRequest>): void => {
  const data = e.data;
  if (!data || data.type !== 'parse') return;
  try {
    const result = runImportParse(data.source, (progress) => post({type: 'progress', progress}));
    post({type: 'result', result});
  } catch (err) {
    post({type: 'error', message: (err as Error)?.message || 'Import failed.'});
  }
};
