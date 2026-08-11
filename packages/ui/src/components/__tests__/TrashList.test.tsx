import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {PageMeta} from '@book.dev/sdk';
import TrashList from '@/components/TrashList';
import type {TrashController} from '@/lib/useTrash';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {useTranslation: () => ({t, locale: 'en'})};
});

const item: PageMeta = {
  id: 'trashed',
  name: 'Trashed page',
  icon: null,
  hostedDatabaseId: null,
  parentId: null,
  deletedAt: '2026-01-03T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

afterEach(cleanup);

describe('trash row context menu', () => {
  it('restores from the menu and retains the existing hover-button action', () => {
    const restore = vi.fn().mockResolvedValue(undefined);
    const trash = {
      items: [item],
      loading: false,
      busy: null,
      restore,
      purge: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrashController;
    render(<TrashList trash={trash} />);

    fireEvent.contextMenu(screen.getByText('Trashed page'));
    fireEvent.click(screen.getByText('Restore'));
    expect(restore).toHaveBeenCalledWith('trashed');

    fireEvent.click(screen.getByRole('button', {name: 'Restore Trashed page'}));
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('routes the destructive menu action through the confirm-backed purge handler', () => {
    const purge = vi.fn().mockResolvedValue(undefined);
    const trash = {
      items: [item],
      loading: false,
      busy: null,
      restore: vi.fn().mockResolvedValue(undefined),
      purge,
    } as unknown as TrashController;
    render(<TrashList trash={trash} />);

    fireEvent.contextMenu(screen.getByText('Trashed page'));
    const action = screen.getByText('Delete forever');
    expect(action.closest('[role="menuitem"]')?.className).toContain('text-destructive');
    fireEvent.click(action);
    expect(purge).toHaveBeenCalledWith(item);
  });
});
