import {describe, expect, it, vi} from 'vitest';
import {createDoc, findBlock, setBlockProp} from '../../model';
import {ReactiveEvalCache} from '../evalCache';
import {
  captureScopeProgram,
  evaluateScopeProgram,
  type EvalBackend,
  type EvalRequest,
  type EvalResult,
} from '../scope';
import {quickJSEvalBackend} from '../sandbox/quickjsBackend';

function controlledBackend(): {
  backend: EvalBackend;
  requests: EvalRequest[];
  resolveNext(result: EvalResult): void;
  } {
  const requests: EvalRequest[] = [];
  const resolvers: Array<(result: EvalResult) => void> = [];
  return {
    requests,
    backend: {
      evaluate(request) {
        requests.push(request);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    },
    resolveNext(result) {
      const resolve = resolvers.shift();
      if (!resolve) throw new Error('No pending evaluation');
      resolve(result);
    },
  };
}

describe('ReactiveEvalCache', () => {
  it('returns pending synchronously, retains last-known value, then notifies with the new version', async () => {
    const doc = createDoc([{id: 'input', type: 'number', props: {name: 'x', value: 2}}]);
    const controlled = controlledBackend();
    const cache = new ReactiveEvalCache(doc, controlled.backend);
    const notify = vi.fn();
    cache.subscribe(notify);

    cache.requestCell(0, 'chart', 'x * 2');
    expect(cache.getCellSnapshot('chart')).toMatchObject({pending: true, version: 0});
    await vi.waitFor(() => expect(controlled.requests).toHaveLength(1));
    expect(controlled.requests[0]).toMatchObject({kind: 'expression', source: 'x * 2', scope: {x: 2}});
    controlled.resolveNext({value: 4});
    await vi.waitFor(() => expect(cache.getCellSnapshot('chart')).toEqual({value: 4, pending: false, version: 0}));

    const input = findBlock(doc, 'input')!.block;
    doc.transact(() => setBlockProp(input, 'value', 4), 'local');
    cache.requestVersion(1);
    cache.requestCell(1, 'chart', 'x * 2');
    // No blocking/blank flash: render can keep the last completed value.
    expect(cache.getCellSnapshot('chart')).toEqual({value: 4, pending: true, version: 1});
    await vi.waitFor(() => expect(controlled.requests).toHaveLength(2));
    expect(controlled.requests[1].scope).toMatchObject({x: 4});
    controlled.resolveNext({value: 8});
    await vi.waitFor(() => expect(cache.getCellSnapshot('chart')).toEqual({value: 8, pending: false, version: 1}));
    expect(notify).toHaveBeenCalled();
  });

  it('surfaces evaluator errors in the cached result', async () => {
    const doc = createDoc([]);
    const controlled = controlledBackend();
    const cache = new ReactiveEvalCache(doc, controlled.backend);
    cache.requestCell(0, 'light', 'missing + 1');
    await vi.waitFor(() => expect(controlled.requests).toHaveLength(1));
    controlled.resolveNext({error: 'missing is not defined'});
    await vi.waitFor(() => expect(cache.getCellSnapshot('light')).toEqual({error: 'missing is not defined', pending: false, version: 0}));
  });
});

describe('async evaluator seam', () => {
  it('preserves document-order chaining through an asynchronous backend', async () => {
    const doc = createDoc([
      {id: 'input', type: 'number', props: {name: 'x', value: 3}},
      {id: 'double', type: 'code', text: 'x * 2', props: {live: true, name: 'double'}},
      {id: 'total', type: 'formula', props: {name: 'total', source: 'double + x'}},
    ]);
    const delayed: EvalBackend = {
      async evaluate(request) {
        await Promise.resolve();
        return quickJSEvalBackend.evaluate(request);
      },
    };
    const computed = await evaluateScopeProgram(captureScopeProgram(doc), delayed);
    expect(computed.scope).toMatchObject({x: 3, double: 6, total: 9});
    expect(computed.results.get('total')).toEqual({value: 9});
  });
});
