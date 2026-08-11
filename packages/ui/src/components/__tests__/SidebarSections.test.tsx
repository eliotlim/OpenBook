import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {SidebarSection} from '@/components/SidebarSections';

afterEach(cleanup);

describe('sidebar section header context menu', () => {
  it('suppresses native context-menu fallthrough and keeps the collapse action', () => {
    render(
      <SidebarSection id="favorites" label="Favorites">
        <div>Favorite rows</div>
      </SidebarSection>,
    );

    const header = screen.getByRole('button', {name: 'Favorites'});
    expect(fireEvent.contextMenu(header)).toBe(false);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Favorite rows')).toBeNull();
  });
});
