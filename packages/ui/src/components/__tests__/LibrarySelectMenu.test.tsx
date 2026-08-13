import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, createEvent, fireEvent, render, screen} from '@testing-library/react';
import LibrarySelectMenu from '../LibrarySelectMenu';

const library = {id: 'local', name: 'My Library', serverUrl: null, icon: '📚'};
const remoteLibrary = {id: 'remote', name: 'Remote Library', serverUrl: 'https://example.com', icon: '🌐'};
const removeLibrary = vi.fn();

vi.mock('@/providers', () => ({
  useLibrary: () => ({
    libraries: [library, remoteLibrary],
    library,
    selectLibrary: vi.fn(),
    addLibrary: vi.fn(),
    removeLibrary,
  }),
  useHud: () => ({setHud: vi.fn()}),
  useTranslation: () => ({
    t: (key: string, values?: {name?: string}) =>
      ({
        'library.libraries': 'Libraries',
        'library.connectAction': 'Connect to a library…',
        'library.manage': 'Manage libraries',
        'library.removeLibrary': `Remove ${values?.name ?? 'library'}`,
      })[key] ?? key,
  }),
  useOptionalAccount: () => null,
  usePlatformCapabilities: () => ({}),
  isSafeServerUrl: () => true,
  libraryHostLabel: () => 'This device',
}));

vi.mock('../LibraryStatusDot', () => ({LibraryStatusDot: () => null}));

afterEach(() => {
  cleanup();
  removeLibrary.mockClear();
});

describe('LibrarySelectMenu titlebar trigger', () => {
  it('opens the existing switcher dropdown on right-click', () => {
    render(<LibrarySelectMenu variant="titlebar" />);
    const trigger = screen.getByRole('button', {name: /My Library/});
    const event = createEvent.contextMenu(trigger);

    fireEvent(trigger, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText('Libraries')).toBeTruthy();
    expect(screen.getByText('Manage libraries')).toBeTruthy();
  });

  it('removes the focused row with Delete and reveals its reserved action on row focus', () => {
    render(<LibrarySelectMenu variant="titlebar" />);
    fireEvent.contextMenu(screen.getByRole('button', {name: /My Library/}));

    const remove = screen.getByRole('button', {name: 'Remove Remote Library'});
    const row = remove.closest('[role="menuitem"]') as HTMLElement;
    const reservation = remove.parentElement as HTMLElement;
    for (const className of [
      'flex',
      'absolute',
      'inset-0',
      'border',
      'border-transparent',
      'opacity-0',
      'pointer-events-none',
      'group-hover:opacity-100',
      'group-hover:pointer-events-auto',
      'group-focus-within:opacity-100',
      'group-focus-within:pointer-events-auto',
    ]) {
      expect(remove.classList.contains(className)).toBe(true);
    }
    for (const className of ['relative', 'h-6', 'w-6', 'shrink-0']) {
      expect(reservation.classList.contains(className)).toBe(true);
    }
    expect(row.classList.contains('group')).toBe(true);
    expect(remove.classList.contains('hidden')).toBe(false);
    expect(remove.classList.contains('group-hover:flex')).toBe(false);

    row.focus();
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, {key: 'Delete'});
    expect(removeLibrary).toHaveBeenCalledWith(remoteLibrary.id);
  });
});
