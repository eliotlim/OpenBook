import BackupSettings from '@/components/BackupSettings';
import {useTranslation} from '@/providers';
import {SettingsScreen} from '@/components/settings/primitives';

/** Workspace data in/out: backup, restore, folder export, and storage upkeep. */
export default function AdminSettings() {
  const {t} = useTranslation();

  return (
    <SettingsScreen title={t('admin.title')} description={t('admin.description')}>
      <BackupSettings />
    </SettingsScreen>
  );
}
