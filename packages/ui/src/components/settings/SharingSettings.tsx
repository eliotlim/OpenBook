import {useCallback, useEffect, useState} from 'react';
import type {EffectiveVisibility, GuestAccess, InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data/DataProvider';
import {useTranslation} from '@/providers';
import {Select} from '@/components/ui/select';
import {cleanError, isInstanceOwner} from '@/components/settings/adminGate';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';
import type {TKey} from '@/i18n';

/**
 * The four consolidated "Default access" states (SHR-7; PUB-1 added `published`).
 * One control replaces the raw guest-gate select: each state is a faithful
 * rendering of the existing `(defaultVisibility, guestAccess)` config pair — it
 * introduces NO new config surface, it just presents the two fields as one
 * plain-language choice. Ordered by ascending openness, matching the address-level
 * picker (`SiteVisibilityControl`), which already speaks the same three-plus-one
 * vocabulary (Private → only published pages → Public).
 */
export type DefaultAccess =
  /** Members only — guests denied, new pages private. */
  | 'private'
  /**
   * Per-page publishing (PUB-1): guests may read, but only the pages the owner
   * EXPLICITLY publishes (`visibility='public'`) — everything else inherits
   * `members` and 404s. The pair a freshly-claimed instance already bootstraps to,
   * which before PUB-1 had no honest rendering in this control.
   */
  | 'published'
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
 *  - `private`   → guest gate closed + new pages members-only.
 *  - `published` → guests may read + new pages members-only (so only an
 *                  explicitly-published page is reachable).
 *  - `view`      → guests may read + new pages public.
 *  - `edit`      → guests may read+write + new pages public.
 *
 * The two fields are INDEPENDENT, so all four pairs are distinct and writable —
 * `published` is not a new degree of freedom, it's the pair the control used to
 * be unable to name.
 */
export function accessStatePolicy(state: DefaultAccess): {
  defaultVisibility: EffectiveVisibility;
  guestAccess: GuestAccess;
} {
  switch (state) {
  case 'private':
    return {defaultVisibility: 'members', guestAccess: 'off'};
  case 'published':
    return {defaultVisibility: 'members', guestAccess: 'read'};
  case 'view':
    return {defaultVisibility: 'public', guestAccess: 'read'};
  case 'edit':
    return {defaultVisibility: 'public', guestAccess: 'write'};
  }
}

/**
 * Which of the four states the CURRENT config renders as — a TOTAL function of
 * BOTH fields (PUB-1; it used to key on `guestAccess` alone, which made
 * `(members, read)` — the freshly-claimed bootstrap — render as the false "Anyone
 * can view"). Read it as "what can a signed-out visitor actually do?":
 *
 *  - `guestAccess:'off'`   → nothing; every anonymous read 404s regardless of
 *    `defaultVisibility` (the guest gate is a hard floor) ⇒ `private`.
 *  - `guestAccess:'write'` → read+write whatever they can see ⇒ `edit`. Keyed on
 *    the gate alone on purpose: an *unclaimed* instance short-circuits at
 *    authorize rule 0 with `defaultVisibility` dormant, so the shipped default
 *    (`guestAccess:'write'`, `defaultVisibility:'members'`) must still render as
 *    "Anyone can edit" — the widest honest reading — and never move the default.
 *  - `guestAccess:'read'`  → the whole library only when `inherit` resolves to
 *    `public`; otherwise just the explicitly-published pages ⇒ `published`.
 *
 * `defaultVisibility` absent/null (a pre-SHR-6 server or a test fixture) reads as
 * `published`, matching what that server itself does: it resolves `inherit` with
 * its own `?? 'members'` fallback.
 *
 * `defaultVisibility` also admits `authenticated` / `restricted`, which this
 * four-state control cannot *write*. Both are read as `published` — honest from a
 * signed-out visitor's seat (neither admits them to an `inherit` page) — and the
 * idempotence guard in {@link SharingSection} keeps a no-op re-selection from
 * quietly rewriting them to `members`, the same "don't collapse what you can't
 * express" rule `SiteVisibilityControl` follows for those scopes.
 */
export function accessStateFromConfig(config: {
  guestAccess: GuestAccess;
  defaultVisibility?: EffectiveVisibility | null;
}): DefaultAccess {
  switch (config.guestAccess) {
  case 'off':
    return 'private';
  case 'write':
    return 'edit';
  case 'read':
    return config.defaultVisibility === 'public' ? 'view' : 'published';
  }
}

/** The plain-language one-liner shown beneath the picker for the current state. */
const ACCESS_HINT: Record<DefaultAccess, TKey> = {
  private: 'sharing.accessPrivateHint',
  published: 'sharing.accessPublishedHint',
  view: 'sharing.accessViewHint',
  edit: 'sharing.accessEditHint',
};

/** Ties the live hint to the picker for assistive tech (`aria-describedby`). */
const ACCESS_HINT_ID = 'default-access-hint';
const OWNER_LOCKED_ID = 'default-access-owner-locked';

/**
 * The honest description for `state` under `info` — the base one-liner plus any
 * caveat the four-state mapping would otherwise paper over.
 *
 * Three cases where the plain hint alone would MIS-state the real exposure:
 *
 *  1. UNCLAIMED + `published` (Sasha M-1). `authorize()` rule 0 short-circuits an
 *     unclaimed instance on the guest gate ALONE — `defaultVisibility` is dormant,
 *     so "only the pages you publish" is not yet true: everyone who can reach the
 *     instance reads everything. The mapping stays as-is (rule 0 also means the
 *     control must not move the default), so we disclose instead.
 *  2. `defaultVisibility:'authenticated'` (Sasha L-1) reads as `published` because a
 *     signed-out visitor genuinely sees only published pages — but any signed-in
 *     stranger also reads the unpublished ones. The privacy claim needs the rider.
 *  3. CLAIMED + `edit` (Sasha L-2). Post-claim `canWrite` never consults
 *     `guestAccess` (authorize.ts: `isLocal || isOwner || acl==='write' || isAdmin`),
 *     so "visitors can change every page" is simply false once claimed. Swap the
 *     line rather than append — appending would contradict its own first sentence.
 *
 * `claimed === undefined` (a pre-PUB-1 server) means we don't KNOW the claim state,
 * so both claim-dependent branches stay silent rather than guess.
 */
export function accessStateDescription(
  state: DefaultAccess,
  info: Pick<InstanceInfo, 'claimed' | 'defaultVisibility'>,
): {hint: TKey; caveat: TKey | null} {
  if (state === 'edit' && info.claimed === true) {
    return {hint: 'sharing.accessEditHintClaimed', caveat: null};
  }
  const hint = ACCESS_HINT[state];
  if (state === 'published' && info.claimed === false) return {hint, caveat: 'sharing.accessUnclaimedCaveat'};
  if (state === 'published' && info.defaultVisibility === 'authenticated') {
    return {hint, caveat: 'sharing.accessAuthenticatedCaveat'};
  }
  return {hint, caveat: null};
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
      // Re-selecting the ALREADY-DISPLAYED state is a true no-op — never a write.
      // The house rule for every settings picker (`AgentEditsSettings`,
      // `SiteVisibilityControl`), and load-bearing for the two config values this
      // four-state control can't express: `defaultVisibility:'authenticated'` /
      // `'restricted'` both READ as their nearest honest state, so without this a
      // visually no-op click would silently rewrite them to `members`. It also
      // keeps the shipped pre-claim default `(members, write)` — read as `edit` —
      // from being widened to `(public, write)`, which would survive the claim as
      // `(public, read)` and make every `inherit` page world-readable.
      //
      // What this used to guard against is GONE: detection is now total over both
      // fields, so `(members, read)` renders as its own `published` state instead
      // of masquerading as `view`. Every state is now reachable from every other.
      if (!info || state === accessStateFromConfig(info)) return;
      setBusy(true);
      setError(null);
      try {
        await client.setInstancePolicy(accessStatePolicy(state));
        refresh();
      } catch (e) {
        setError(cleanError(e, t('share.error.generic')));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, info, t],
  );

  if (unavailable || !info) return null;

  const isOwner = isInstanceOwner(info);
  const you = info.you;
  const youLine =
    you.kind === 'user'
      ? t('sharing.youUser', {name: you.name || you.subject})
      : you.name
        ? t('sharing.youGuestNamed', {name: you.name})
        : t('sharing.youGuestAnon');
  const state = accessStateFromConfig(info);
  const {hint, caveat} = accessStateDescription(state, info);

  return (
    <SettingsSection title={t('sharing.title')} description={t('sharing.description')}>
      <p className="text-sm text-muted-foreground">{youLine}</p>
      <SettingsField label={t('sharing.defaultAccess')} hint={t('sharing.defaultAccessHint')}>
        <Select
          inputSize="sm"
          value={state}
          wrapperClassName="w-full max-w-[280px]"
          aria-label={t('sharing.defaultAccess')}
          aria-describedby={isOwner ? ACCESS_HINT_ID : `${ACCESS_HINT_ID} ${OWNER_LOCKED_ID}`}
          disabled={busy || !isOwner}
          onChange={(e) => void changeAccess(e.target.value as DefaultAccess)}
        >
          <option value="private">{t('sharing.accessPrivate')}</option>
          <option value="published">{t('sharing.accessPublished')}</option>
          <option value="view">{t('sharing.accessView')}</option>
          <option value="edit">{t('sharing.accessEdit')}</option>
        </Select>
        {/* The honest one-liner for whatever is CURRENTLY selected. Four states that
            differ only in who sees what can't be told apart by their labels alone.
            `SiteVisibilityControl.SCOPE_HINT` is the precedent for the per-state
            hint MECHANISM, not for its placement: this one sits BELOW the picker on
            purpose, because it changes as you browse the options and a description
            that reflows above the control you're operating shifts it under the
            pointer. `aria-live` announces the swap; `aria-describedby` (above) makes
            it the picker's description so it is read on focus, not just on change. */}
        <p id={ACCESS_HINT_ID} aria-live="polite" className="mt-1.5 text-xs text-muted-foreground">
          {t(hint)}
          {caveat && (
            // Amber, not muted: these are the cases where the state's own
            // description would over-state privacy or over-claim what visitors can
            // do (see `accessStateDescription`). Same treatment as the address-level
            // guest-gate caveat so "read this one twice" looks the same app-wide.
            <span className="mt-1.5 block rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-foreground">
              {t(caveat)}
            </span>
          )}
        </p>
      </SettingsField>
      {!isOwner && (
        <p id={OWNER_LOCKED_ID} className="text-xs text-muted-foreground">
          {t('sharing.ownerLocked')}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{t('sharing.saveError', {error})}</p>}
    </SettingsSection>
  );
}
