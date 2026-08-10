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
    expect(readSafeExpression('group.count.value + offset', get, {group: {count: {value: 4}}, offset: 2})).toEqual({ok: true, value: 6});
  });

  it('matches JavaScript for absent own properties and out-of-bounds indexes', () => {
    const config: {color?: string} = {};
    const items = [1, 2];

    expect(readSafeExpression('config.color || "blue"', get, {config})).toEqual({ok: true, value: config.color || 'blue'});
    expect(readSafeExpression('config.color ?? "blue"', get, {config})).toEqual({ok: true, value: config.color ?? 'blue'});
    expect(readSafeExpression('items[99]', get, {items})).toEqual({ok: true, value: items[99]});
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

  it('covers the bounded local statement shell used by bundled live-code pages', () => {
    const cheapest = readSafeExpression(
      'const m = {Aldi: aldi, Tesco: tesco, Ocado: ocado}; return Object.keys(m).sort((a, b) => m[a] - m[b])[0];',
      get,
      {aldi: 86, tesco: 99, ocado: 112},
    );
    expect(cheapest).toEqual({ok: true, value: 'Aldi'});

    const projection = readSafeExpression(
      'const r = rate / 100; let bal = initial; const Invested = [Math.round(initial)], Projected = [Math.round(initial)]; ' +
        'for (let y = 1; y <= years; y++) { bal = (bal + monthly * 12) * (1 + r); Invested.push(Math.round(initial + monthly * 12 * y)); Projected.push(Math.round(bal)); } ' +
        'return {Invested, Projected};',
      get,
      {rate: 6, initial: 2_000, monthly: 300, years: 2},
    );
    expect(projection).toEqual({ok: true, value: {Invested: [2_000, 5_600, 9_200], Projected: [2_000, 5_936, 10_108]}});
  });

  it('rejects forged lambda markers before attacker-controlled locals are entered', () => {
    let attackerLocalsRead = false;
    const locals = Object.create(null);
    Object.defineProperty(locals, 'constructor', {
      get: () => {
        attackerLocalsRead = true;
        return Function;
      },
    });
    const forged = {
      kind: 'lambda',
      params: ['a'],
      locals,
      body: {type: 'identifier', name: 'constructor'},
    };
    const hostileGet = (id: string): unknown => id === 'forged' ? forged : get(id);

    expect(readSafeExpression('[1].map(get("forged"))', hostileGet)).toEqual({ok: false});
    expect(attackerLocalsRead).toBe(false);
  });

  it('omits function-valued own properties from Object enumeration helpers', () => {
    const method = vi.fn();
    const hostObj = {visible: 1, method};

    expect(readSafeExpression('Object.keys(hostObj)', get, {hostObj})).toEqual({ok: true, value: ['visible']});
    expect(readSafeExpression('Object.values(hostObj)', get, {hostObj})).toEqual({ok: true, value: [1]});
    expect(readSafeExpression('Object.entries(hostObj)', get, {hostObj})).toEqual({ok: true, value: [['visible', 1]]});
    expect(method).not.toHaveBeenCalled();
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
        'if (true) return 1',
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

  it('never mutates a bound array after a local is reassigned to it', () => {
    const external = [1];
    expect(readSafeExpression('let values = []; values = external; values.push(2); return values;', get, {external}))
      .toEqual({ok: false});
    expect(external).toEqual([1]);
  });

  it('bounds generated collections and source complexity', () => {
    expect(readSafeExpression('Array.from({length: 10001}, (_, i) => i)', get)).toEqual({ok: false});
    expect(readSafeExpression('1+'.repeat(5_000) + '1', get)).toEqual({ok: false});
  });
});
