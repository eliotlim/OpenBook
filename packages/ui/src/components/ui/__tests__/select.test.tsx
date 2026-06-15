import {describe, it, expect, afterEach, beforeAll} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {useState} from 'react';
import {Select} from '../select';

beforeAll(() => {
  // Radix Popover (popper) needs ResizeObserver, which happy-dom lacks.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as {ResizeObserver: unknown}).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function Harness({initial = 'a'}: {initial?: string}) {
  const [v, setV] = useState(initial);
  return (
    <>
      <Select value={v} aria-label="Fruit" onChange={(e) => setV(e.target.value)}>
        <option value="a">Apple</option>
        <option value="b">Banana</option>
        <option value="c" disabled>
          Cherry
        </option>
      </Select>
      <span data-testid="val">{v}</span>
    </>
  );
}

describe('Select', () => {
  afterEach(() => cleanup());

  it('renders as a combobox showing the selected option label', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox', {name: 'Fruit'});
    expect(trigger.textContent).toContain('Apple');
  });

  it('opens to a listbox of the option children and marks the selected one', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', {name: 'Fruit'}));
    expect(screen.getByRole('option', {name: 'Apple'}).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', {name: 'Banana'}).getAttribute('aria-selected')).toBe('false');
    // A disabled option is exposed as such.
    expect(screen.getByRole('option', {name: 'Cherry'}).getAttribute('aria-disabled')).toBe('true');
  });

  it('picking an option fires onChange with the value and updates the trigger', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox', {name: 'Fruit'}));
    fireEvent.click(screen.getByRole('option', {name: 'Banana'}));
    expect(screen.getByTestId('val').textContent).toBe('b');
    expect(screen.getByRole('combobox', {name: 'Fruit'}).textContent).toContain('Banana');
  });
});
