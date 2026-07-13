import {describe, it, expect, afterEach, beforeAll} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {createDoc, rootBlocks, type BlockMap} from '../../model';
import type {BlockEditorController} from '../../useBlockEditor';
import {CHART_BLOCKS, getChartKind, fmtChartValue, type ChartRenderArgs} from '../charts';
import {PALETTE} from '../chartMath';

// The chart block that renders any kind (derived from the registry — one entry).
const ChartBlock = CHART_BLOCKS[0].render;

beforeAll(() => {
  // Radix DropdownMenu (Popper + focus management) needs browser APIs happy-dom
  // lacks. Same shim the Select tests use, plus the menu's focus/scroll calls.
  const g = globalThis as unknown as Record<string, unknown>;
  if (!('ResizeObserver' in globalThis)) {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

afterEach(() => cleanup());

/** Render the chart block for a given kind + data with a minimal editor stub. */
function renderChart(props: Record<string, unknown>, opts: {readOnly?: boolean} = {}) {
  const doc = createDoc([{id: 'c', type: 'kitchart', props}]);
  const block: BlockMap = rootBlocks(doc).get(0);
  const editor = {doc, readOnly: opts.readOnly ?? false} as unknown as BlockEditorController;
  const utils = render(<ChartBlock block={block} editor={editor} />);
  return {...utils, doc, block};
}

const marks = (container: HTMLElement): HTMLElement[] => Array.from(container.querySelectorAll('.obe-chart-mark'));

// Each kind with data that produces ≥2 marks, and the label/value we expect on
// the first mark's aria-label + tooltip.
const KINDS: Array<{kind: string; props: Record<string, unknown>; firstLabel: string; firstValue: string}> = [
  {kind: 'line', props: {source: '[3, 1, 4]', labels: 'A, B, C'}, firstLabel: 'A', firstValue: '3'},
  {kind: 'area', props: {source: '[3, 1, 4]', labels: 'A, B, C'}, firstLabel: 'A', firstValue: '3'},
  {kind: 'bar', props: {source: '[3, 1, 4]', labels: 'A, B, C'}, firstLabel: 'A', firstValue: '3'},
  {kind: 'pie', props: {source: '{Apples: 3, Pears: 5}'}, firstLabel: 'Apples', firstValue: '3'},
  {kind: 'donut', props: {source: '{Apples: 3, Pears: 5}'}, firstLabel: 'Apples', firstValue: '3'},
  {kind: 'scatter', props: {source: '[{x: 1, y: 2}, {x: 3, y: 4}]'}, firstLabel: '(1, 2)', firstValue: '2'},
  {kind: 'funnel', props: {source: '[10, 6, 3]', labels: 'Visit, Signup, Pay'}, firstLabel: 'Visit', firstValue: '10'},
  {kind: 'heatmap', props: {source: '{a: [1, 2], b: [3, 4]}', labels: 'X, Y'}, firstLabel: 'a · X', firstValue: '1'},
  {kind: 'combo', props: {source: '{Sales: [3, 1, 4], Trend: [2, 2, 2]}', labels: 'A, B, C'}, firstLabel: 'Sales · A', firstValue: '3'},
];

describe('fmtChartValue', () => {
  it('groups integers and trims floats to two places', () => {
    expect(fmtChartValue(1234)).toBe((1234).toLocaleString());
    expect(fmtChartValue(3.14159)).toBe((3.14).toLocaleString(undefined, {maximumFractionDigits: 2}));
  });
});

describe('interactive marks — every registered kind', () => {
  for (const {kind, props, firstLabel, firstValue} of KINDS) {
    it(`${kind}: renders focusable data marks labelled with label + value`, () => {
      const {container} = renderChart({kind, ...props});
      const found = marks(container);
      expect(found.length).toBeGreaterThanOrEqual(2);
      // Keyboard-accessible: focusable + a descriptive aria-label.
      for (const m of found) expect(m.getAttribute('tabindex')).toBe('0');
      expect(found[0].getAttribute('aria-label')).toBe(`${firstLabel}: ${firstValue}`);
      expect(found[0].getAttribute('aria-haspopup')).toBe('menu');
    });

    it(`${kind}: focus shows a tooltip and highlights that mark, dimming the rest`, () => {
      const {container} = renderChart({kind, ...props});
      const found = marks(container);
      fireEvent.focus(found[0]);
      // Tooltip carries the same label + value.
      const tip = container.querySelector('.obe-chart-tooltip')!;
      expect(tip).toBeTruthy();
      expect(tip.textContent).toContain(firstLabel);
      expect(tip.textContent).toContain(firstValue);
      // Highlight is shared scaffold: active mark emphasised, others de-emphasised.
      const after = marks(container);
      expect(after[0].classList.contains('is-active')).toBe(true);
      expect(after[1].classList.contains('is-dim')).toBe(true);
      // Blur clears it.
      fireEvent.blur(found[0]);
      expect(container.querySelector('.obe-chart-tooltip')).toBeNull();
    });
  }
});

describe('KPI / number tile', () => {
  it('reduces a scalar to one focusable figure mark', () => {
    const {container} = renderChart({kind: 'kpi', source: '42', labels: 'Revenue'});
    const found = marks(container);
    expect(found.length).toBe(1);
    expect(found[0].getAttribute('aria-label')).toBe('Revenue: 42');
    expect(container.querySelector('.obe-chart-kpi-value')?.textContent).toBe('42');
    expect(container.querySelector('.obe-chart-kpi-caption')?.textContent).toBe('Revenue');
  });

  it('sums a series and shows no progress bar without a target', () => {
    const {container} = renderChart({kind: 'kpi', source: '[10, 20, 30]'});
    expect(container.querySelector('.obe-chart-kpi-value')?.textContent).toBe('60');
    expect(container.querySelector('.obe-chart-kpi-track')).toBeNull();
  });

  it('renders a target readout + progress bar from a {value, target} object', () => {
    const {container} = renderChart({kind: 'kpi', source: '{value: 82, target: 100}'});
    expect(container.querySelector('.obe-chart-kpi-value')?.textContent).toBe('82');
    expect(container.querySelector('.obe-chart-kpi-sub')?.textContent).toBe('82% of 100');
    expect(container.querySelector('.obe-chart-kpi-track')).toBeTruthy();
  });

  it('shows the placeholder when there is nothing numeric to reduce', () => {
    const {container} = renderChart({kind: 'kpi', source: '{}'});
    expect(container.querySelector('.obe-chart-kpi-value')).toBeNull();
    expect(container.querySelector('.obe-chart-msg')).toBeTruthy();
  });
});

describe('context menu', () => {
  it('opens on keyboard (Enter) with Copy value + Change chart kind', () => {
    const {container} = renderChart({kind: 'bar', source: '[3, 1, 4]', labels: 'A, B, C'});
    fireEvent.keyDown(marks(container)[0], {key: 'Enter'});
    expect(screen.getByText('Copy value')).toBeTruthy();
    expect(screen.getByText('Change chart kind')).toBeTruthy();
  });

  it('opens on right-click too', () => {
    const {container} = renderChart({kind: 'pie', source: '{Apples: 3, Pears: 5}'});
    fireEvent.contextMenu(marks(container)[0]);
    expect(screen.getByText('Copy value')).toBeTruthy();
  });

  it('hides Change chart kind when the chart is read-only (Copy value stays)', () => {
    const {container} = renderChart({kind: 'bar', source: '[3, 1, 4]', labels: 'A, B, C'}, {readOnly: true});
    fireEvent.keyDown(marks(container)[0], {key: 'Enter'});
    expect(screen.getByText('Copy value')).toBeTruthy();
    expect(screen.queryByText('Change chart kind')).toBeNull();
  });

  it('Copy value writes "label: value" to the clipboard', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: (t: string) => ((copied = t), Promise.resolve())},
    });
    const {container} = renderChart({kind: 'bar', source: '[3, 1, 4]', labels: 'A, B, C'});
    fireEvent.keyDown(marks(container)[0], {key: 'Enter'});
    fireEvent.click(screen.getByText('Copy value'));
    expect(copied).toBe('A: 3');
  });
});

describe('additive render contract — no interactions', () => {
  // The static-export / provider-less / test path: `<Mark>` is an inert
  // passthrough, so the invariant is that NO `.obe-chart-mark` interaction
  // wrappers are emitted. The kinds still draw their data elements — including,
  // for line/area, the per-point `.obe-chart-dot` hit circles, which always ship
  // but are invisible (`.obe-chart-dot { fill-opacity: 0 }`); they add no visual
  // change, so this path stays byte-equivalent in appearance.
  it('bar: no interaction wrappers, bars still draw', () => {
    const args: ChartRenderArgs = {value: [3, 1, 4], labels: ['A', 'B', 'C'], palette: PALETTE};
    const {container} = render(<svg>{getChartKind('bar')!.render(args)}</svg>);
    expect(container.querySelectorAll('.obe-chart-mark').length).toBe(0);
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);
  });

  for (const kind of ['line', 'area'] as const) {
    it(`${kind}: no interaction wrappers even though invisible hit dots ship`, () => {
      const args: ChartRenderArgs = {value: [3, 1, 4], labels: ['A', 'B', 'C'], palette: PALETTE};
      const {container} = render(<svg>{getChartKind(kind)!.render(args)}</svg>);
      // The true invariant: zero interaction wrappers in the no-context path…
      expect(container.querySelectorAll('.obe-chart-mark').length).toBe(0);
      // …while the always-shipped (invisible) point dots are still present.
      expect(container.querySelectorAll('.obe-chart-dot').length).toBe(3);
    });
  }

  it('heatmap: no interaction wrappers, cells still draw', () => {
    const args: ChartRenderArgs = {value: {a: [1, 2], b: [3, 4]}, labels: ['X', 'Y'], palette: PALETTE};
    const {container} = render(<svg>{getChartKind('heatmap')!.render(args)}</svg>);
    expect(container.querySelectorAll('.obe-chart-mark').length).toBe(0);
    // 4 cell rects, each with a fill-opacity intensity.
    expect(container.querySelectorAll('rect[fill-opacity]').length).toBe(4);
  });

  it('combo: no interaction wrappers, bars + line still draw', () => {
    const args: ChartRenderArgs = {value: {Sales: [3, 1, 4], Trend: [2, 2, 2]}, labels: ['A', 'B', 'C'], palette: PALETTE};
    const {container} = render(<svg>{getChartKind('combo')!.render(args)}</svg>);
    expect(container.querySelectorAll('.obe-chart-mark').length).toBe(0);
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3); // bars
    expect(container.querySelectorAll('polyline').length).toBe(1); // the trend line
  });

  it('kpi: no interaction wrapper, the figure still renders', () => {
    const args: ChartRenderArgs = {value: {value: 82, target: 100}, labels: ['Revenue'], palette: PALETTE};
    const {container} = render(<svg>{getChartKind('kpi')!.render(args)}</svg>);
    expect(container.querySelectorAll('.obe-chart-mark').length).toBe(0);
    expect(container.querySelector('.obe-chart-kpi-value')?.textContent).toBe('82');
  });
});
