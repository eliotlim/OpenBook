import {useCallback, useEffect, useState} from 'react';
import type {ServerInfo} from '@book.dev/sdk';
import {useAccount, useForwarding, usePlatformCapabilities, useTranslation, type ForwardingStatus} from '@/providers';
import {Button} from '@/components/ui/button';
import {
  SettingsScreen,
  SettingsSection,
  SettingsField,
  SettingsToggle,
  SettingsAdvancedSection,
} from '@/components/settings/primitives';
import {SharingSection} from '@/components/settings/SharingSettings';
import {PeopleSection} from '@/components/settings/MembersSettings';
import {SiteVisibilityControl} from '@/components/SiteVisibilityControl';
import {useSharingCapability} from '@/components/ShareDialog';

/**
 * The one Sharing tab — every control that decides who can reach this library,
 * in one place (SHR-5 merged the former Members tab in as the People section):
 *   • Publish to the web (`✦.book.cloud` forwarding, desktop),
 *   • Default access (the library guest gate),
 *   • People (the member roster: invite, roles, status),
 *   • Advanced — local network (the LAN listener; tokenless, guest-gated).
 * Server *plumbing* (which server, remote URL, tokens) lives in the Libraries &
 * servers screen (SET2-1 folded the old Connection tab in there) — splitting
 * policy from plumbing is the point (IA review, 2026-07).
 */

/** The live tunnel status as a small coloured label next to the toggle. */
function ForwardingStatusBadge({status}: {status: ForwardingStatus}) {
  const {t} = useTranslation();
  if (status === 'online') {
    return <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400"><span aria-hidden="true">●</span> {t('forwarding.status.live')}</span>;
  }
  if (status === 'connecting' || status === 'reconnecting') {
    return <span className="text-xs font-medium text-amber-600 dark:text-amber-400"><span aria-hidden="true">○</span> {t('forwarding.status.connecting')}</span>;
  }
  if (status === 'stalled') {
    return <span className="text-xs font-medium text-red-600 dark:text-red-400"><span aria-hidden="true">●</span> {t('forwarding.status.stalled')}</span>;
  }
  return <span className="text-xs text-muted-foreground"><span aria-hidden="true">○</span> {t('forwarding.status.offline')}</span>;
}

/**
 * Forward this device to a private `✦.book.pub` address (desktop only). Flipping
 * it on creates the device's Ed25519 site key (kept in the OS keychain), registers
 * the site, and opens the reverse tunnel that serves this device's books over IPC
 * (no port). The tunnel is owned by {@link ForwardingProvider}, so it keeps
 * running when this panel closes; here we just drive it and show status.
 */
function ForwardingSection() {
  const {supported, enabled, status, host, busy, error, audienceNotice, claimRefusal, signInPending, enable, disable} =
    useForwarding();
  const {connected, remintIdentity} = useAccount();
  // Defense-in-depth owner guard for the address-scope control, matching the
  // ShareDialog gating: `publishedHost` already implies this device is the owner,
  // but gate the exposure control explicitly on manage capability too (Quinn F6).
  const {canManage} = useSharingCapability();
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
      <SettingsToggle
        label={
          <span className="flex items-center gap-2">
            {busy ? t('forwarding.registering') : t('forwarding.toggle')}
            {enabled && !busy && <ForwardingStatusBadge status={status} />}
          </span>
        }
        checked={enabled}
        disabled={busy}
        onCheckedChange={(v) => void (v ? enable() : disable())}
      />
      {/* A signed-out flip isn't a silent snap-back: the sign-in handoff is in flight
          and the enable auto-resumes once the account connects — say so. The live
          region is mounted PERSISTENTLY (only its text swaps) because content arriving
          together with a fresh `role="status"` node isn't announced by most screen
          readers (same a11y rule as the toast layer). */}
      {!connected && (
        <p role="status" className="text-xs text-muted-foreground">
          {signInPending ? t('forwarding.signInPending') : t('forwarding.signInHint')}
        </p>
      )}
      {/* Forewarn before the flip: the first forward permanently claims this device's
          books to the account and makes them private by default. Mirrors the prior-art
          LAN `connection.publishWarning` box. Hidden once on, or while a refusal shows.
          Shown signed-out too — a signed-out flip now auto-completes after sign-in, so
          the warning must be seen BEFORE that flip, not only after connecting. */}
      {!enabled && !claimRefusal && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          {t('forwarding.claimWarning')}
        </p>
      )}
      {/* A precondition, not a crash: the owner is signed in but their identity isn't
          verified yet. Render it muted (like `signInHint`) with a refresh affordance —
          reserve the destructive red below for a genuine claim failure. */}
      {claimRefusal === 'unverified' && (
        <p className="text-xs text-muted-foreground">
          {t('forwarding.claimRefusedUnverified')}{' '}
          <button
            type="button"
            onClick={() => void remintIdentity()}
            className="font-medium underline underline-offset-2 hover:text-foreground"
          >
            {t('forwarding.refreshIdentity')}
          </button>
        </p>
      )}
      {/* The terminal cousin of `unverified`: the account server has identity issuance
          disabled (501), so a "Refresh identity" here could only loop — explain the
          real blocker instead of offering the affordance. */}
      {claimRefusal === 'issuance-disabled' && (
        <p className="text-xs text-muted-foreground">{t('forwarding.claimRefusedIssuanceDisabled')}</p>
      )}
      {claimRefusal === 'claim-failed' && (
        <p className="text-sm text-destructive">{t('forwarding.claimFailed')}</p>
      )}
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
      {/* Address-level audience scope (SHR-8): the published address is Private by
          default, and a page's own "public" scope can't override that — the edge
          only serves a Public address anonymously. Let the owner flip it here (and
          the Share dialog surfaces the same control + an actionable notice when a
          page is public but the address isn't). Renders only while online + owned. */}
      {canManage && <SiteVisibilityControl />}
      {error && (
        <div className="text-destructive">
          <p className="text-sm">
            {t(status === 'stalled' ? 'forwarding.reconnectFailed' : 'forwarding.failed')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground font-mono">{error}</p>
        </div>
      )}
      {/* Severity-aware, like `claimRefusal` above: `partialUnscoped`/`ensureRescope`
          are benign partial outcomes (the tunnel is up, nothing is broken — only the
          strict audience hardening is incomplete), so render them muted; reserve the
          destructive red for a bind/unbind step that genuinely failed. */}
      {audienceNotice && (
        <p
          className={
            audienceNotice.code === 'partialUnscoped' || audienceNotice.code === 'ensureRescope'
              ? 'text-xs text-muted-foreground'
              : 'text-sm text-destructive'
          }
        >
          {t(`forwarding.${audienceNotice.code}`, {error: audienceNotice.detail ?? ''})}
        </p>
      )}
    </SettingsSection>
  );
}

/**
 * Publish the desktop's local server on the LAN — a network listener that also
 * serves the web UI. Tokenless (STAB-7): the library's Default access (guest) gate
 * is the only thing standing between a reachable browser and the library. Distinct
 * from forwarding: this exposes the server on the local network directly, no relay.
 */
function LanPublishSection() {
  const {serverControls} = usePlatformCapabilities();
  const {t} = useTranslation();

  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverControls) return;
    serverControls
      .info()
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [serverControls]);

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

  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  }, []);

  if (!serverControls?.publish) return null;
  // The info() probe failed: show the error instead of silently dropping the
  // whole section (an unmanaged server legitimately hides it, a failed probe
  // must not look the same).
  if (!info) {
    return error ? (
      <SettingsSection title={t('connection.publish')}>
        <p className="text-sm text-destructive">{error}</p>
      </SettingsSection>
    ) : null;
  }
  if (!info.managed) return null;

  return (
    // Advanced/rare surface (SET2-8): the LAN listener is collapsed by default so
    // the common Sharing path (publish to web · default access · people) stays quiet.
    <SettingsAdvancedSection title={t('connection.publish')} description={t('connection.publishDescription')}>
      <SettingsToggle
        label={t('connection.publishToggle')}
        checked={info?.published === true}
        disabled={busy}
        onCheckedChange={(v) => void togglePublish(v)}
      />
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
            {/* STAB-7 (LAN-hosted web UI): the sidecar now also serves the full web
                app at this address, so anyone on the network can just open it in a
                browser (no OpenBook install). Say so — and flag the guest-first
                posture + the raw-LAN account sign-in caveat right where the URL is. */}
            <p className="mt-1 text-xs text-muted-foreground">{t('connection.openInBrowserHint')}</p>
          </SettingsField>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('connection.notPublished')}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </SettingsAdvancedSection>
  );
}

/**
 * The standalone web app's stand-in for the (desktop-only) publish sections
 * (P0-4): the library lives only in this browser, so instead of silently
 * hiding every publish control — leaving an intro that promises "publish it to
 * the web" with nothing below — say plainly that nothing outside this browser
 * can reach it and that publishing happens from the desktop app.
 */
function BrowserLocalPointerSection() {
  const {t} = useTranslation();
  return (
    <SettingsSection title={t('sharingScreen.webPublishTitle')}>
      <p className="text-sm text-muted-foreground">{t('sharingScreen.webPublishBody')}</p>
    </SettingsSection>
  );
}

export default function SharingPublishingSettings() {
  const {t} = useTranslation();
  // The in-browser (PGlite) library: no publish affordance exists here and
  // no one else can reach the data, so the intro must not promise publishing.
  const browserLocal = usePlatformCapabilities().browserLocalLibrary === true;
  return (
    <SettingsScreen
      title={t('sharingScreen.title')}
      description={t(browserLocal ? 'sharingScreen.webDescription' : 'sharingScreen.description')}
      scope="library"
    >
      {browserLocal && <BrowserLocalPointerSection />}
      <ForwardingSection />
      <SharingSection />
      <PeopleSection />
      <LanPublishSection />
    </SettingsScreen>
  );
}
