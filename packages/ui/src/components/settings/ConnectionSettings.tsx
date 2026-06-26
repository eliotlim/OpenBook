import {useCallback, useEffect, useState} from 'react';
import {
  getServerUrlOverride,
  setServerUrlOverride,
  getServerTokenOverride,
  setServerTokenOverride,
  isMixedContentBlocked,
  type ServerInfo,
} from '@book.dev/sdk';
import {useAccount, useForwarding, usePlatformLibrary, useTranslation, type ForwardingStatus} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';
import {SharingSection} from '@/components/settings/SharingSettings';

/** The live tunnel status as a small coloured label next to the toggle. */
function ForwardingStatusBadge({status}: {status: ForwardingStatus}) {
  const {t} = useTranslation();
  if (status === 'online') {
    return <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">● {t('forwarding.status.live')}</span>;
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return <span className="text-xs font-medium text-amber-600 dark:text-amber-400">○ {t('forwarding.status.connecting')}</span>;
  }
  return <span className="text-xs text-muted-foreground">○ {t('forwarding.status.offline')}</span>;
}

/**
 * Forward this device to a private `✦.book.pub` address (desktop only). Flipping
 * it on creates the device's Ed25519 site key (kept in the OS keychain), registers
 * the site, and opens the reverse tunnel that serves this device's books over IPC
 * (no port). The tunnel is owned by {@link ForwardingProvider}, so it keeps
 * running when this panel closes; here we just drive it and show status.
 */
function ForwardingSection() {
  const {supported, enabled, status, host, busy, error, enable, disable} = useForwarding();
  const {connected} = useAccount();
  const {t} = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyAddress = useCallback(() => {
    if (!host) return;
    void navigator.clipboard?.writeText(`https://${host}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [host]);

  if (!supported) return null; // desktop-only affordance

  return (
    <SettingsSection title={t('forwarding.title')}>
      <p className="text-sm text-muted-foreground">{t('forwarding.description')}</p>
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          {busy ? t('forwarding.registering') : t('forwarding.toggle')}
          {enabled && !busy && <ForwardingStatusBadge status={status} />}
        </span>
        <Switch checked={enabled} disabled={busy} onCheckedChange={(v) => void (v ? enable() : disable())} />
      </label>
      {!connected && <p className="text-xs text-muted-foreground">{t('forwarding.signInHint')}</p>}
      {host && (
        <SettingsField label={t('forwarding.address')} className="max-w-lg">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
              https://{host}
            </code>
            <Button variant="outline" size="sm" onClick={copyAddress}>
              {copied ? t('forwarding.copied') : t('forwarding.copy')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('forwarding.addressHint')}</p>
        </SettingsField>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsSection>
  );
}

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

  const localManaged = info?.managed ?? false;

  return (
    <SettingsScreen title={t('connection.title')} description={t('connection.description')}>
      <ForwardingSection />

      <SharingSection />

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
