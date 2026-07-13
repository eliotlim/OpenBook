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
  it('a kind rendered with only {value, labels, palette} produces no interaction wrappers', () => {
    // The static-export / provider-less / test path: Mark is an inert passthrough
    // so the SVG has no `.obe-chart-mark` wrappers — byte-identical body.
    const args: ChartRenderArgs = {value: [3, 1, 4], labels: ['A', 'B', 'C'], palette: PALETTE};
    const {container} = render(<svg>{getChartKind('bar')!.render(args)}</svg>);
    expect(container.querySelector('.obe-chart-mark')).toBeNull();
    // The bars themselves still draw.
    expect(container.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);
  });
});
