import {ArrowPathIcon, ArrowTopRightOnSquareIcon, PlusIcon} from '@heroicons/react/24/outline';
import {CheckIcon} from '@radix-ui/react-icons';
import {Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {SettingsSection} from '@/components/settings/primitives';
import {initialsOf, monogramHue} from '@/components/ProfileAvatar';
import {cn} from '@/lib/utils';
import {useAccount, useConfirm, usePlatformCapabilities, useTranslation, type AccountStatus, type ConnectedAccount} from '@/providers';

/**
 * The multi-account switcher (OB-206): lists every connected account, marks the
 * active one with a live status, and lets the user switch between them, add
 * another, remove one, or sign the active one out — all over the `useAccount()`
 * actions (the provider owns the logic; this is the surface). The single active
 * account's sync details and dashboard link sit below the list.
 *
 * Per Devon's OB-194 note the dormant accounts read as "Signed in" (available),
 * never "syncing": only the active account talks to the server, so only it shows
 * a live status.
 */
export default function AccountSwitcher() {
  const {t} = useTranslation();
  const {
    accounts,
    activeAccountId,
    status,
    lastSyncedAt,
    error,
    deviceName,
    accountUrl,
    setActiveAccount,
    addAccount,
    removeAccount,
    signOut,
    syncNow,
  } = useAccount();
  const platform = usePlatformCapabilities();
  const confirm = useConfirm();

  // Removing forgets the account on THIS device only (its token + entry), so it
  // gets the same confirm gate as every other destructive op. The copy names the
  // account and says re-signing-in restores it.
  const handleRemove = async (acc: ConnectedAccount): Promise<void> => {
    const ok = await confirm({
      title: t('account.switcher.removeConfirmTitle', {name: acc.name}),
      description: t('account.switcher.removeConfirmBody', {name: acc.name}),
      confirmText: t('common.remove'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (ok) removeAccount(acc.id);
  };

  const openExternal = (url: string): void => {
    if (platform.account?.openSignIn) platform.account.openSignIn(url);
    else if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
  };

  const lastSynced = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : t('account.signin.never');
  const multiple = accounts.length > 1;

  return (
    <>
      <SettingsSection title={t('account.switcher.heading')}>
        <ul className="flex flex-col gap-1.5">
          {accounts.map((acc) => {
            const active = acc.id === activeAccountId;
            return (
              <li
                key={acc.id}
                data-account-id={acc.id}
                data-active={active ? 'true' : 'false'}
                className={cn(
                  'group flex items-center gap-3 rounded-lg border p-3 transition-colors',
                  active ? 'border-brand/40 bg-brand/5' : 'border-border',
                )}
              >
                <button
                  type="button"
                  // The active row's button is a no-op (you're already on it); mark it
                  // aria-disabled and skip the redundant re-activate call.
                  onClick={() => {
                    if (!active) setActiveAccount(acc.id);
                  }}
                  aria-current={active ? 'true' : undefined}
                  aria-disabled={active ? 'true' : undefined}
                  aria-label={active ? acc.name : t('account.switcher.switchTo', {name: acc.name})}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-3 text-left outline-hidden',
                    !active && 'cursor-pointer',
                  )}
                >
                  <AccountMonogram seed={acc.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{acc.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{accountHost(acc.accountUrl)}</span>
                  </span>
                  <StatusPill active={active} status={acc.status} />
                  {active && <CheckIcon className="h-4 w-4 shrink-0 text-brand" />}
                </button>
                {/* Only dormant rows get a trash: the active account is forgotten
                    via its "Sign out" below, so a remove here would be redundant. */}
                {!active && (
                  <button
                    type="button"
                    aria-label={t('account.switcher.removeAccount', {name: acc.name})}
                    title={t('common.remove')}
                    onClick={() => void handleRemove(acc)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-hover hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <Button variant="outline" size="sm" className="self-start" onClick={addAccount}>
          <PlusIcon className="h-4 w-4" />
          {t('account.switcher.addAnother')}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </SettingsSection>

      <SettingsSection title={t('account.switcher.activeAccount')}>
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('account.signin.connectedAs')}</dt>
            <dd className="truncate font-medium">{deviceName}</dd>
            <dt className="text-muted-foreground">{t('account.signin.lastSynced')}</dt>
            <dd className="font-medium">{lastSynced}</dd>
          </dl>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={syncNow} disabled={status === 'syncing'}>
              <ArrowPathIcon className="h-4 w-4" />
              {t('account.signin.syncNow')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openExternal(`${accountUrl}/dashboard`)}>
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
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
        <p className="text-xs text-muted-foreground">
          {multiple ? t('account.switcher.signOutActiveHint') : t('account.signin.signOutHint')}
        </p>
      </SettingsSection>
    </>
  );
}

/** A round monogram for an account, tinted by a hue stable for its label. */
function AccountMonogram({seed}: {seed: string}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        monogramHue(seed),
      )}
    >
      {initialsOf(seed) || '?'}
    </span>
  );
}

/**
 * The right-aligned status chip. The ACTIVE account reflects its live sync
 * status (syncing / needs attention / active); every other account is dormant
 * and reads as "Signed in" — it isn't talking to the server, so it never shows a
 * spinner or an error of its own.
 */
function StatusPill({active, status}: {active: boolean; status: AccountStatus}) {
  const {t} = useTranslation();
  if (!active) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        {t('account.switcher.dormant')}
      </span>
    );
  }
  const tone: Record<'syncing' | 'error' | 'live', {dot: string; text: string; label: string}> = {
    syncing: {dot: 'bg-amber-500 animate-pulse', text: 'text-amber-600 dark:text-amber-400', label: t('account.switcher.syncing')},
    error: {dot: 'bg-destructive', text: 'text-destructive', label: t('account.switcher.error')},
    live: {dot: 'bg-brand', text: 'text-brand', label: t('account.switcher.active')},
  };
  const key: 'syncing' | 'error' | 'live' =
    status === 'syncing' || status === 'connecting' ? 'syncing' : status === 'error' ? 'error' : 'live';
  const {dot, text, label} = tone[key];
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-xs font-medium', text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}

/** A readable host label for an account's service URL (e.g. `account.book.pub`). */
function accountHost(url: ConnectedAccount['accountUrl']): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}
