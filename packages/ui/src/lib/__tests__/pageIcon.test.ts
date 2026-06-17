import {afterEach, describe, it, expect, vi} from 'vitest';
import {
  DEFAULT_PAGE_ICON,
  hydratePageIcons,
  readPageIcon,
  readStoredPageIcon,
  setIconPersister,
  writePageIcon,
} from '../pageIcon';

afterEach(() => {
  setIconPersister(null);
  localStorage.clear();
});

/**
 * Icons moved from localStorage to the page document (`page.properties`), but are
 * read synchronously in many places. The in-memory cache backs the unchanged
 * `readPageIcon` API; it's hydrated in bulk from list projections and writes
 * through a registered backend. (Unique ids per test isolate the shared cache.)
 */
describe('pageIcon store', () => {
  it('defaults to the page icon and resolves home', () => {
    expect(readPageIcon('unknown-x')).toBe(DEFAULT_PAGE_ICON);
    expect(readPageIcon('home')).toBe('🏠');
    expect(readStoredPageIcon('unknown-x')).toBeNull();
  });

  it('writes through to the document and clears with an empty value', () => {
    const persist = vi.fn();
    setIconPersister(persist);
    writePageIcon('w1', '🚀');
    expect(readPageIcon('w1')).toBe('🚀');
    expect(persist).toHaveBeenCalledWith('w1', '🚀');
    writePageIcon('w1', '');
    expect(readPageIcon('w1')).toBe(DEFAULT_PAGE_ICON);
    expect(persist).toHaveBeenLastCalledWith('w1', null);
  });

  it('hydrates icons in bulk from a list projection', () => {
    hydratePageIcons([
      {id: 'h1', icon: '📚'},
      {id: 'h2', icon: null},
    ]);
    expect(readPageIcon('h1')).toBe('📚');
    expect(readPageIcon('h2')).toBe(DEFAULT_PAGE_ICON);
  });

  it('migrates a legacy localStorage icon into the document', () => {
    const persist = vi.fn();
    setIconPersister(persist);
    localStorage.setItem('openbook.icon.m1', '🔥');
    hydratePageIcons([{id: 'm1'}]); // no icon in the list → migrate from legacy
    expect(readPageIcon('m1')).toBe('🔥');
    expect(persist).toHaveBeenCalledWith('m1', '🔥');
    expect(localStorage.getItem('openbook.icon.m1')).toBeNull();
  });
});
