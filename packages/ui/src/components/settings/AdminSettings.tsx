import BackupSettings from '@/components/BackupSettings';
import LedgerAutoExportSettings from '@/components/settings/LedgerAutoExportSettings';
import {useTranslation} from '@/providers';
import {SettingsScreen} from '@/components/settings/primitives';

/** Library data in/out: backup, restore, folder export, and storage upkeep. */
export default function AdminSettings() {
  const {t} = useTranslation();

  return (
    <SettingsScreen title={t('admin.title')} description={t('admin.description')} scope="library">
      <BackupSettings />
      {/* LGR-7 insurance, surfaced (LX-4): the canonical postings CSV written
          after every ledger mutation — the ledger's own backup lane. */}
      <LedgerAutoExportSettings />
    </SettingsScreen>
  );
}
