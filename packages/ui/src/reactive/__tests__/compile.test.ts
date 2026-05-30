import {describe, it, expect, beforeEach} from 'vitest';
import {effect} from '@preact/signals-core';
import {compile, extractCellIds} from '../compile';
import {ReactiveStore} from '../ReactiveStore';

describe('extractCellIds', () => {
  it('returns empty array for source with no tokens', () => {
    expect(extractCellIds('1 + 2')).toEqual([]);
  });

  it('extracts a single cellId from a __C__{...}__ token', () => {
    expect(extractCellIds('__C__{cell_abc}__ * 2')).toEqual(['cell_abc']);
  });

  it('extracts multiple cellIds and deduplicates, preserving first-seen order', () => {
    const ids = extractCellIds('__C__{cell_a}__ + __C__{cell_b}__ + __C__{cell_a}__');
    expect(ids).toEqual(['cell_a', 'cell_b']);
  });

  it('handles cellIds containing hyphens (EditorJS block.id format)', () => {
    const ids = extractCellIds('__C__{mKTU-N2aPX}__ + __C__{kza1-ObuzIY}__');
    expect(ids).toEqual(['mKTU-N2aPX', 'kza1-ObuzIY']);
  });

  it('does not match tokens missing braces (legacy format is no longer valid)', () => {
    expect(extractCellIds('__C__cell_abc')).toEqual([]);
  });
});

describe('compile', () => {
  let store: ReactiveStore;

  beforeEach(() => {
    store = new ReactiveStore();
  });

  it('empty source compiles to a function returning undefined', () => {
    const fn = compile('');
    expect(fn(store)).toBeUndefined();
  });

  it('scalar expression returns a sync value (awaitable via Promise.resolve)', async () => {
    const fn = compile('2 + 2');
    const result = await Promise.resolve(fn(store));
    expect(result).toBe(4);
  });

  it('source with one cellId token resolves via the store', async () => {
    store.setByCellId('cell_x', 10);
    const fn = compile('__C__{cell_x}__ * 3');
    const result = await Promise.resolve(fn(store));
    expect(result).toBe(30);
  });

  it('source with hyphenated cellId resolves correctly (the EditorJS bug)', async () => {
    // Verbatim case from the bug report: an EditorJS block.id like
    // mKTU-N2aPX must round-trip through compile without breaking JS
    // identifier rules. The compiler rewrites the token to a safe alias.
    store.setByCellId('mKTU-N2aPX', 42);
    const fn = compile('__C__{mKTU-N2aPX}__ + 1');
    const result = await Promise.resolve(fn(store));
    expect(result).toBe(43);
  });

  it('source with multiple cellId tokens resolves all of them', async () => {
    store.setByCellId('cell_a', 4);
    store.setByCellId('cell_b', 5);
    const fn = compile('__C__{cell_a}__ + __C__{cell_b}__');
    const result = await Promise.resolve(fn(store));
    expect(result).toBe(9);
  });

  it('JS syntax error throws at compile time', () => {
    expect(() => compile('2 +')).toThrow();
  });

  it('compiled function inside effect() auto-subscribes via store.getByCellId', () => {
    store.setByCellId('cell_n', 1);
    const fn = compile('__C__{cell_n}__ * 10');
    let observed: unknown;
    const dispose = effect(() => {
      observed = fn(store);
    });
    expect(observed).toBe(10);
    store.setByCellId('cell_n', 5);
    expect(observed).toBe(50);
    dispose();
  });

  it('chained reactivity: B reads A, both subscribe correctly', () => {
    // Models the user's "expr B references expr A" use case.
    store.setByCellId('cell-A', 3);  // upstream "expression" value
    const compiledB = compile('__C__{cell-A}__ * 2');
    let bValue: unknown;
    const disposeB = effect(() => {
      bValue = compiledB(store);
      store.setByCellId('cell-B', bValue);
    });
    expect(bValue).toBe(6);
    expect(store.getByCellId('cell-B')).toBe(6);

    const compiledC = compile('__C__{cell-B}__ + 1');
    let cValue: unknown;
    const disposeC = effect(() => {
      cValue = compiledC(store);
    });
    expect(cValue).toBe(7);

    // Upstream change propagates through both.
    store.setByCellId('cell-A', 10);
    expect(bValue).toBe(20);
    expect(store.getByCellId('cell-B')).toBe(20);
    expect(cValue).toBe(21);
    disposeB();
    disposeC();
  });
});
