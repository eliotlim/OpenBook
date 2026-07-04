import {useEffect, useState} from 'react';
import {useOptionalData} from '../data/DataProvider';
import {useOptionalAccount} from './AccountProvider';
import {useTranslation} from './I18nProvider';
import {usePreferences, type ProfilePreferences} from './PreferencesProvider';

/**
 * The current user's identity for the profile chrome (sidebar footer, settings
 * chip, avatar). Resolves in order:
 *   1. the locally-edited profile name (display name, then name);
 *   2. the signed-in account in *this* app — its active persona email/name;
 *   3. the identity the *server* resolved for this request — on a forwarded
 *      `*.book.cloud` site the edge injects the signed viewer principal, so the
 *      server knows who you are even when this origin's local account store is
 *      empty (account tokens are namespaced per origin);
 *   4. "Anonymous", only when none of the above exists.
 *
 * The account / server fallbacks are what make a signed-in session — including
 * one viewing a forwarded instance — show *who you are* instead of the empty
 * local default of "Anonymous".
 *
 * `profile` is the local profile with its `name` seeded from the resolved
 * identity when empty, so {@link ProfileAvatar}'s initials/monogram fall back to
 * it too (not the "Anonymous" letter). The avatar component stays pure — it
 * renders whatever profile it's handed — so it can still show other people.
 */
export function useSelfIdentity(): {name: string; profile: ProfilePreferences} {
  const {t} = useTranslation();
  const {profile} = usePreferences().preferences;
  // Read the account / data contexts optionally so this display-only hook renders
  // in reduced harnesses (unit tests, previews) without an <AccountProvider> /
  // <DataProvider>; the real app always supplies both.
  const accountCtx = useOptionalAccount();
  const data = useOptionalData();

  const account = accountCtx?.accounts.find((a) => a.id === accountCtx.activeAccountId);
  const accountLabel = (account?.name ?? account?.email ?? '').trim();
  const localName = profile.displayName.trim() || profile.name.trim();

  // Only ask the server who we are when we'd otherwise fall through to
  // "Anonymous" — a user with a local name or a connected account needs no probe.
  const needServer = !localName && !accountLabel && !!data;
  const [serverName, setServerName] = useState<string | null>(null);
  useEffect(() => {
    if (!needServer || !data) {
      setServerName(null);
      return;
    }
    let cancelled = false;
    void data
      .getInstanceInfo()
      .then((info) => {
        if (cancelled) return;
        const you = info.you;
        // Only a *verified remote* identity (a signed JWS — e.g. the viewer
        // principal the forwarding edge injects) is a real name to show. Guests
        // carry no meaningful name, and the loopback owner (`verifiedVia: 'local'`,
        // the in-browser / desktop store) is a placeholder "Local" that must NOT
        // override the "Anonymous" default on the standalone app.
        if (you && you.kind === 'user' && you.verifiedVia === 'jws')
          setServerName(you.name?.trim() || you.email?.trim() || null);
      })
      .catch(() => {
        // A legacy/unreachable server just leaves us at the "Anonymous" fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [needServer, data]);

  const resolved = accountLabel || serverName || '';
  const name = localName || resolved || t('profile.anonymous');
  // Only substitute the resolved label into the avatar seed when there's no local
  // name AND a resolved identity to use — otherwise keep the profile untouched.
  const effectiveProfile = !localName && resolved ? {...profile, name: resolved} : profile;
  return {name, profile: effectiveProfile};
}
