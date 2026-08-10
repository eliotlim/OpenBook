import InlineQuickJSWorker from './quickjs.worker?worker&inline';
import type {EvalBackend, EvalRequest, EvalResult} from '../scope';
import type {EvalWorkerResponse} from './protocol';
import {isEvalResult, prepareEvalRequest} from './scopeMarshal';

interface WorkerLike {
  onmessage: ((event: MessageEvent<EvalWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

type WorkerFactory = () => WorkerLike;

const TEST_MODE = import.meta.env.MODE === 'test';

/** One lazily-created Worker shared by every document cache in this realm. */
export class QuickJSWorkerEvalBackend implements EvalBackend {
  private worker?: WorkerLike;
  private nextId = 1;
  private readonly pending = new Map<number, (result: EvalResult) => void>();
  private localTestBackend?: Promise<EvalBackend>;
  private readonly workerFactory: WorkerFactory;
  private readonly useHeadlessTestBackend: boolean;

  constructor(workerFactory?: WorkerFactory) {
    this.workerFactory = workerFactory ?? (() => new InlineQuickJSWorker());
    // Vitest cannot execute Vite's browser Worker wrapper. A supplied factory
    // is still exercised in tests so the transport can be covered headlessly.
    this.useHeadlessTestBackend = TEST_MODE && workerFactory === undefined;
  }

  evaluate(rawRequest: EvalRequest): Promise<EvalResult> {
    const request = prepareEvalRequest(rawRequest);
    if (isEvalResult(request)) return Promise.resolve(request);
    if (this.useHeadlessTestBackend) {
      // Keep the direct Vitest harness out of production's module graph. The
      // shipped backend has exactly one QuickJS copy: the inline Worker.
      this.localTestBackend ??= import(/* @vite-ignore */ './quickjsVm').then(async ({QuickJSEvaluator}) => {
        const evaluator = await QuickJSEvaluator.create();
        return {evaluate: (next: EvalRequest) => evaluator.evaluate(next)};
      });
      return this.localTestBackend.then((backend) => backend.evaluate(request));
    }
    try {
      const worker = this.ensureWorker();
      const id = this.nextId++;
      return new Promise((resolve) => {
        this.pending.set(id, resolve);
        try {
          worker.postMessage({id, request});
        } catch (error) {
          this.pending.delete(id);
          resolve({error: error instanceof Error ? error.message : String(error)});
        }
      });
    } catch (error) {
      return Promise.resolve({error: error instanceof Error ? error.message : String(error)});
    }
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    worker.onmessage = (event): void => {
      const resolve = this.pending.get(event.data.id);
      if (!resolve) return;
      this.pending.delete(event.data.id);
      resolve(event.data.result);
    };
    worker.onerror = (event): void => {
      this.failWorker(event.message || 'QuickJS evaluation Worker failed');
    };
    this.worker = worker;
    return worker;
  }

  private failWorker(message: string): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const resolve of this.pending.values()) resolve({error: message});
    this.pending.clear();
  }
}

export const quickJSEvalBackend: EvalBackend = new QuickJSWorkerEvalBackend();
