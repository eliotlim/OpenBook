import {useCallback, useEffect, useState} from 'react';
import type {GuestAccess, InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data/DataProvider';
import {useTranslation} from '@/providers';
import {Select} from '@/components/ui/select';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';

/**
 * Multi-user access policy (OB-165): who can read/edit this shared workspace
 * without signing in, plus who the server currently sees *you* as. Reads the
 * instance policy from the data server and lets the owner change the guest gate.
 *
 * Hidden when the server doesn't expose `/api/instance` (an older build), so it
 * degrades cleanly against a server that predates multi-user support.
 */
export function SharingSection() {
  const client = useData();
  const {t} = useTranslation();
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .getInstanceInfo()
      .then(setInfo)
      .catch(() => setUnavailable(true));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const changeGuestAccess = useCallback(
    async (guestAccess: GuestAccess) => {
      setBusy(true);
      setError(null);
      try {
        await client.setInstancePolicy({guestAccess});
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  if (unavailable || !info) return null;

  // No claimed owner yet → anyone may set the policy (the first user claims the
  // workspace); once claimed, only that owner.
  const isOwner = !info.ownerSubject || info.ownerSubject === info.you.subject;
  const you = info.you;
  const youLine =
    you.kind === 'user'
      ? t('sharing.youUser', {name: you.name || you.subject})
      : you.name
        ? t('sharing.youGuestNamed', {name: you.name})
        : t('sharing.youGuestAnon');

  return (
    <SettingsSection title={t('sharing.title')} description={t('sharing.description')}>
      <p className="text-sm text-muted-foreground">{youLine}</p>
      <SettingsField label={t('sharing.guestAccess')} hint={t('sharing.guestAccessHint')}>
        <Select
          value={info.guestAccess}
          wrapperClassName="w-[200px]"
          disabled={busy || !isOwner}
          onChange={(e) => void changeGuestAccess(e.target.value as GuestAccess)}
        >
          <option value="write">{t('sharing.guestWrite')}</option>
          <option value="read">{t('sharing.guestRead')}</option>
          <option value="off">{t('sharing.guestOff')}</option>
        </Select>
      </SettingsField>
      {!isOwner && <p className="text-xs text-muted-foreground">{t('sharing.ownerLocked')}</p>}
      {error && <p className="text-sm text-destructive">{t('sharing.saveError', {error})}</p>}
    </SettingsSection>
  );
}
