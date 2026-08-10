import {beforeAll, describe, expect, it, vi} from 'vitest';
import {createDoc, type NewBlock} from '../../blockeditor/model';
import {
  computeExportCells,
  EXPORT_EVALUATION_BUDGET_MS,
} from '../../blockeditor/kit/scope';

describe('authoritative QuickJS export boundary', () => {
  beforeAll(async () => {
    // Keep the aggregate-budget assertion about formula execution, not the
    // one-time lazy WASM load it intentionally follows.
    await computeExportCells(createDoc([{
      id: 'warm',
      type: 'formula',
      props: {source: '1 + 1'},
    }]));
  });

  it('does not carry globals leaked by one document into the next export', async () => {
    const first = createDoc([{
      id: 'first',
      type: 'code',
      text: 'try { leaked = 41; } catch (_) {} try { globalThis.leaked = 42; } catch (_) {} return 7;',
      props: {live: true, name: 'first'},
    }]);
    expect((await computeExportCells(first)).get('first')).toEqual({value: 7});

    const second = createDoc([{
      id: 'second',
      type: 'formula',
      props: {source: 'typeof leaked + "/" + typeof globalThis.leaked'},
    }]);
    expect((await computeExportCells(second)).get('second'))
      .toEqual({value: 'undefined/undefined'});
  });

  it('bounds one export containing many runaway cells with a shared deadline', async () => {
    const blocks: NewBlock[] = Array.from({length: 24}, (_, index) => ({
      id: `runaway-${index}`,
      type: 'code',
      text: 'while (true) {}',
      props: {live: true, name: `runaway${index}`},
    }));
    const started = performance.now();
    const cells = await computeExportCells(createDoc(blocks));
    const elapsedMs = performance.now() - started;

    expect(cells.size).toBe(blocks.length);
    expect([...cells.values()].every((cell) => cell.value === undefined)).toBe(true);
    expect(elapsedMs).toBeLessThan(EXPORT_EVALUATION_BUDGET_MS + 350);
  });

  it('never lets an export formula call the host Tauri bridge', async () => {
    const invoke = vi.fn();
    const host = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {invoke: typeof invoke};
    };
    host.__TAURI_INTERNALS__ = {invoke};
    try {
      const doc = createDoc([{
        id: 'attack',
        type: 'formula',
        props: {source: 'globalThis.__TAURI_INTERNALS__.invoke("api_request", {path: "/keychain"})'},
      }]);
      expect((await computeExportCells(doc)).get('attack')).toEqual({value: undefined});
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      delete host.__TAURI_INTERNALS__;
    }
  });
});
