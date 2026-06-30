/**
 * The **pure, transport-free core** of the import parse — the exact heavy work
 * that the import Web Worker runs off the main thread (and that the main-thread
 * fallback runs inline). Keeping it here, free of `Worker`/DOM/`import.meta`,
 * makes the parse seam directly unit-testable and lets the same function back
 * both the worker shell ({@link file://./importWorker.ts}) and the fallback path
 * ({@link file://./importParse.ts}) with no divergence.
 *
 * Why a worker at all: {@link parseImportSource} runs a synchronous
 * `fflate.unzipSync` + the Notion/Markdown parse + IR build, and
 * {@link summarizeImportedDoc} walks the whole tree — for a large Notion export
 * (hundreds of pages, big CSVs) that blocks the main thread for seconds, so even
 * the loading spinner freezes. Moving it to a worker keeps the UI live.
 */
import {
  parseImportSource,
  summarizeImportedDoc,
  type ImportSource,
  type ImportSummary,
} from './importContent';
import type {ImportedDoc} from '@book.dev/sdk';

/** A coarse phase signal so the dialog shows live progress, not a frozen spinner. */
export type ImportParsePhase = 'parsing' | 'summarizing';

/** One progress tick from the parse. `pages` is known once summarizing finishes. */
export interface ImportParseProgress {
  phase: ImportParsePhase;
  pages?: number;
}

/** What a successful parse yields: the format-agnostic IR plus its honest tally. */
export interface ImportParseResult {
  doc: ImportedDoc;
  summary: ImportSummary;
}

// ── Worker message protocol ──────────────────────────────────────────────────

/** Main → worker: parse this source. The source is structured-clone-safe (a
 *  `Uint8Array` of zip bytes, or Markdown text). */
export interface ImportParseRequest {
  type: 'parse';
  source: ImportSource;
}

/** Worker → main: a one-time `ready` heartbeat the worker posts as soon as its
 *  script evaluates (proving it loaded off-thread, before any parse), then a
 *  progress tick, the final result, or a friendly error. The `error` branch
 *  carries a *message* (already humanised by {@link parseImportSource}), never a
 *  thrown `Error` that would surface as an uncaught worker error. */
export type ImportParseResponse =
  | {type: 'ready'; marker: string}
  | {type: 'progress'; progress: ImportParseProgress}
  | {type: 'result'; result: ImportParseResult}
  | {type: 'error'; message: string};

/**
 * Run the heavy parse synchronously, emitting coarse progress. This is exactly
 * what the worker executes (and what the main-thread fallback runs inline), so
 * the two paths can never diverge. A bad zip propagates as a thrown `Error`
 * whose message is already friendly (`parseImportSource` rewrites the raw
 * `fflate` failure), so callers either re-post it as `{type:'error'}` (worker)
 * or surface it directly (fallback) — the "never crash, always a message"
 * contract holds end-to-end.
 */
export function runImportParse(
  source: ImportSource,
  onProgress?: (p: ImportParseProgress) => void,
): ImportParseResult {
  onProgress?.({phase: 'parsing'});
  const doc = parseImportSource(source);
  onProgress?.({phase: 'summarizing'});
  const summary = summarizeImportedDoc(doc);
  onProgress?.({phase: 'summarizing', pages: summary.pages});
  return {doc, summary};
}
