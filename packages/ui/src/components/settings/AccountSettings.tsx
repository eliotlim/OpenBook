import {ArrowPathIcon, ArrowTopRightOnSquareIcon, CheckBadgeIcon} from '@heroicons/react/24/outline';
import {Button} from '@/components/ui/button';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {useAccount, usePlatformLibrary, useTranslation} from '@/providers';

/**
 * Account & sync: connect this device to account.book.pub (the deep-link OAuth
 * flow) and mirror preferences + the workspace list there. The data server is
 * untouched — only settings sync through the account service.
 */
export default function AccountSettings() {
  const {t} = useTranslation();
  const {status, connected, deviceName, lastSyncedAt, error, accountUrl, signIn, cancel, signOut, syncNow} = useAccount();
  const platform = usePlatformLibrary();

  const openExternal = (url: string): void => {
    if (platform.account?.openSignIn) platform.account.openSignIn(url);
    else if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  };

  const lastSynced = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : t('account.signin.never');

  return (
    <SettingsScreen title={t('account.signin.title')} description={t('account.signin.description')}>
      {!connected ? (
        <SettingsSection>
          {status === 'connecting' ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground">{t('account.signin.connecting')}</p>
              <Button variant="ghost" size="sm" onClick={cancel}>
                {t('account.signin.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="outline" className="w-full sm:w-auto" onClick={signIn}>
              {t('account.signin.signInButton')}
            </Button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">{t('account.signin.whatSyncs')}</p>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <CheckBadgeIcon className="h-5 w-5 text-brand" />
                <span className="text-sm font-semibold">{t('account.signin.connectedTitle')}</span>
                {status === 'syncing' && (
                  <span className="text-xs text-muted-foreground">{t('account.signin.syncing')}</span>
                )}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('account.signin.connectedAs')}</dt>
                <dd className="truncate font-medium">{deviceName}</dd>
                <dt className="text-muted-foreground">{t('account.signin.lastSynced')}</dt>
                <dd className="font-medium">{lastSynced}</dd>
              </dl>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="mt-1 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={syncNow} disabled={status === 'syncing'}>
                  <ArrowPathIcon className="mr-1.5 h-4 w-4" />
                  {t('account.signin.syncNow')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => openExternal(`${accountUrl}/dashboard`)}>
                  <ArrowTopRightOnSquareIcon className="mr-1.5 h-4 w-4" />
                  {t('account.signin.openDashboard')}
                </Button>
                <Button variant="ghost" size="sm" onClick={signOut} className="text-destructive hover:text-destructive">
                  {t('account.signin.signOut')}
                </Button>
              </div>
            </div>
          </SettingsSection>
          <SettingsSection>
            <p className="text-xs text-muted-foreground">{t('account.signin.whatSyncs')}</p>
            <p className="text-xs text-muted-foreground">{t('account.signin.signOutHint')}</p>
          </SettingsSection>
        </>
      )}
    </SettingsScreen>
  );
}
