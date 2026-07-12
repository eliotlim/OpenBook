import {useCallback} from 'react';
import {Switch} from '@/components/ui/switch';
import {useForwarding, useOptionalAccount, usePlatformCapabilities, useTranslation} from '@/providers';

/**
 * "Published address: Private / Public" (SHR-8). The published *.book.cloud address
 * carries its OWN audience scope on the account, separate from any per-page
 * visibility — and it defaults to `restricted` (Private). The edge serves ONLY a
 * `public` address anonymously; every other scope keeps the address private, so
 * "anyone with the link" is a lie until the owner makes the ADDRESS public too.
 *
 * This flips that address-level scope through the existing owner-only account route
 * (`PATCH /api/sites/:id`, whitelist-validated + ownership-enforced server-side).
 * It renders only while THIS device is actually publishing and the real scope has
 * loaded — so it's inherently the site owner, and it never shows a stale/assumed
 * value.
 *
 * The shipping control only ever *sets* `public`/`restricted`; it deliberately does
 * not expose the `authenticated`/`members` scopes (which the account/edge honor
 * distinctly). So the toggle is binary ONLY for a site that's genuinely one of those
 * two. If the account already carries a site at `authenticated` or `members`, a binary
 * toggle would be dishonest — it would mislabel a scope that any signed-in stranger
 * (or the whole roster) can already read as "Private", and flipping it would collapse
 * the scope to `restricted` (lossy). Those two render instead as a read-only, honest
 * informational row (disabled toggle, accurate hint, "manage on the web" pointer).
 */
export function SiteVisibilityControl() {
  const {t} = useTranslation();
  const {publishedHost, siteVisibility, siteVisibilityBusy, setSiteVisibility} = useForwarding();
  if (!publishedHost || !siteVisibility) return null;

  // Not one of the two scopes this control sets: show it honestly, read-only, so we
  // neither under-state the exposure nor let a toggle collapse it to `restricted`.
  if (siteVisibility !== 'public' && siteVisibility !== 'restricted') {
    return <NonBinarySiteVisibilityRow visibility={siteVisibility} />;
  }

  const isPublic = siteVisibility === 'public';
  const stateLabel = t(isPublic ? 'forwarding.visibility.public' : 'forwarding.visibility.private');
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{t('forwarding.visibility.label')}</span>
        <span className="text-xs text-muted-foreground">
          {t(isPublic ? 'forwarding.visibility.publicHint' : 'forwarding.visibility.privateHint')}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium">{stateLabel}</span>
        <Switch
          checked={isPublic}
          disabled={siteVisibilityBusy}
          aria-label={`${t('forwarding.visibility.label')} — ${stateLabel}`}
          onCheckedChange={(v) => void setSiteVisibility(v ? 'public' : 'restricted')}
        />
      </span>
    </label>
  );
}

/**
 * The read-only, honest row for a site parked at `authenticated`/`members` — scopes
 * this desktop control doesn't set. Renders the ACCURATE exposure (any signed-in user,
 * or the whole roster — not "Private"), a disabled toggle that can't collapse the
 * scope, and a pointer to change it where it's actually managed (the account dashboard).
 */
function NonBinarySiteVisibilityRow({visibility}: {visibility: 'authenticated' | 'members'}) {
  const {t} = useTranslation();
  const account = useOptionalAccount();
  const platform = usePlatformCapabilities();
  const dashboardUrl = account?.accountUrl ? `${account.accountUrl}/dashboard` : null;

  const openDashboard = useCallback(() => {
    if (!dashboardUrl) return;
    if (platform.account?.openSignIn) platform.account.openSignIn(dashboardUrl);
    else if (typeof window !== 'undefined') window.open(dashboardUrl, '_blank', 'noopener,noreferrer');
  }, [dashboardUrl, platform]);

  const stateLabel = t(`forwarding.visibility.${visibility}`);
  const hint = t(`forwarding.visibility.${visibility}Hint`);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t('forwarding.visibility.label')}</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-medium">{stateLabel}</span>
          {/* Disabled: this scope isn't a public/restricted binary, so it must not be
              flippable here (a flip would collapse it to `restricted`). */}
          <Switch checked={false} disabled aria-label={`${t('forwarding.visibility.label')} — ${stateLabel}`} />
        </span>
      </div>
      {dashboardUrl && (
        <button
          type="button"
          onClick={openDashboard}
          className="self-start text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
        >
          {t('forwarding.visibility.manageOnWeb')}
        </button>
      )}
    </div>
  );
}
