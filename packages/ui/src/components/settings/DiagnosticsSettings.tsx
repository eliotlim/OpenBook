import {useCallback, useEffect, useState} from 'react';
import {getForwardingAudience, type InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data/DataProvider';
import {useAccount, useConfirm, useForwarding, useTranslation, type IdentityIssuance} from '@/providers';
import {Button} from '@/components/ui/button';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {cn} from '@/lib/utils';

/**
 * The "Diagnostics" settings screen: how this library resolves YOU — identity,
 * ownership, and publishing/audience state — with the repairs for the common
 * lockouts surfaced right next to the check that detects them. Born from the
 * 2026-07 support cluster ("Export failed: you do not have write access", "only
 * the instance owner can change multi-user", the silent identity loss behind
 * both): every one of those was invisible without curl. The screen is read-only
 * except for two explicit actions — refresh identity, and the ownership repair
 * the server only permits from the library's own device (machine-owner
 * authority, `InstanceInfo.localOwner`).
 */

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** One check: a label, a toned verdict, and an optional monospace detail line. */
function DiagnosticRow({label, value, tone = 'muted', detail}: {label: string; value: string; tone?: Tone; detail?: string}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn('text-right text-sm font-medium', TONE_CLASS[tone])}>{value}</span>
      </div>
      {detail && (
        <code className="self-end truncate rounded bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground" title={detail}>
          {detail}
        </code>
      )}
    </div>
  );
}

export interface DiagnosticsBodyProps {
  /** The account service's identity-issuance verdict, when an account context exists. */
  issuance?: IdentityIssuance;
  /** Re-mint the identity token (the account provider's remint), when available. */
  onRefreshIdentity?: () => Promise<unknown>;
}

/**
 * The diagnostics content, decoupled from `useAccount` (which throws without a
 * provider) so it stays unit-testable over just the data client + i18n. The
 * default export wires the account context in.
 */
export function DiagnosticsBody({issuance, onRefreshIdentity}: DiagnosticsBodyProps) {
  const data = useData();
  const forwarding = useForwarding();
  const confirm = useConfirm();
  const {t} = useTranslation();

  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [localAudience, setLocalAudience] = useState<string | null>(null);
  const [repair, setRepair] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const probe = useCallback(async () => {
    setChecking(true);
    setProbeError(null);
    try {
      setInfo(await data.getInstanceInfo());
    } catch (e) {
      setInfo(null);
      setProbeError(e instanceof Error ? e.message : String(e));
    } finally {
      setLocalAudience(getForwardingAudience());
      setChecking(false);
    }
  }, [data]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const you = info?.you ?? null;
  // The lockout this screen exists for: claimed, but to a different subject than
  // the verified identity this device presents. Owner-level actions 403 until the
  // pin is re-pointed — which the server permits only with machine-owner authority.
  const drifted = Boolean(info?.ownerSubject && you?.verifiedVia === 'jws' && you.subject !== info?.ownerSubject);
  const canRepair = drifted && info?.localOwner === true;
  const isOwner = Boolean(info?.ownerSubject && you?.verifiedVia === 'jws' && you.subject === info?.ownerSubject);

  const refreshIdentity = useCallback(async () => {
    if (!onRefreshIdentity) return;
    setRefreshing(true);
    try {
      await onRefreshIdentity();
    } finally {
      setRefreshing(false);
    }
    await probe(); // the server's verdict on `you` may have just changed
  }, [onRefreshIdentity, probe]);

  const repairOwnership = useCallback(async () => {
    if (!you) return;
    const confirmed = await confirm({
      title: t('diagnostics.repairConfirmTitle'),
      description: t('diagnostics.repairConfirmBody', {subject: you.subject}),
      confirmText: t('diagnostics.repair'),
    });
    if (!confirmed) return;
    setRepair('busy');
    try {
      // The server accepts this only over the trusted local transport and only
      // to the caller's OWN verified subject — see `PUT /api/instance`.
      const next = await data.setInstancePolicy({ownerSubject: you.subject});
      setRepair(next.ownerSubject === you.subject ? 'done' : 'failed');
    } catch {
      setRepair('failed');
    }
    await probe();
  }, [confirm, data, probe, t, you]);

  const copyReport = useCallback(() => {
    const report = {
      at: new Date().toISOString(),
      instance: info && {
        ownerSubject: info.ownerSubject,
        guestAccess: info.guestAccess,
        audience: info.audience,
        requireAudience: info.requireAudience ?? false,
        localOwner: info.localOwner ?? false,
        you: {subject: info.you.subject, verifiedVia: info.you.verifiedVia, kind: info.you.kind},
        youRole: info.youRole ?? null,
      },
      probeError,
      forwarding: {supported: forwarding.supported, enabled: forwarding.enabled, status: forwarding.status, host: forwarding.host},
      localAudience,
      identityIssuance: issuance ?? null,
    };
    void navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [forwarding, info, issuance, localAudience, probeError]);

  // The whole screen keys off one probe; a failure IS the diagnostic (a legacy
  // server without the multi-user endpoint, or an unreachable one) — show it,
  // never render blank.
  if (checking && !info && !probeError) {
    return <p className="text-sm text-muted-foreground">{t('diagnostics.checking')}</p>;
  }

  const identityRow = (() => {
    if (!you) return {value: t('diagnostics.guest'), tone: 'muted' as Tone, detail: undefined};
    if (you.verifiedVia === 'jws') return {value: t('diagnostics.verified'), tone: 'ok' as Tone, detail: you.subject};
    if (you.verifiedVia === 'local') return {value: t('diagnostics.machineOwner'), tone: 'ok' as Tone, detail: undefined};
    return {value: t('diagnostics.guest'), tone: 'warn' as Tone, detail: undefined};
  })();

  const roleRow = (() => {
    if (isOwner) return {value: t('diagnostics.roleOwner'), tone: 'ok' as Tone};
    if (you?.verifiedVia === 'local') return {value: t('diagnostics.roleOwner'), tone: 'ok' as Tone};
    if (info?.youRole === 'admin') return {value: t('diagnostics.roleAdmin'), tone: 'ok' as Tone};
    if (info?.youRole === 'viewer') return {value: t('diagnostics.roleViewer'), tone: 'muted' as Tone};
    return {value: t('diagnostics.roleNone'), tone: drifted ? ('warn' as Tone) : ('muted' as Tone)};
  })();

  return (
    <>
      {probeError && (
        <SettingsSection title={t('diagnostics.identity')}>
          <p className="text-sm text-destructive">{t('diagnostics.probeFailed', {error: probeError})}</p>
          <div>
            <Button variant="outline" size="sm" disabled={checking} onClick={() => void probe()}>
              {t('diagnostics.rerun')}
            </Button>
          </div>
        </SettingsSection>
      )}

      {info && (
        <>
          <SettingsSection title={t('diagnostics.identity')}>
            <p className="text-sm text-muted-foreground">{t('diagnostics.identityHint')}</p>
            <div className="flex flex-col">
              <DiagnosticRow label={t('diagnostics.you')} value={identityRow.value} tone={identityRow.tone} detail={identityRow.detail} />
              {issuance !== undefined && (
                <DiagnosticRow
                  label={t('diagnostics.issuance')}
                  value={
                    issuance === 'ok'
                      ? t('diagnostics.issuanceOk')
                      : issuance === 'unconfigured'
                        ? t('diagnostics.issuanceDisabled')
                        : t('diagnostics.issuanceUnknown')
                  }
                  tone={issuance === 'ok' ? 'ok' : issuance === 'unconfigured' ? 'bad' : 'muted'}
                />
              )}
            </div>
            {onRefreshIdentity && (
              <div>
                <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void refreshIdentity()}>
                  {refreshing ? t('diagnostics.refreshing') : t('diagnostics.refreshIdentity')}
                </Button>
              </div>
            )}
          </SettingsSection>

          <SettingsSection title={t('diagnostics.ownership')}>
            <p className="text-sm text-muted-foreground">{t('diagnostics.ownershipHint')}</p>
            <div className="flex flex-col">
              <DiagnosticRow
                label={t('diagnostics.claim')}
                value={info.ownerSubject ? t('diagnostics.claimedTo') : t('diagnostics.unclaimed')}
                tone={info.ownerSubject ? 'ok' : 'muted'}
                detail={info.ownerSubject ?? undefined}
              />
              <DiagnosticRow label={t('diagnostics.role')} value={roleRow.value} tone={roleRow.tone} />
              <DiagnosticRow
                label={t('diagnostics.deviceAuthority')}
                value={info.localOwner ? t('diagnostics.deviceAuthorityYes') : t('diagnostics.deviceAuthorityNo')}
                tone={info.localOwner ? 'ok' : 'muted'}
              />
            </div>
            {drifted && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs font-medium text-amber-600 dark:text-amber-400">{t('diagnostics.drift')}</p>
                <p className="text-xs text-muted-foreground">{t('diagnostics.driftExplain')}</p>
                {canRepair ? (
                  <div>
                    <Button size="sm" variant="outline" disabled={repair === 'busy'} onClick={() => void repairOwnership()}>
                      {repair === 'busy' ? t('diagnostics.repairing') : t('diagnostics.repair')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('diagnostics.repairNeedsDevice')}</p>
                )}
                {repair === 'failed' && <p className="text-xs text-destructive">{t('diagnostics.repairFailed')}</p>}
              </div>
            )}
            {repair === 'done' && !drifted && (
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">{t('diagnostics.repaired')}</p>
            )}
          </SettingsSection>

          <SettingsSection title={t('diagnostics.publishing')}>
            <p className="text-sm text-muted-foreground">{t('diagnostics.publishingHint')}</p>
            <div className="flex flex-col">
              <DiagnosticRow
                label={t('diagnostics.forwardingRow')}
                value={
                  !forwarding.enabled
                    ? t('diagnostics.forwardingOff')
                    : forwarding.status === 'online'
                      ? t('forwarding.status.live')
                      : forwarding.status === 'stalled'
                        ? t('forwarding.status.stalled')
                        : forwarding.status === 'connecting' || forwarding.status === 'reconnecting'
                          ? t('forwarding.status.connecting')
                          : t('forwarding.status.offline')
                }
                tone={forwarding.enabled ? (forwarding.status === 'online' ? 'ok' : 'warn') : 'muted'}
                detail={forwarding.host ? `https://${forwarding.host}` : undefined}
              />
              <DiagnosticRow
                label={t('diagnostics.audience')}
                value={
                  info.audience
                    ? info.requireAudience
                      ? t('diagnostics.audienceStrict', {host: info.audience})
                      : info.audience
                    : t('diagnostics.audienceNone')
                }
                tone={info.audience ? 'ok' : 'muted'}
              />
              {localAudience && <DiagnosticRow label={t('diagnostics.localAudience')} value={localAudience} tone="muted" />}
            </div>
            {forwarding.host && info.audience && info.audience !== forwarding.host && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('diagnostics.audienceMismatch')}</p>
            )}
          </SettingsSection>

          <SettingsSection title={t('diagnostics.report')}>
            <p className="text-sm text-muted-foreground">{t('diagnostics.reportHint')}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={copyReport}>
                {copied ? t('diagnostics.copied') : t('diagnostics.copyReport')}
              </Button>
              <Button variant="ghost" size="sm" disabled={checking} onClick={() => void probe()}>
                {t('diagnostics.rerun')}
              </Button>
            </div>
          </SettingsSection>
        </>
      )}
    </>
  );
}

export default function DiagnosticsSettings() {
  const {t} = useTranslation();
  const {remintIdentity, identityIssuance} = useAccount();
  return (
    <SettingsScreen title={t('diagnostics.title')} description={t('diagnostics.description')} scope="device">
      <DiagnosticsBody issuance={identityIssuance} onRefreshIdentity={remintIdentity} />
    </SettingsScreen>
  );
}
