import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BlockEditor} from '../BlockEditor';
import {createDoc, findBlock, setBlockProp} from '../model';
import {registerReactiveBlocks} from '../reactiveBlocks';
import {registerArtifactKit} from '../kit';

registerReactiveBlocks();
registerArtifactKit();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('reactive scope memo', () => {
  it('compiles N formulas once per document version across N reactive renders', async () => {
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
    // First paint is explicitly pending; evaluation completes after render.
    expect([...view.container.querySelectorAll('.obe-formula-out')].map((node) => node.textContent)).toEqual(['—', '—', '—']);
    await waitFor(() => expect([...view.container.querySelectorAll('.obe-formula-out')].map((node) => node.textContent)).toEqual(['3', '6', '7']));
    expect(compile).toHaveBeenCalledTimes(3);

    // A parent render with an unchanged doc reuses the same version-keyed value.
    view.rerender(<BlockEditor doc={doc} />);
    expect(compile).toHaveBeenCalledTimes(3);

    // A doc update bumps the editor version: one new scope pass recompiles the
    // three formulas, even though all three FormulaBlock components render.
    const formula = findBlock(doc, 'f3')!.block;
    act(() => doc.transact(() => setBlockProp(formula, 'source', 'b + 2'), 'local'));
    await waitFor(() => expect([...view.container.querySelectorAll('.obe-formula-out')].map((node) => node.textContent)).toEqual(['3', '6', '8']));
    expect(compile).toHaveBeenCalledTimes(6);
  });

  it('keeps a chart reactive to slider updates through the shared scope', async () => {
    const doc = createDoc([
      {id: 'input', type: 'slider', props: {name: 'x', value: 2, min: 0, max: 10}},
      {id: 'chart', type: 'kitchart', props: {kind: 'kpi', source: 'x'}},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const chartValue = (): string | null => container.querySelector('.obe-chart-kpi-value')?.textContent ?? null;

    await waitFor(() => expect(chartValue()).toBe('2'));
    fireEvent.change(screen.getByRole('slider'), {target: {value: '7'}});
    await waitFor(() => expect(chartValue()).toBe('7'));
  });

  it('updates chained code, chart, status, and progress from one input version', async () => {
    const doc = createDoc([
      {id: 'input', type: 'slider', props: {name: 'x', value: 2, min: 0, max: 10}},
      {id: 'code', type: 'code', text: 'x * 2', props: {live: true, name: 'double'}},
      {id: 'formula', type: 'formula', props: {name: 'total', source: 'double + 1'}},
      {id: 'chart', type: 'kitchart', props: {kind: 'kpi', source: 'total'}},
      {id: 'status', type: 'statuslight', props: {source: 'total', okAt: 10, warnAt: 5}},
      {id: 'progress', type: 'progressbar', props: {source: 'total', max: 20}},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const chartValue = (): string | null => container.querySelector('.obe-chart-kpi-value')?.textContent ?? null;
    const status = (): string | null => container.querySelector('.obe-kit-status')?.getAttribute('data-status') ?? null;
    const progress = (): string | null => container.querySelector('.obe-kit-progress')?.getAttribute('data-progress') ?? null;

    await waitFor(() => {
      expect(chartValue()).toBe('5');
      expect(status()).toBe('warn');
      expect(progress()).toBe('25');
    });

    fireEvent.change(screen.getByRole('slider'), {target: {value: '7'}});
    await waitFor(() => {
      expect(chartValue()).toBe('15');
      expect(status()).toBe('ok');
      expect(progress()).toBe('75');
    });
  });
});
