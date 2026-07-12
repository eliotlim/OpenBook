import {Switch} from '@/components/ui/switch';
import {useForwarding, useTranslation} from '@/providers';

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
 * value. The toggle is deliberately binary (Public ↔ Private=`restricted`), matching
 * how the edge coarsens every non-`public` scope down to "private" anyway.
 */
export function SiteVisibilityControl() {
  const {t} = useTranslation();
  const {publishedHost, siteVisibility, siteVisibilityBusy, setSiteVisibility} = useForwarding();
  if (!publishedHost || !siteVisibility) return null;
  const isPublic = siteVisibility === 'public';
  return (
    <label className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{t('forwarding.visibility.label')}</span>
        <span className="text-xs text-muted-foreground">
          {t(isPublic ? 'forwarding.visibility.publicHint' : 'forwarding.visibility.privateHint')}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium">
          {t(isPublic ? 'forwarding.visibility.public' : 'forwarding.visibility.private')}
        </span>
        <Switch
          checked={isPublic}
          disabled={siteVisibilityBusy}
          aria-label={t('forwarding.visibility.label')}
          onCheckedChange={(v) => void setSiteVisibility(v ? 'public' : 'restricted')}
        />
      </span>
    </label>
  );
}
