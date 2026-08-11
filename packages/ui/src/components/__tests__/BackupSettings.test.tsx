import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {
  DEFAULT_BACKUP_CONFIG,
  type BackupStatus,
  type DataClient,
  type ImportRequest,
  type LibraryBackup,
} from '@book.dev/sdk';
import BackupSettings from '../BackupSettings';
import {DataProvider} from '@/data/DataProvider';
import {I18nProvider} from '@/providers';

vi.mock('@/providers', async (orig) => {
  const actual = await orig<typeof import('@/providers')>();
  return {
    ...actual,
    useConfirm: () => vi.fn(async () => true),
    useHud: () => ({setHud: vi.fn()}),
    useNavigation: () => ({reload: vi.fn()}),
    usePlatformCapabilities: () => ({}),
  };
});

const pageId = '11111111-1111-4111-8111-111111111111';
const missingAsset = 'a'.repeat(64);
const skipCarryingBundle: LibraryBackup = {
  version: 3,
  exportedAt: '2026-08-11T00:00:00.000Z',
  instanceId: 'target-instance',
  pages: [{
    id: pageId,
    name: 'Skip-carrying page',
    hostedDatabaseId: null,
    databaseId: null,
    parentId: null,
    properties: {},
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    deletedAt: null,
    data: {
      editorjs: {blocks: []},
      values: [],
      names: [],
      blockdoc: {v: 1, update: '', blocks: [{id: 'image', type: 'image', props: {assetId: missingAsset}}]},
    },
  }],
  databases: [],
  assets: [],
  pageAccess: [{pageId, visibility: 'restricted', agentEdits: 'suggest', acl: []}],
  skipped: [{id: missingAsset, refs: [pageId], reason: 'missing-bytes'}],
};

const backupStatus = (): BackupStatus => ({
  config: {...DEFAULT_BACKUP_CONFIG},
  resolvedDir: '/tmp/openbook/backups',
  cadences: [{
    cadence: 'daily',
    enabled: true,
    lastRun: '2026-08-10T09:30:00.000Z',
    nextDue: '2026-08-11T09:30:00.000Z',
    count: 3,
    lastSkippedCount: 2,
    lastError: {
      failedAt: '2026-08-11T09:30:00.000Z',
      retryAt: '2026-08-11T10:30:00.000Z',
      attempts: 1,
      message: 'Backup drive unavailable',
    },
  }],
});

const renderSettings = (client: Partial<DataClient>) =>
  render(
    <I18nProvider>
      <DataProvider client={client as DataClient}>
        <BackupSettings />
      </DataProvider>
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('BackupSettings', () => {
  it('forwards selected skipped items and surfaces the partial-restore diagnostic', async () => {
    const importLibrary = vi.fn(async (req: ImportRequest) => {
      expect(req.skipped).toEqual(skipCarryingBundle.skipped);
      return {
        created: 1,
        overwritten: 0,
        renamed: 0,
        idMap: {[pageId]: pageId},
        diagnostics: [{
          code: 'partial-restore' as const,
          version: 3 as const,
          missing: ['scheduled-backup-skips' as const],
          message: 'partial restore from scheduled backup: 1 inconsistent item(s) were skipped and recorded',
        }],
      };
    });
    renderSettings({
      getInstanceInfo: async () => ({instanceId: 'target-instance'}) as never,
      getBackupStatus: async () => backupStatus(),
      importLibrary,
    });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: {files: [new File([JSON.stringify(skipCarryingBundle)], 'skip.openbook.json', {type: 'application/json'})]},
    });
    fireEvent.click(await screen.findByRole('button', {name: 'Restore 1'}));

    await waitFor(() => expect(importLibrary).toHaveBeenCalledTimes(1));
    expect(importLibrary.mock.calls[0][0].skipped).toEqual(skipCarryingBundle.skipped);
    expect(await screen.findByText(/Warning: partial restore from scheduled backup/)).toBeTruthy();
  });

  it('shows the latest skipped/error state and includes manual-run skips in its status', async () => {
    const getBackupStatus = vi.fn(async () => backupStatus());
    renderSettings({
      getInstanceInfo: async () => ({instanceId: 'target-instance'}) as never,
      getBackupStatus,
      runBackup: async () => ({file: 'openbook-backup.openbook.json', dir: '/tmp/openbook/backups', skippedCount: 2}),
    });

    expect(await screen.findByText(/Last run skipped 2 item\(s\).*Last error: Backup drive unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Back up now'}));
    expect(await screen.findByText('Backed up — openbook-backup.openbook.json · skipped 2 item(s)')).toBeTruthy();
  });
});
