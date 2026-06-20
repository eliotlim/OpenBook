import {useCallback, useEffect, useState} from 'react';
import {getServerUrlOverride, setServerUrlOverride, type ServerInfo} from '@open-book/sdk';
import {usePlatformLibrary, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';

/**
 * Server connection: connect to a remote server, or (on the desktop) manage the
 * local server's network sharing. The desktop keeps its books in an always-on
 * local server reached over IPC; connecting to a remote server reloads the app
 * so the data client re-initializes against the new target.
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

  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  }, []);

  // Publishing only toggles the LAN listener; the local UI keeps its IPC
  // connection (which transparently reconnects across the server respawn), so
  // there's nothing to reload.
  const togglePublish = useCallback(
    async (enabled: boolean) => {
      if (!serverControls?.publish) return;
      setBusy(true);
      setError(null);
      try {
        setInfo(await serverControls.publish(enabled));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [serverControls],
  );

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

      {serverControls && !connected && (
        <SettingsSection title={t('connection.inApp')}>
          <p className="text-sm text-muted-foreground">{t('connection.inAppDescription')}</p>
          {info?.published && info.running && info.lanAddress && (
            <p className="text-xs text-muted-foreground">
              {t('connection.running')} <code>{info.lanAddress}</code>.
            </p>
          )}
        </SettingsSection>
      )}

      {serverControls?.publish && localManaged && (
        <SettingsSection title={t('connection.publish')}>
          <p className="text-sm text-muted-foreground">{t('connection.publishDescription')}</p>
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <span className="text-sm font-medium">{t('connection.publishToggle')}</span>
            <Switch
              checked={info?.published === true}
              disabled={busy}
              onCheckedChange={(v) => void togglePublish(v)}
            />
          </label>
          {info?.published ? (
            <div className="flex flex-col gap-3">
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
                {t('connection.publishWarning')}
              </p>
              <SettingsField label={t('connection.lanAddress')} className="max-w-lg">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                    {info.lanAddress ?? '—'}
                  </code>
                  <Button variant="outline" size="sm" disabled={!info.lanAddress} onClick={() => copy('addr', info.lanAddress ?? '')}>
                    {copied === 'addr' ? t('connection.copied') : t('connection.copy')}
                  </Button>
                </div>
              </SettingsField>
              <SettingsField label={t('connection.accessToken')} className="max-w-lg">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                    {info.accessToken ?? '—'}
                  </code>
                  <Button variant="outline" size="sm" disabled={!info.accessToken} onClick={() => copy('tok', info.accessToken ?? '')}>
                    {copied === 'tok' ? t('connection.copied') : t('connection.copy')}
                  </Button>
                </div>
              </SettingsField>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('connection.notPublished')}</p>
          )}
        </SettingsSection>
      )}

      {serverControls?.chooseBookDir && localManaged && (
        <SettingsSection title={t('connection.bookFiles')}>
          <p className="text-sm text-muted-foreground">{t('connection.bookFilesDescription')}</p>
          <SettingsField label={t('connection.bookFolder')} className="max-w-lg">
            <code className="block truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
              {info?.bookDir ?? '—'}
            </code>
          </SettingsField>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runControl(() => serverControls.chooseBookDir!())}
            >
              {t('connection.changeFolder')}
            </Button>
            {serverControls.revealBookDir && (
              <Button variant="ghost" disabled={busy} onClick={() => void serverControls.revealBookDir!()}>
                {t('connection.reveal')}
              </Button>
            )}
          </div>
        </SettingsSection>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsScreen>
  );
}
