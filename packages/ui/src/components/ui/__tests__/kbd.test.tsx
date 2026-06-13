import {describe, it, expect, afterEach} from 'vitest';
import {render, screen, cleanup, fireEvent, act} from '@testing-library/react';
import {Kbd} from '../kbd';
import {SHORTCUTS} from '@/lib/shortcuts';

afterEach(() => cleanup());

/**
 * Items 6/7: a shortcut hint stays quiet at rest and only reveals while ⌘/Ctrl
 * is held — so the sidebar isn't cluttered with key caps. The badge keeps its
 * space (opacity, not display) so revealing it never shifts the layout.
 */
describe('Kbd modifier reveal', () => {
  it('renders the shortcut but hidden until the modifier is held', () => {
    render(<Kbd combo={SHORTCUTS.commandPalette} />);
    const kbd = screen.getByText('Ctrl+K'); // SSR-safe default = Ctrl style
    expect(kbd.className).toContain('opacity-0');

    act(() => {
      fireEvent.keyDown(window, {key: 'Control'});
    });
    expect(kbd.className).toContain('opacity-100');

    act(() => {
      fireEvent.keyUp(window, {key: 'Control'});
    });
    expect(kbd.className).toContain('opacity-0');
  });
});
