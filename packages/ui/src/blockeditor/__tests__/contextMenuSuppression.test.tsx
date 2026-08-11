import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {BlockEditor} from '../BlockEditor';
import {createDoc} from '../model';

afterEach(() => cleanup());

describe('block gutter context menus', () => {
  it('routes a grip right-click to the row menu while suppressing the native menu', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Text'}]}]);
    render(<BlockEditor doc={doc} />);
    const grip = screen.getByLabelText('Drag to move, click for actions');

    // false means the cancelable contextmenu event was default-prevented.
    expect(fireEvent.contextMenu(grip)).toBe(false);
    expect(screen.getByRole('menuitem', {name: /Delete/})).toBeTruthy();
    // The original event's bubbling is skipped via defaultPrevented; only the
    // synthetic event opens the row context menu.
    expect(grip.getAttribute('aria-expanded')).toBe('false');
  });

  it('suppresses the add-button native menu and still routes to the row menu', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Text'}]}]);
    render(<BlockEditor doc={doc} />);

    expect(fireEvent.contextMenu(screen.getByLabelText('Add a block below'))).toBe(false);
    expect(screen.getByRole('menuitem', {name: /Delete/})).toBeTruthy();
  });
});
