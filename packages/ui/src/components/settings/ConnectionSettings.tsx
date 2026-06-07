import {useCallback, useEffect, useState} from 'react';
import {getServerUrlOverride, setServerUrlOverride, type ServerInfo} from '@open-book/sdk';
import {usePlatformLibrary, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';

/**
 * Server connection: connect to a remote server, or (on the desktop) start/stop
 * the bundled local server. Changing the connection reloads the app so the data
 * client re-initializes against the new target.
 */
export default function ConnectionSettings() {
  const {serverControls} = usePlatformLibrary();
  const {t} = useTranslation();
  const connected = getServerUrlOverride();

  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [remoteUrl, setRemoteUrl] = useState(connected ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!serverControls) return;
    serverControls
      .info()
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [serverControls]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runControl = useCallback(async (fn: () => Promise<ServerInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const connectRemote = useCallback(() => {
    setServerUrlOverride(remoteUrl.trim() || null);
    if (typeof window !== 'undefined') window.location.reload();
  }, [remoteUrl]);

  const useLocal = useCallback(() => {
    setServerUrlOverride(null);
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  const localManaged = info?.managed ?? false;

  return (
    <SettingsScreen title={t('connection.title')} description={t('connection.description')}>
      <SettingsSection title={t('connection.server')}>
        <p className="text-sm text-muted-foreground">
          {connected ? (
            <>
              {t('connection.usingRemote')} <code>{connected}</code>.
            </>
          ) : (
            t('connection.usingLocal')
          )}
        </p>
        <SettingsField label={t('connection.remoteUrl')} htmlFor="remote-url" className="max-w-lg">
          <Input
            id="remote-url"
            value={remoteUrl}
            placeholder={t('connection.remoteUrlPlaceholder')}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
        </SettingsField>
        <div className="flex gap-2">
          <Button onClick={connectRemote} disabled={!remoteUrl.trim() || remoteUrl.trim() === connected}>
            {t('connection.connect')}
          </Button>
          <Button variant="outline" onClick={useLocal} disabled={!connected}>
            {t('connection.useLocal')}
          </Button>
        </div>
      </SettingsSection>

      {serverControls && (
        <SettingsSection title={t('connection.localServer')}>
          <p className="text-sm text-muted-foreground">
            {info ? (
              info.running ? (
                <>
                  {t('connection.running')} <code>{info.address}</code>.
                </>
              ) : (
                t('connection.stopped')
              )
            ) : (
              t('connection.checking')
            )}
          </p>
          {info && !localManaged && <p className="text-xs text-muted-foreground">{t('connection.unmanaged')}</p>}
          <div className="flex gap-2">
            <Button
              onClick={() => void runControl(() => serverControls.start())}
              disabled={busy || !localManaged || info?.running === true}
            >
              {t('connection.start')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void runControl(() => serverControls.stop())}
              disabled={busy || !localManaged || info?.running === false}
            >
              {t('connection.stop')}
            </Button>
            <Button variant="ghost" onClick={refresh} disabled={busy}>
              {t('connection.refresh')}
            </Button>
          </div>
        </SettingsSection>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsScreen>
  );
}
