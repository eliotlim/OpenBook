import {describe, expect, it} from 'vitest';
import {QuickJSWorkerEvalBackend} from '../quickjsBackend';
import type {EvalWorkerRequest, EvalWorkerResponse} from '../protocol';

class FakeWorker {
  onmessage: ((event: MessageEvent<EvalWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  sent: EvalWorkerRequest[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message as EvalWorkerRequest);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('QuickJS Worker transport', () => {
  it('posts a sanitized request and resolves the matching asynchronous response', async () => {
    const worker = new FakeWorker();
    const backend = new QuickJSWorkerEvalBackend(() => worker);
    const result = backend.evaluate({
      kind: 'expression',
      source: 'input + 1',
      scope: {input: 3, unreferencedHostFunction: () => 99},
    });
    expect(worker.sent).toEqual([{id: 1, request: {kind: 'expression', source: 'input + 1', scope: {input: 3}}}]);
    worker.onmessage?.({data: {id: 1, result: {value: 4}}} as MessageEvent<EvalWorkerResponse>);
    await expect(result).resolves.toEqual({value: 4});
  });
});
