import {useEffect, useRef} from 'react';
import {useRouter} from 'next/router';
import {isSettingsTab, useHud, type HudProps} from '@open-book/ui';

// Settings state lives in the URL as `?settings=<tab>` so it can be shared,
// bookmarked, and restored on reload. Presence of the param means "open"; its
// value selects the active panel.
const SETTINGS_PARAM = 'settings';

const readParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Two-way binding between `hud.settings` and the address bar (web only). Lives
 * in the web shell rather than `@open-book/ui` so the shared library stays free
 * of any Next.js routing dependency.
 *
 * The two effects are deliberately scoped so they can't echo each other into a
 * loop: URL->HUD runs only when the URL's settings param changes, HUD->URL runs
 * only when the HUD open/tab values change. The HUD->URL effect reaches the
 * router through a ref so a navigation alone never re-triggers it with a stale
 * `open` (which is what made Back re-push the param and leave settings stuck
 * open).
 */
export default function SettingsDeepLink() {
  const router = useRouter();
  const {hud, setHud} = useHud();
  const {open, tab} = hud.settings;

  const routerRef = useRef(router);
  routerRef.current = router;

  const param = readParam(router.query[SETTINGS_PARAM]);

  // URL -> HUD. The address bar is the source of truth here, so a fresh load or
  // a back/forward navigation drives whether settings are open and which tab.
  useEffect(() => {
    if (!router.isReady) return;
    setHud((draft: HudProps) => {
      draft.settings.open = param !== undefined;
      if (isSettingsTab(param)) draft.settings.tab = param;
      return draft;
    });
  }, [router.isReady, param, setHud]);

  // HUD -> URL. Reflect open/close and tab changes back into a shareable link.
  // Opening pushes a history entry (so Back closes settings); everything else
  // replaces in place to avoid cluttering history while switching tabs.
  useEffect(() => {
    const r = routerRef.current;
    if (!r.isReady) return;
    const current = readParam(r.query[SETTINGS_PARAM]);
    const desired = open ? tab : undefined;
    if (current === desired) return;

    const query = {...r.query};
    if (desired === undefined) delete query[SETTINGS_PARAM];
    else query[SETTINGS_PARAM] = desired;

    const url = {pathname: r.pathname, query};
    const opts = {shallow: true, scroll: false};
    const opening = current === undefined && desired !== undefined;
    void (opening ? r.push(url, undefined, opts) : r.replace(url, undefined, opts));
  }, [open, tab]);

  return null;
}
