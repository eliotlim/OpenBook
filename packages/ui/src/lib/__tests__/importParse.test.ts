import {describe, it, expect, vi} from 'vitest';
import {runImportParse, type ImportParseRequest, type ImportParseResponse} from '../importParseCore';
import {parseImportInWorker, type ImportWorkerFactory} from '../importParse';
import type {ImportSource} from '../importContent';

const MD: ImportSource = {format: 'markdown', text: '# Launch plan\n\nHello world'};
const BAD_ZIP: ImportSource = {format: 'notion-zip', bytes: new Uint8Array([1, 2, 3, 4, 5]), fileName: 'bad.zip'};

// ── The pure parse core (exactly what the worker runs off-thread) ─────────────
describe('runImportParse (pure core)', () => {
  it('parses a source to {doc, summary} and emits progress phases', () => {
    const phases: string[] = [];
    const {doc, summary} = runImportParse(MD, (p) => phases.push(p.phase));
    expect(doc.pages[0].title).toBe('Launch plan');
    expect(summary.pages).toBe(1);
    // Parsing then summarizing — a real progress signal for the dialog.
    expect(phases).toEqual(['parsing', 'summarizing', 'summarizing']);
  });

  it('reports the page tally on the final progress tick', () => {
    const ticks: Array<number | undefined> = [];
    runImportParse(MD, (p) => ticks.push(p.pages));
    expect(ticks[ticks.length - 1]).toBe(1);
  });

  it('throws a friendly Error for a bad zip (never an uncaught throw)', () => {
    expect(() => runImportParse(BAD_ZIP)).toThrow(/readable Notion export zip/i);
  });
});

/**
 * A structural stand-in for a real `Worker`: it scripts the responses the import
 * worker would post, so the protocol wiring + fallback are testable without a
 * real off-thread worker (which a unit test can't host).
 */
type Script = ImportParseResponse[] | 'error' | 'messageerror' | 'throw-on-post' | 'silent';

class FakeWorker {
  onmessage: ((e: {data: ImportParseResponse}) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  posted: ImportParseRequest[] = [];
  constructor(private readonly script: Script) {}
  postMessage(req: ImportParseRequest): void {
    const script = this.script;
    if (script === 'throw-on-post') throw new Error('cannot clone');
    this.posted.push(req);
    if (script === 'silent') return; // a dead/never-replying worker — the watchdog case
    queueMicrotask(() => {
      if (this.terminated) return;
      if (script === 'error') return void this.onerror?.(new Error('worker script failed to load'));
      if (script === 'messageerror') return void this.onmessageerror?.(new Error('uncloneable reply'));
      if (!Array.isArray(script)) return;
      for (const msg of script) {
        if (this.terminated) return;
        this.onmessage?.({data: msg});
      }
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

const factoryOf = (script: Script): ImportWorkerFactory => () => new FakeWorker(script) as unknown as Worker;

/** A factory that also exposes the worker it created, so a test can assert it
 *  was terminated / inspect its posts. */
function capturingFactory(script: Script): {factory: ImportWorkerFactory; created: () => FakeWorker | undefined} {
  let made: FakeWorker | undefined;
  return {
    factory: () => {
      made = new FakeWorker(script);
      return made as unknown as Worker;
    },
    created: () => made,
  };
}

const RESULT: ImportParseResponse = {
  type: 'result',
  result: {doc: {pages: [{title: 'From worker', blocks: []}]}, summary: {pages: 1, databases: 0, rows: 0, images: 0}},
};

describe('parseImportInWorker — worker message protocol', () => {
  it('posts the parse request, forwards progress, and resolves with the worker result', async () => {
    const onProgress = vi.fn();
    const result = await parseImportInWorker(MD, {
      onProgress,
      workerFactory: factoryOf([
        {type: 'progress', progress: {phase: 'parsing'}},
        {type: 'progress', progress: {phase: 'summarizing', pages: 1}},
        RESULT,
      ]),
    });
    expect(result.doc.pages[0].title).toBe('From worker');
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({phase: 'summarizing', pages: 1});
  });

  it('treats the ready heartbeat as a non-terminal first message (disarms watchdog, not a result)', async () => {
    const onProgress = vi.fn();
    // ready arrives first (well within the tiny window), then — after it — the
    // result; the watchdog must already be disarmed so this resolves, not falls back.
    const result = await parseImportInWorker(MD, {
      onProgress,
      startupTimeoutMs: 30,
      workerFactory: factoryOf([{type: 'ready', marker: 'ob-import-worker-scope/v1'}, RESULT]),
    });
    expect(result.doc.pages[0].title).toBe('From worker');
    expect(onProgress).not.toHaveBeenCalled(); // ready is not a progress tick
  });

  it('rejects with the friendly message when the worker reports a parse error (no main-thread re-parse)', async () => {
    // The source here WOULD parse fine on the main thread; proving the promise
    // rejects shows a worker-reported error is surfaced, not silently retried.
    await expect(
      parseImportInWorker(MD, {workerFactory: factoryOf([{type: 'error', message: 'not a readable Notion export zip'}])}),
    ).rejects.toThrow(/readable Notion export zip/i);
  });
});

describe('parseImportInWorker — main-thread fallback (never break desktop)', () => {
  it('falls back to a main-thread parse when the worker errors before replying', async () => {
    const result = await parseImportInWorker(MD, {workerFactory: factoryOf('error')});
    expect(result.doc.pages[0].title).toBe('Launch plan'); // real parse, not the worker stub
  });

  it('falls back when the worker reports a messageerror', async () => {
    const result = await parseImportInWorker(MD, {workerFactory: factoryOf('messageerror')});
    expect(result.summary.pages).toBe(1);
  });

  it('falls back when worker construction throws', async () => {
    const throwingFactory: ImportWorkerFactory = () => {
      throw new Error('Worker is not a constructor');
    };
    const result = await parseImportInWorker(MD, {workerFactory: throwingFactory});
    expect(result.doc.pages[0].title).toBe('Launch plan');
  });

  it('falls back when postMessage throws (uncloneable source)', async () => {
    const result = await parseImportInWorker(MD, {workerFactory: factoryOf('throw-on-post')});
    expect(result.doc.pages[0].title).toBe('Launch plan');
  });

  it('parses inline when workerFactory is null (forced main thread)', async () => {
    const onProgress = vi.fn();
    const result = await parseImportInWorker(MD, {workerFactory: null, onProgress});
    expect(result.summary.pages).toBe(1);
    expect(onProgress).toHaveBeenCalled(); // the same progress signal, run inline
  });

  it('still surfaces a friendly error on the forced main-thread path', async () => {
    await expect(parseImportInWorker(BAD_ZIP, {workerFactory: null})).rejects.toThrow(/readable Notion export zip/i);
  });
});

describe('parseImportInWorker — startup watchdog (no infinite hang)', () => {
  it('falls back to the main thread when the worker never replies (dead/no-reply)', async () => {
    // A worker that loaded but produced no message (e.g. OOM-reaped before its
    // first post, where the browser fires no `error`) must not hang forever.
    const {factory, created} = capturingFactory('silent');
    const result = await parseImportInWorker(MD, {workerFactory: factory, startupTimeoutMs: 5});
    expect(result.doc.pages[0].title).toBe('Launch plan'); // real main-thread parse
    expect(created()?.terminated).toBe(true); // the dead worker was torn down
  });

  it('does NOT trip the watchdog once the worker has sent its first message', async () => {
    // First a progress tick (disarms the watchdog), then — after the short window
    // — the real result; a slow-but-alive worker must still resolve, not fall back.
    const worker = new FakeWorker([]);
    const factory: ImportWorkerFactory = () => worker as unknown as Worker;
    const p = parseImportInWorker(MD, {workerFactory: factory, startupTimeoutMs: 10});
    worker.onmessage?.({data: {type: 'progress', progress: {phase: 'parsing'}}});
    await new Promise((r) => setTimeout(r, 25)); // outlive the watchdog window
    worker.onmessage?.({data: RESULT});
    expect((await p).doc.pages[0].title).toBe('From worker'); // the worker result, not a fallback
  });
});

describe('parseImportInWorker — terminate on settle / close', () => {
  it('terminates the worker after settling on a result', async () => {
    const {factory, created} = capturingFactory([RESULT]);
    await parseImportInWorker(MD, {workerFactory: factory});
    expect(created()?.terminated).toBe(true);
  });

  it('aborts + terminates the in-flight worker and rejects (AbortError) when the signal fires', async () => {
    const {factory, created} = capturingFactory('silent');
    const controller = new AbortController();
    const p = parseImportInWorker(MD, {workerFactory: factory, signal: controller.signal, startupTimeoutMs: 0});
    controller.abort();
    await expect(p).rejects.toMatchObject({name: 'AbortError'});
    expect(created()?.terminated).toBe(true);
  });

  it('rejects immediately without constructing a worker when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const factory = vi.fn<ImportWorkerFactory>(() => new FakeWorker([RESULT]) as unknown as Worker);
    await expect(parseImportInWorker(MD, {workerFactory: factory, signal: controller.signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(factory).not.toHaveBeenCalled();
  });
});
