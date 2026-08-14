import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {SummaryPicker} from '../databaseMenus';

beforeAll(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (!('ResizeObserver' in globalThis)) {
    globals.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  element.hasPointerCapture ??= () => false;
  element.releasePointerCapture ??= () => {};
  element.setPointerCapture ??= () => {};
  element.scrollIntoView ??= () => {};
});

afterEach(cleanup);

describe('SummaryPicker', () => {
  it('exposes the current summary as a metric-stable radio selection', async () => {
    const onChange = vi.fn();
    render(<SummaryPicker current="count_all" display="3" onChange={onChange} />);

    fireEvent.pointerDown(screen.getByRole('button'), {button: 0, ctrlKey: false});

    const items = await screen.findAllByRole('menuitemradio');
    expect(items).toHaveLength(14);
    expect(items.every((item) => item.classList.contains('pl-8'))).toBe(true);
    expect(screen.getByRole('menuitemradio', {name: 'Count all'}).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', {name: 'Sum'}).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('menuitemradio', {name: 'Sum'}));
    expect(onChange).toHaveBeenCalledWith('sum');
  });
});
