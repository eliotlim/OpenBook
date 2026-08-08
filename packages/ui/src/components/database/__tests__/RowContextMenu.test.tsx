import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {RowContextMenu} from '../databaseLayouts';
import type {UseDatabase} from '../useDatabase';

// databaseLayouts pulls in the navigation provider at module load; stub it so the
// component tree mounts without the full provider stack. The shared RowMenuItems
// list translates its labels — hand it the real (English) `t` so the assertions
// below read like the UI. RowContextMenu copies a row link through
// useCopyPageLink — mock that with a hoisted spy so the copy-link test can
// assert the row id it was handed.
vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useNavigation: () => ({setPageHint: vi.fn()}),
    useTranslation: () => ({t}),
  };
});
const {copyLink} = vi.hoisted(() => ({copyLink: vi.fn()}));
vi.mock('@/lib/useCopyPageLink', () => ({
  useCopyPageLink: () => copyLink,
}));

afterEach(() => {
  cleanup();
  copyLink.mockClear();
});

const makeDb = (): UseDatabase =>
  ({
    hostPageId: 'db-host',
    openRow: vi.fn(),
    openRowIn: vi.fn(),
    addRowBefore: vi.fn().mockResolvedValue(undefined),
    addRowAfter: vi.fn().mockResolvedValue(undefined),
    duplicateRow: vi.fn().mockResolvedValue(undefined),
    deleteRow: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UseDatabase;

function renderMenu(db: UseDatabase): void {
  render(
    <RowContextMenu db={db} rowId="row-1">
      <button data-testid="card">Row</button>
    </RowContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('card'));
}

describe('RowContextMenu', () => {
  it('offers open targets, copy link, and the row actions', () => {
    renderMenu(makeDb());
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Open in new tab')).toBeTruthy();
    expect(screen.getByText('Open in new window')).toBeTruthy();
    expect(screen.getByText('Copy link')).toBeTruthy();
    expect(screen.getByText('Insert above')).toBeTruthy();
    expect(screen.getByText('Insert below')).toBeTruthy();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('routes the tab/window open targets through openRowIn (a row is a page)', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(db.openRowIn).toHaveBeenCalledWith('row-1', 'tab');

    cleanup();
    const db2 = makeDb();
    renderMenu(db2);
    fireEvent.click(screen.getByText('Open in new window'));
    expect(db2.openRowIn).toHaveBeenCalledWith('row-1', 'window');
  });

  it('keeps the primary Open opening the row in the split pane', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Open'));
    expect(db.openRow).toHaveBeenCalledWith('row-1');
  });

  it('copies an in-context row link (host db page + ?row= anchor) through useCopyPageLink', () => {
    renderMenu(makeDb());
    fireEvent.click(screen.getByText('Copy link'));
    // Anchored at the host database page, not the row-as-standalone-page.
    expect(copyLink).toHaveBeenCalledWith('db-host', {row: 'row-1'});
  });

  it('marks the row element with data-row-anchor so a ?row= link can scroll to it', () => {
    // The scroll-to target lands on the wrapped card/row via asChild (Radix Slot).
    renderMenu(makeDb());
    expect(screen.getByTestId('card').getAttribute('data-row-anchor')).toBe('row-1');
  });

  it('still exposes the existing row mutations', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Insert below'));
    expect(db.addRowAfter).toHaveBeenCalledWith('row-1');

    cleanup();
    const db2 = makeDb();
    renderMenu(db2);
    fireEvent.click(screen.getByText('Delete'));
    expect(db2.deleteRow).toHaveBeenCalledWith('row-1');
  });

  it('inserts a row above via the shared item list (TBL-9)', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Insert above'));
    expect(db.addRowBefore).toHaveBeenCalledWith('row-1');
  });
});
