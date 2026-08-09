import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import AccountSwitcher from '@/components/settings/AccountSwitcher';
import {useAccount, useTranslation} from '@/providers';

/**
 * Account & sync: connect this device to account.book.pub (the deep-link OAuth
 * flow) and mirror preferences + the library list there. The data server is
 * untouched — only settings sync through the account service.
 *
 * With no account connected this is the sign-in surface; once at least one is
 * connected it hands off to {@link AccountSwitcher} — the multi-account list
 * (switch / add / remove / sign out) introduced in OB-206.
 */
export default function AccountSettings() {
  const {t} = useTranslation();
  const {status, accounts, error, signIn, submitCode, cancel, identityExpired, syncNow} = useAccount();

  return (
    <SettingsScreen title={t('account.signin.title')} description={t('account.signin.description')} scope="account">
      {/* A previously-verified identity lapsed and couldn't refresh — surface a
          non-blocking reconnect affordance rather than silently dropping the reader
          to anonymous behind blank content. `syncNow` re-activates the active
          account (reconcile + re-mint); a truly dead token then routes to sign-in. */}
      {identityExpired && accounts.length > 0 && (
        <SettingsSection>
          <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium">{t('account.reauth.title')}</p>
            <p className="text-sm text-muted-foreground">{t('account.reauth.body')}</p>
            <Button variant="outline" size="sm" onClick={syncNow}>
              {t('account.reauth.reconnect')}
            </Button>
          </div>
        </SettingsSection>
      )}
      {accounts.length === 0 ? (
        <SettingsSection>
          {status === 'connecting' ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground">{t('account.signin.connecting')}</p>
              <Button variant="ghost" size="sm" onClick={cancel}>
                {t('account.signin.cancel')}
              </Button>
            </div>
          ) : (
            <Button variant="outline" className="w-full truncate sm:w-auto" onClick={signIn}>
              {t('account.signin.signInButton')}
            </Button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <ManualCodeEntry onSubmit={submitCode} />
          <p className="text-xs text-muted-foreground">{t('account.signin.whatSyncs')}</p>
        </SettingsSection>
      ) : (
        <AccountSwitcher />
      )}
    </SettingsScreen>
  );
}

/**
 * A fallback for when the `openbook://` deep link can't complete the sign-in
 * (e.g. unsigned dev builds, where macOS shows an "open app?" prompt the user
 * dismisses): the user copies the code from the browser and pastes it here. The
 * field accepts a bare code or the whole `openbook://auth-callback#token=…` URL.
 * Kept understated since the deep link is the normal path.
 */
function ManualCodeEntry({onSubmit}: {onSubmit: (raw: string) => void}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {t('account.signin.manualToggle')}
      </button>
    );
  }

  const submit = (): void => {
    const v = code.trim();
    if (v) onSubmit(v);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">{t('account.signin.manualHint')}</p>
      <textarea
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={2}
        spellCheck={false}
        placeholder={t('account.signin.manualPlaceholder')}
        className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs outline-hidden placeholder:text-placeholder-foreground focus-visible:border-ring focus-visible:shadow-[var(--ring-field)]"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!code.trim()}>
          {t('account.signin.manualSubmit')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setCode('');
          }}
        >
          {t('account.signin.cancel')}
        </Button>
      </div>
    </div>
  );
}
