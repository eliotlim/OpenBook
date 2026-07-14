import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {RowContextMenu} from '../databaseLayouts';
import type {UseDatabase} from '../useDatabase';

// databaseLayouts pulls in the navigation provider at module load; stub it so the
// component tree mounts without the full provider stack. RowContextMenu itself
// copies a row link through useCopyPageLink — mock that with a hoisted spy so the
// copy-link test can assert the row id it was handed.
vi.mock('@/providers', () => ({
  useNavigation: () => ({setPageHint: vi.fn()}),
}));
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
    openRow: vi.fn(),
    openRowIn: vi.fn(),
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
    expect(screen.getByText('Open in split view')).toBeTruthy();
    expect(screen.getByText('Open in new tab')).toBeTruthy();
    expect(screen.getByText('Open in new window')).toBeTruthy();
    expect(screen.getByText('Copy link')).toBeTruthy();
    expect(screen.getByText('Insert below')).toBeTruthy();
    expect(screen.getByText('Duplicate')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('routes each open target through openRowIn (a row is a page)', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Open in split view'));
    expect(db.openRowIn).toHaveBeenCalledWith('row-1', 'split');

    cleanup();
    const db2 = makeDb();
    renderMenu(db2);
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(db2.openRowIn).toHaveBeenCalledWith('row-1', 'tab');

    cleanup();
    const db3 = makeDb();
    renderMenu(db3);
    fireEvent.click(screen.getByText('Open in new window'));
    expect(db3.openRowIn).toHaveBeenCalledWith('row-1', 'window');
  });

  it('keeps the primary Open opening the row in the split pane', () => {
    const db = makeDb();
    renderMenu(db);
    fireEvent.click(screen.getByText('Open'));
    expect(db.openRow).toHaveBeenCalledWith('row-1');
  });

  it('copies a link to the row through useCopyPageLink', () => {
    renderMenu(makeDb());
    fireEvent.click(screen.getByText('Copy link'));
    expect(copyLink).toHaveBeenCalledWith('row-1');
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
});
