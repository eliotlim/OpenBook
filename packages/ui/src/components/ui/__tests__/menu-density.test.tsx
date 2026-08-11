import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {MenuDensityProvider, type MenuDensity} from '@/components/ui/menu-components';

afterEach(() => cleanup());

function MenuHarness({family, density}: {family: 'context' | 'dropdown'; density: MenuDensity}) {
  if (family === 'context') {
    return (
      <MenuDensityProvider density={density}>
        <ContextMenu>
          <ContextMenuTrigger>Context trigger</ContextMenuTrigger>
          <ContextMenuContent data-testid="content">
            <ContextMenuItem>Context action</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </MenuDensityProvider>
    );
  }

  return (
    <MenuDensityProvider density={density}>
      <DropdownMenu open>
        <DropdownMenuTrigger>Dropdown trigger</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="content">
          <DropdownMenuItem>Dropdown action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </MenuDensityProvider>
  );
}

describe.each(['context', 'dropdown'] as const)('%s menu density', (family) => {
  it('uses comfortable container and item classes', () => {
    render(<MenuHarness family={family} density="comfortable" />);
    if (family === 'context') fireEvent.contextMenu(screen.getByText('Context trigger'));

    expect(screen.getByTestId('content').className.split(/\s+/)).toContain('p-1');
    const itemClasses = screen.getByRole('menuitem').className.split(/\s+/);
    expect(itemClasses).toContain('py-1.5');
    expect(itemClasses).toContain('text-sm');
  });

  it('uses compact container and item classes', () => {
    render(<MenuHarness family={family} density="compact" />);
    if (family === 'context') fireEvent.contextMenu(screen.getByText('Context trigger'));

    expect(screen.getByTestId('content').className.split(/\s+/)).toContain('p-0.5');
    const itemClasses = screen.getByRole('menuitem').className.split(/\s+/);
    expect(itemClasses).toContain('py-1');
    expect(itemClasses).toContain('text-xs');
  });
});
