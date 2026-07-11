import {useCallback, useEffect, useState} from 'react';
import {
  getServerUrlOverride,
  setServerUrlOverride,
  getServerTokenOverride,
  setServerTokenOverride,
  isMixedContentBlocked,
  type ServerInfo,
} from '@book.dev/sdk';
import {usePlatformLibrary, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
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
  const [remoteToken, setRemoteToken] = useState(getServerTokenOverride() ?? '');
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

  // An https page (e.g. app.book.pub) can't reach a plain http:// LAN server —
  // the browser blocks it as mixed content before CORS is even considered. Warn
  // and guard rather than let it fail with an opaque console error.
  const trimmedRemote = remoteUrl.trim();
  const remoteBlocked = isMixedContentBlocked(trimmedRemote);
  const connectedBlocked = !!connected && isMixedContentBlocked(connected);

  const connectRemote = useCallback(() => {
    if (isMixedContentBlocked(remoteUrl.trim())) return; // guarded; the warning explains why
    // Persist the token first so it's in place when the reload re-creates the
    // data client against the new server (a published server needs it per request).
    setServerTokenOverride(remoteToken.trim() || null);
    setServerUrlOverride(remoteUrl.trim() || null);
    if (typeof window !== 'undefined') window.location.reload();
  }, [remoteUrl, remoteToken]);

  const useLocal = useCallback(() => {
    setServerUrlOverride(null);
    setServerTokenOverride(null);
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  return (
    <SettingsScreen title={t('connection.title')} description={t('connection.description')} scope="device">
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
        <SettingsField label={t('connection.accessToken')} htmlFor="remote-token" className="max-w-lg">
          <Input
            id="remote-token"
            type="password"
            value={remoteToken}
            placeholder={t('connection.remoteTokenPlaceholder')}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setRemoteToken(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('connection.remoteTokenHint')}</p>
        </SettingsField>
        {(remoteBlocked || connectedBlocked) && (
          <p className="max-w-lg rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
            {t('connection.mixedContentWarning')}
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={connectRemote} disabled={!trimmedRemote || trimmedRemote === connected || remoteBlocked}>
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

      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsScreen>
  );
}
