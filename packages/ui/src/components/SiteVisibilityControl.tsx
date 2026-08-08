import {useCallback, useEffect, useState} from 'react';
import type {SiteVisibility} from '@book.dev/sdk';
import {useData} from '@/data';
import {Select} from '@/components/ui/select';
import {useForwarding, useOptionalAccount, usePlatformCapabilities, useTranslation} from '@/providers';
import type {TKey} from '@/i18n';

/**
 * "Who can open this address" (SHR-8 / GATE-5). The published *.book.cloud address
 * carries its OWN audience scope on the account, separate from any per-page
 * visibility. Two scopes admit signed-out visitors at the edge:
 *
 *   - `published` ("Only published pages") — the RECOMMENDED default for a new
 *     site. Anonymous traffic is admitted, but the origin exposes only pages whose
 *     visibility resolves to `public`; everything else 404s (fail-safe). So a page
 *     you publish is reachable at the address while the rest of the library stays
 *     private — no whole-library exposure.
 *   - `public` — the whole library is anonymous-readable.
 *
 * `restricted` ("Private") keeps the address closed to signed-out visitors
 * entirely. This control sets those three through the owner-only account route
 * (`PATCH /api/sites/:id`, whitelist-validated + ownership-enforced server-side).
 * It renders only while THIS device is actually publishing and the real scope has
 * loaded — so it's inherently the site owner, and never shows a stale value.
 *
 * The account/edge also honor `authenticated`/`members` scopes, which this desktop
 * control deliberately does not *set* (a ternary picker can't express them
 * honestly, and changing would collapse the scope to `restricted`, lossy). If the
 * account already carries a site at one of those, it renders instead as a
 * read-only, honest informational row (disabled control, accurate hint, "manage on
 * the web" pointer).
 */

/** The three scopes this control sets, in ascending openness. */
const SETTABLE: readonly SiteVisibility[] = ['restricted', 'published', 'public'];

/** The per-scope hint shown beneath the picker. */
const SCOPE_HINT: Record<'restricted' | 'published' | 'public', TKey> = {
  restricted: 'forwarding.visibility.privateHint',
  published: 'forwarding.visibility.publishedHint',
  public: 'forwarding.visibility.publicHint',
};

export function SiteVisibilityControl() {
  const {t} = useTranslation();
  const client = useData();
  const {publishedHost, siteVisibility, siteVisibilityBusy, setSiteVisibility} = useForwarding();

  // The instance guest gate. A `published`/`public` address admits anonymous
  // traffic at the edge, but the origin still denies a guest READ when the guest
  // gate is `off` — so a published page would 404 for signed-out visitors despite
  // the address being open. Surface that caveat when the combination holds.
  const [guestOff, setGuestOff] = useState(false);
  useEffect(() => {
    if (!publishedHost) return;
    let live = true;
    client
      .getInstanceInfo()
      .then((info) => live && setGuestOff(info.guestAccess === 'off'))
      .catch(() => {
        /* leave the caveat hidden — the picker still works */
      });
    return () => {
      live = false;
    };
  }, [client, publishedHost]);

  const changeVisibility = useCallback(
    (next: SiteVisibility) => {
      if (next === siteVisibility) return; // no-op re-selection is never a write
      void setSiteVisibility(next);
    },
    [siteVisibility, setSiteVisibility],
  );

  if (!publishedHost || !siteVisibility) return null;

  // Not one of the three scopes this control sets (`authenticated`/`members`):
  // show it honestly, read-only, so we neither under-state the exposure nor let a
  // change collapse it to `restricted`.
  if (!SETTABLE.includes(siteVisibility)) {
    return <NonBinarySiteVisibilityRow visibility={siteVisibility as 'authenticated' | 'members'} />;
  }

  const scope = siteVisibility as 'restricted' | 'published' | 'public';
  // A `published`/`public` address that still can't serve a signed-out visitor
  // because the guest gate is closed — the one caveat the productized publish flow
  // can't silently paper over.
  const showGuestCaveat = guestOff && (scope === 'published' || scope === 'public');

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t('forwarding.visibility.label')}</span>
        <span className="text-xs text-muted-foreground">{t(SCOPE_HINT[scope])}</span>
      </div>
      <Select
        aria-label={t('forwarding.visibility.label')}
        value={scope}
        disabled={siteVisibilityBusy}
        wrapperClassName="w-full"
        onChange={(e) => changeVisibility(e.target.value as SiteVisibility)}
      >
        <option value="restricted">{t('forwarding.visibility.private')}</option>
        <option value="published">{t('forwarding.visibility.publishedOption')}</option>
        <option value="public">{t('forwarding.visibility.public')}</option>
      </Select>
      {showGuestCaveat && (
        <p
          aria-live="polite"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
        >
          {/* Point at the fix that matches the INTENT of the chosen scope: a
              `published` address needs per-page publishing turned on, a `public`
              one needs whole-library viewing. One generic string could only be
              right for one of them. */}
          {t(scope === 'public' ? 'forwarding.visibility.guestOffCaveatPublic' : 'forwarding.visibility.guestOffCaveat')}
        </p>
      )}
    </div>
  );
}

/**
 * The read-only, honest row for a site parked at `authenticated`/`members` — scopes
 * this desktop control doesn't set. Renders the ACCURATE exposure (any signed-in
 * user, or the whole roster — not "Private"), a disabled control that can't collapse
 * the scope, and a pointer to change it where it's actually managed (the account
 * dashboard).
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
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t('forwarding.visibility.label')}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </div>
      {/* Disabled: this scope isn't one the control sets, so it must not be
          changeable here (a change would collapse it to `restricted`). */}
      <Select
        aria-label={t('forwarding.visibility.label')}
        value={visibility}
        disabled
        wrapperClassName="w-full"
        onChange={() => undefined}
      >
        <option value={visibility}>{stateLabel}</option>
      </Select>
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
