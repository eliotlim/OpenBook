import {useEffect, useState} from 'react';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {Button} from '@/components/ui/button';
import {useAccount, useHud, usePlatformCapabilities, useTheme, useTranslation} from '@/providers';

/** Persisted so a dismissal sticks across reloads (and never nags again). */
const DISMISS_KEY = 'openbook.onboarding.publishNudge';

/**
 * A tasteful, dismissible "sign up free to publish" prompt for the genuinely
 * unauthenticated user — the on-ramp from local-first into a first publish
 * (OB-206). It sits at the foot of the sidebar and only ever appears when no
 * account is connected; signing in (or dismissing it) retires it for good. We
 * never force it: local-first stays the default, this is just the door.
 *
 * The CTA opens Settings → Account, where the actual sign-in / add-account flow
 * lives, rather than firing the OAuth popup straight from the sidebar.
 */
export default function OnboardingNudge() {
  const {t} = useTranslation();
  const {connected, accounts} = useAccount();
  const {servedSameOrigin} = usePlatformCapabilities();
  const {setHud} = useHud();
  const {appearance} = useTheme();
  // Hidden until we've read storage on the client, so the server-rendered HTML
  // (which can't see localStorage) and the first client render agree — no
  // hydration mismatch (see I18nProvider for the same SSR tradeoff).
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);

  // Only nudge a truly unauthenticated user: no live account, none stored.
  // Never on the sidecar-served LAN UI (STAB-9): its CTA opens a sign-in that
  // can't complete over a plain-LAN origin (insecure context → identity JWS
  // won't bind), so the whole upsell is a dead end for a network guest.
  if (dismissed || connected || accounts.length > 0 || servedSameOrigin) return null;

  const dismiss = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore (private mode / quota) */
    }
  };

  const openSignIn = (): void =>
    setHud((draft) => {
      draft.settings.open = true;
      draft.settings.tab = 'signin';
      return draft;
    });

  return (
    <div
      data-onboarding-nudge
      className="relative mx-2 mb-1.5 mt-1.5 rounded-lg border border-border bg-sheet-1 p-3 text-sheet-1-foreground"
    >
      <button
        type="button"
        aria-label={t('account.nudge.dismiss')}
        title={t('account.nudge.dismiss')}
        onClick={dismiss}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
      <p className="pr-6 text-sm font-semibold">{t('account.nudge.title')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('account.nudge.body')}</p>
      {/* CTA fill is mode-aware: on the tinted default the primary (blue) pops on
          the pale sheet; on the full-accent sidebar a primary-blue fill barely
          separates from the blue surface (OB-377), so a light neutral `secondary`
          chip reads instead (it keeps its own surface + ink under the sheet). */}
      <Button
        variant={appearance.sidebar === 'accent' ? 'secondary' : 'default'}
        size="sm"
        className="mt-2.5 w-full"
        onClick={openSignIn}
      >
        {t('account.nudge.cta')}
      </Button>
    </div>
  );
}
