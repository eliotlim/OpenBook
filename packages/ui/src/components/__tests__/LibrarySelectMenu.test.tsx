import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, createEvent, fireEvent, render, screen} from '@testing-library/react';
import LibrarySelectMenu from '../LibrarySelectMenu';

const library = {id: 'local', name: 'My Library', serverUrl: null, icon: '📚'};
const remoteLibrary = {id: 'remote', name: 'Remote Library', serverUrl: 'https://example.com', icon: '🌐'};

vi.mock('@/providers', () => ({
  useLibrary: () => ({
    libraries: [library, remoteLibrary],
    library,
    selectLibrary: vi.fn(),
    addLibrary: vi.fn(),
    removeLibrary: vi.fn(),
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

afterEach(cleanup);

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

  it('reserves the delete action and reveals it for hover or keyboard focus', () => {
    render(<LibrarySelectMenu variant="titlebar" />);
    fireEvent.contextMenu(screen.getByRole('button', {name: /My Library/}));

    const remove = screen.getByRole('button', {name: 'Remove Remote Library'});
    for (const className of [
      'flex',
      'h-6',
      'w-6',
      'opacity-0',
      'pointer-events-none',
      'group-hover:opacity-100',
      'group-hover:pointer-events-auto',
      'focus-visible:opacity-100',
      'focus-visible:pointer-events-auto',
    ]) {
      expect(remove.classList.contains(className)).toBe(true);
    }
    expect(remove.classList.contains('hidden')).toBe(false);
    expect(remove.classList.contains('group-hover:flex')).toBe(false);

    remove.focus();
    expect(document.activeElement).toBe(remove);
  });
});
