import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BlockEditor} from '../BlockEditor';
import {createDoc, findBlock, setBlockProp} from '../model';
import {registerReactiveBlocks} from '../reactiveBlocks';
import {registerArtifactKit} from '../kit';
import * as scopeModule from '../kit/scope';

vi.mock('../kit/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kit/scope')>();
  return {...actual, computeScope: vi.fn(actual.computeScope)};
});

registerReactiveBlocks();
registerArtifactKit();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(scopeModule.computeScope).mockClear();
});

describe('reactive scope memo', () => {
  it('compiles N formulas once per document version across N reactive renders', () => {
    const NativeFunction = globalThis.Function;
    const compile = vi.spyOn(globalThis, 'Function').mockImplementation(function (...args: string[]) {
      return NativeFunction(...args);
    });
    const doc = createDoc([
      {id: 'input', type: 'slider', props: {name: 'x', value: 2}},
      {id: 'f1', type: 'formula', props: {name: 'a', source: 'x + 1'}},
      {id: 'f2', type: 'formula', props: {name: 'b', source: 'a * 2'}},
      {id: 'f3', type: 'formula', props: {source: 'b + 1'}},
    ]);

    const view = render(<BlockEditor doc={doc} />);
    expect(scopeModule.computeScope).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(3);
    expect([...view.container.querySelectorAll('.obe-formula-out')].map((node) => node.textContent)).toEqual(['3', '6', '7']);

    // A parent render with an unchanged doc reuses the same version-keyed value.
    view.rerender(<BlockEditor doc={doc} />);
    expect(scopeModule.computeScope).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(3);

    // A doc update bumps the editor version: one new scope pass recompiles the
    // three formulas, even though all three FormulaBlock components render.
    const formula = findBlock(doc, 'f3')!.block;
    act(() => doc.transact(() => setBlockProp(formula, 'source', 'b + 2'), 'local'));
    expect(scopeModule.computeScope).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenCalledTimes(6);
    expect([...view.container.querySelectorAll('.obe-formula-out')].map((node) => node.textContent)).toEqual(['3', '6', '8']);
  });

  it('keeps a chart reactive to slider updates through the shared scope', () => {
    const doc = createDoc([
      {id: 'input', type: 'slider', props: {name: 'x', value: 2, min: 0, max: 10}},
      {id: 'chart', type: 'kitchart', props: {kind: 'kpi', source: 'x'}},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const chartValue = (): string | null => container.querySelector('.obe-chart-kpi-value')?.textContent ?? null;

    expect(chartValue()).toBe('2');
    fireEvent.change(screen.getByRole('slider'), {target: {value: '7'}});
    expect(chartValue()).toBe('7');
  });
});
