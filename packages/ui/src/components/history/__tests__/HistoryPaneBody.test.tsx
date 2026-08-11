import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';

const {confirmRestore, listVersions, restoreVersion} = vi.hoisted(() => ({
  confirmRestore: vi.fn(async () => true),
  listVersions: vi.fn(async () => [
    {
      id: 'version-1',
      pageId: 'page-1',
      authorSubject: null,
      authorIssuer: null,
      authorName: null,
      createdAt: '2026-08-11T00:00:00.000Z',
    },
  ]),
  restoreVersion: vi.fn(async () => ({id: 'page-1'})),
}));

vi.mock('@/data', () => ({
  useData: () => ({
    getPage: async () => null,
    getVersion: async () => null,
    listVersions,
    restoreVersion,
  }),
}));

vi.mock('@/lib/historyPane', () => ({
  getHistoryTarget: () => ({pageId: 'page-1', revision: 1}),
  subscribeHistoryPane: () => () => undefined,
}));

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {
    useConfirm: () => confirmRestore,
    useNavigation: () => ({pageLabel: () => 'Test page'}),
    useTranslation: () => ({locale: 'en', t}),
  };
});

vi.mock('@/blockeditor/PresentBlocks', () => ({PresentBlocks: () => null}));
vi.mock('../VersionDiff', () => ({VersionDiff: () => <div>Version diff</div>}));

import {MENU_DESTRUCTIVE_CLASS} from '@/components/ui/menu-components';
import {HistoryPaneBody} from '../HistoryPaneBody';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HistoryPaneBody entry context menu', () => {
  it('renders version actions and reuses the confirmation-backed restore handler', async () => {
    render(<HistoryPaneBody />);

    fireEvent.contextMenu(await screen.findByText('Automatic checkpoint'));

    expect(screen.getByRole('menuitem', {name: 'Diff against current'})).toBeTruthy();
    const restore = screen.getByRole('menuitem', {name: 'Restore this version'});
    for (const className of MENU_DESTRUCTIVE_CLASS.split(' ')) {
      expect(restore.className.split(' ')).toContain(className);
    }
    fireEvent.click(restore);

    await waitFor(() => expect(confirmRestore).toHaveBeenCalledOnce());
    await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith('page-1', 'version-1'));
  });
});
