import {describe, expect, it, vi} from 'vitest';
import {readSafeExpression} from '../safeExpressionRuntime.js';

const cells = new Map<string, unknown>([
  ['price', 12],
  ['quantity', 4],
  ['enabled', true],
  ['tags', ['security', 'export', 'offline']],
  ['series', {Projected: [10, 25, 44]}],
]);
const get = (id: string): unknown => cells.get(id);

describe('standalone safe-expression grammar', () => {
  it('covers tokenized arithmetic, comparisons, booleans, ternaries and Math helpers', () => {
    expect(readSafeExpression('__C__{price}__ * __C__{quantity}__ + Math.max(2, 5)', get)).toEqual({ok: true, value: 53});
    expect(readSafeExpression('__C__{enabled}__ && __C__{price}__ >= 10 ? Math.round(4.6) : 0', get)).toEqual({ok: true, value: 5});
    expect(readSafeExpression('get("price") ** 2', get)).toEqual({ok: true, value: 144});
  });

  it('covers arrays, plain objects, safe member reads and expression-bodied array helpers', () => {
    expect(readSafeExpression('[1, __C__{quantity}__, 7].map((n, i) => n + i).filter(n => n > 3)', get)).toEqual({ok: true, value: [5, 9]});
    expect(readSafeExpression('__C__{tags}__.map(tag => tag.length).reduce((sum, n) => sum + n, 0)', get)).toEqual({ok: true, value: 21});
    expect(readSafeExpression('__C__{series}__.Projected[__C__{series}__.Projected.length - 1]', get)).toEqual({ok: true, value: 44});
    expect(readSafeExpression('({Apples: 3, "Red pears": 5})', get)).toEqual({ok: true, value: {Apples: 3, 'Red pears': 5}});
  });

  it('supports the expression-only compound-series form used by exported sample charts', () => {
    const result = readSafeExpression(
      'return {low: Array.from({length: quantity}, (_, i) => Math.pow(1.03, i / 12)), high: Array.from({length: quantity}, (_, i) => Math.pow(1.10, i / 12))};'
        .replace(/quantity/g, '__C__{quantity}__'),
      get,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as {low: number[]; high: number[]};
    expect(value.low).toHaveLength(4);
    expect(value.high[3]).toBeCloseTo(Math.pow(1.1, 3 / 12));
  });

  it('fails closed on statements, ambient globals, constructors and prototype access', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      for (const source of [
        'fetch("https://attacker.invalid")',
        'window.__TAURI_INTERNALS__',
        'globalThis.process',
        '({}).constructor.constructor("return 1")()',
        'const x = 1; return x',
        'for (;;) {}',
        'new Date()',
        '<script>window.pwned=1</script>',
      ]) {
        expect(readSafeExpression(source, get), source).toEqual({ok: false});
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds generated collections and source complexity', () => {
    expect(readSafeExpression('Array.from({length: 10001}, (_, i) => i)', get)).toEqual({ok: false});
    expect(readSafeExpression('1+'.repeat(5_000) + '1', get)).toEqual({ok: false});
  });
});
