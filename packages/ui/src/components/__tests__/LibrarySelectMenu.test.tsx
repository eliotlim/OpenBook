import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, createEvent, fireEvent, render, screen} from '@testing-library/react';
import LibrarySelectMenu from '../LibrarySelectMenu';

const library = {id: 'local', name: 'My Library', serverUrl: null, icon: '📚'};

vi.mock('@/providers', () => ({
  useLibrary: () => ({
    libraries: [library],
    library,
    selectLibrary: vi.fn(),
    addLibrary: vi.fn(),
    removeLibrary: vi.fn(),
  }),
  useHud: () => ({setHud: vi.fn()}),
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'library.libraries': 'Libraries',
        'library.connectAction': 'Connect to a library…',
        'library.manage': 'Manage libraries',
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
});
