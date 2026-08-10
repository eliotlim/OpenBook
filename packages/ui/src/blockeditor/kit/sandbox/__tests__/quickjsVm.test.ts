import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {QuickJSEvaluator, UNSUPPORTED_RESULT_ERROR} from '../quickjsVm';

describe('resident QuickJS sandbox', () => {
  let vm: QuickJSEvaluator;

  beforeAll(async () => {
    vm = await QuickJSEvaluator.create();
  });

  afterAll(() => vm.dispose());

  it('marshals supported inputs and results without leaking unreferenced scope', async () => {
    const result = await vm.evaluate({
      kind: 'expression',
      source: '({sum: series.reduce((sum, point) => sum + point, 0), place, labels})',
      scope: {
        series: [1, 2, 3.5],
        place: {lat: 1.3521, lng: 103.8198, label: 'Singapore'},
        labels: ['a', 'b'],
        ignoredHostFunction: () => 99,
      },
    });
    expect(result).toEqual({
      value: {
        sum: 6.5,
        place: {lat: 1.3521, lng: 103.8198, label: 'Singapore'},
        labels: ['a', 'b'],
      },
    });
  });

  it('supports explicit scope access for names that are JavaScript keywords', async () => {
    await expect(vm.evaluate({kind: 'expression', source: 'scope.class + 1', scope: {class: 4}}))
      .resolves.toEqual({value: 5});
  });

  it('compiles a source once and invokes the cached function with changing scopes', async () => {
    const before = vm.compiledSourceCount;
    await expect(vm.evaluate({kind: 'expression', source: 'cacheInput * 2', scope: {cacheInput: 3}}))
      .resolves.toEqual({value: 6});
    await expect(vm.evaluate({kind: 'expression', source: 'cacheInput * 2', scope: {cacheInput: 8}}))
      .resolves.toEqual({value: 16});
    expect(vm.compiledSourceCount - before).toBe(1);
    expect(vm.cachedSourceCount).toBeGreaterThan(0);
  });

  it.each([
    ['function', '(() => 1)'],
    ['symbol', 'Symbol("nope")'],
    ['cyclic object', '(() => { const value = {}; value.self = value; return value; })()'],
    ['non-plain object', 'new Date(0)'],
  ])('returns a defined error for a non-cloneable %s result', async (_label, source) => {
    const result = await vm.evaluate({kind: 'expression', source, scope: {}});
    expect(result.error).toContain(UNSUPPORTED_RESULT_ERROR);
  });

  it('interrupts runaway code and keeps the resident evaluator usable', async () => {
    const started = performance.now();
    const runaway = await vm.evaluate({kind: 'code', source: 'while (true) {}', scope: {}});
    const elapsedMs = performance.now() - started;
    expect(runaway.error).toMatch(/timed out/i);
    expect(elapsedMs).toBeLessThan(1_000);
    await expect(vm.evaluate({kind: 'expression', source: '6 * 7', scope: {}}))
      .resolves.toEqual({value: 42});
  });

  it('enforces the runtime memory cap and recovers for the next evaluation', async () => {
    const exhausted = await vm.evaluate({
      kind: 'code',
      source: 'const values = []; while (true) values.push("x".repeat(4096));',
      scope: {},
    });
    expect(exhausted.error).toMatch(/memory limit|timed out/i);
    await expect(vm.evaluate({kind: 'expression', source: '20 + 22', scope: {}}))
      .resolves.toEqual({value: 42});
  });

  it("SECURITY: closes Sasha's __TAURI_INTERNALS__ zero-click IPC exploit", async () => {
    const invoke = vi.fn();
    const host = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {invoke: typeof invoke};
    };
    host.__TAURI_INTERNALS__ = {invoke};
    try {
      const result = await vm.evaluate({
        kind: 'expression',
        source: "globalThis.__TAURI_INTERNALS__?.invoke?.('api_request', {path: '/keychain'})",
        scope: {},
      });
      expect(result).toEqual({value: undefined});
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      delete host.__TAURI_INTERNALS__;
    }
  });

  it('does not expose browser, network, storage, CommonJS, or Node host capabilities', async () => {
    const result = await vm.evaluate({
      kind: 'expression',
      source: `({
        fetch: typeof fetch,
        xhr: typeof XMLHttpRequest,
        webSocket: typeof WebSocket,
        localStorage: typeof localStorage,
        indexedDB: typeof indexedDB,
        require: typeof require,
        process: typeof process,
        window: typeof window,
        document: typeof document
      })`,
      scope: {},
    });
    expect(result).toEqual({value: {
      fetch: 'undefined',
      xhr: 'undefined',
      webSocket: 'undefined',
      localStorage: 'undefined',
      indexedDB: 'undefined',
      require: 'undefined',
      process: 'undefined',
      window: 'undefined',
      document: 'undefined',
    }});

    const dynamicImport = await vm.evaluate({kind: 'expression', source: 'import("host-module")', scope: {}});
    expect(dynamicImport.error).toBeTruthy();
  });
});
