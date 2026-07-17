import {useCallback, useEffect, useState} from 'react';
import type {EffectiveVisibility, GuestAccess, InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data/DataProvider';
import {useTranslation} from '@/providers';
import {Select} from '@/components/ui/select';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';

/**
 * The three consolidated "Default access" states (SHR-7). One control replaces the
 * raw guest-gate select: each state is a faithful rendering of the existing
 * `(defaultVisibility, guestAccess)` config pair — it introduces NO new config
 * surface, it just presents the two fields as one plain-language choice.
 */
export type DefaultAccess =
  /** Members only — guests denied, new pages private. */
  | 'private'
  /** Anyone may read (but not edit) without signing in. */
  | 'view'
  /** Anyone may read and edit without signing in. */
  | 'edit';

/**
 * The `(defaultVisibility, guestAccess)` pair each state writes via
 * `setInstancePolicy`. A faithful mapping onto the two existing config fields:
 * `guestAccess` is the guest gate/floor, `defaultVisibility` is what a page's
 * `visibility='inherit'` resolves to at the root once the instance is claimed.
 *
 *  - `private` → guest gate closed + new pages members-only.
 *  - `view`    → guests may read + new pages public.
 *  - `edit`    → guests may read+write + new pages public.
 */
export function accessStatePolicy(state: DefaultAccess): {
  defaultVisibility: EffectiveVisibility;
  guestAccess: GuestAccess;
} {
  switch (state) {
  case 'private':
    return {defaultVisibility: 'members', guestAccess: 'off'};
  case 'view':
    return {defaultVisibility: 'public', guestAccess: 'read'};
  case 'edit':
    return {defaultVisibility: 'public', guestAccess: 'write'};
  }
}

/**
 * Which of the three states the CURRENT config renders as. Keyed on `guestAccess`
 * — the one field that governs an *unclaimed* instance's behaviour (the rule-0
 * short-circuit consults only the guest gate; `defaultVisibility` is dormant until
 * claim) and the guest floor once claimed. This makes the rendered state a total,
 * behaviour-faithful function of today's config, so a fresh (unclaimed) instance —
 * `guestAccess:'write'` — renders as "Anyone can edit" with no write of its own.
 */
export function accessStateFromGuest(guestAccess: GuestAccess): DefaultAccess {
  switch (guestAccess) {
  case 'off':
    return 'private';
  case 'read':
    return 'view';
  case 'write':
    return 'edit';
  }
}

/**
 * Multi-user access policy (OB-165): who can read/edit this shared library
 * without signing in, plus who the server currently sees *you* as. Reads the
 * instance policy from the data server and lets the owner change the default
 * access (SHR-7: one consolidated control over the guest gate + default
 * visibility).
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

  const changeAccess = useCallback(
    async (state: DefaultAccess) => {
      // Re-selecting the ALREADY-DISPLAYED state must be a true no-op — never a
      // write. The config→state mapping is lossy: a freshly-claimed instance
      // bootstraps to `(defaultVisibility:'members', guestAccess:'read')` which
      // renders as "Anyone can view", so writing its pair `(public, read)` would
      // flip defaultVisibility members→public and silently make every
      // `inherit`-visibility page world-readable — from a visually no-op click.
      // Guarding here closes that silent-widening path while preserving every
      // DELIBERATE change (a different displayed state still writes the full pair).
      if (!info || state === accessStateFromGuest(info.guestAccess)) return;
      setBusy(true);
      setError(null);
      try {
        await client.setInstancePolicy(accessStatePolicy(state));
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, info],
  );

  if (unavailable || !info) return null;

  // No claimed owner yet → anyone may set the policy (the first user claims the
  // library); once claimed, only that owner.
  const isOwner = !info.ownerSubject || info.ownerSubject === info.you.subject;
  const you = info.you;
  const youLine =
    you.kind === 'user'
      ? t('sharing.youUser', {name: you.name || you.subject})
      : you.name
        ? t('sharing.youGuestNamed', {name: you.name})
        : t('sharing.youGuestAnon');
  const state = accessStateFromGuest(info.guestAccess);

  return (
    <SettingsSection title={t('sharing.title')} description={t('sharing.description')}>
      <p className="text-sm text-muted-foreground">{youLine}</p>
      <SettingsField label={t('sharing.defaultAccess')} hint={t('sharing.defaultAccessHint')}>
        <Select
          value={state}
          wrapperClassName="w-[240px]"
          disabled={busy || !isOwner}
          onChange={(e) => void changeAccess(e.target.value as DefaultAccess)}
        >
          <option value="private">{t('sharing.accessPrivate')}</option>
          <option value="view">{t('sharing.accessView')}</option>
          <option value="edit">{t('sharing.accessEdit')}</option>
        </Select>
      </SettingsField>
      {!isOwner && <p className="text-xs text-muted-foreground">{t('sharing.ownerLocked')}</p>}
      {error && <p className="text-sm text-destructive">{t('sharing.saveError', {error})}</p>}
    </SettingsSection>
  );
}
