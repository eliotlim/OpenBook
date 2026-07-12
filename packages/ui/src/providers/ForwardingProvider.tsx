import React, {createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {ForwardingClient, setForwardingAudience, type SiteVisibility, type TunnelStatus} from '@book.dev/sdk';
import {useAccount} from './AccountProvider';
import {usePlatformLibrary} from './PlatformLibraryProvider';
import {
  ensureClaimedForForwarding,
  ensureForwardingAudience,
  unbindForwardingAudience,
  type AudienceBindDeps,
  type AudienceNoticeCode,
} from './forwardingAudience';
import {useData} from '@/data/DataProvider';
import {setShareLinkOrigin} from '@/lib/pageActions';
import {showToast} from '@/components/ui/toast';
import {t} from '@/i18n';

/**
 * Owns the *.book.pub forwarding tunnel for the whole app, so it keeps running
 * when the settings panel that toggled it closes, and resumes on launch. Only
 * active on the desktop (the platform supplies a keychain `KeyStore` + the IPC
 * `localFetch`); elsewhere it's inert (`supported: false`).
 *
 * Enabling runs `ForwardingClient.start()` — provision/reattach the site, then
 * open the reverse tunnel that serves the local data server over IPC (no port).
 * The on/off intent persists in localStorage so a relaunch re-dials automatically
 * once the account reconnects.
 */
const ENABLED_KEY = 'openbook.forwarding.enabled';

/**
 * How long a signed-out flip's auto-resume intent stays armed (P1-6). Bounds the
 * popup-abandon case where the account status can stick at `connecting` with no
 * callback ever arriving — after this the intent is dropped, so a much-later
 * unrelated sign-in can never silently complete the (irreversible) claim.
 */
const SIGN_IN_RESUME_TTL_MS = 3 * 60 * 1000;

/** Combined provisioning/tunnel status. `idle` = never started this session. */
export type ForwardingStatus = TunnelStatus | 'idle';

interface ForwardingContextValue {
  /** The host can forward (desktop with keychain + IPC fetch). */
  supported: boolean;
  /** The user's on/off intent (persisted). */
  enabled: boolean;
  /** Live tunnel status. */
  status: ForwardingStatus;
  /** The assigned `<prefix>.book.pub` host, once known. */
  host: string | null;
  /**
   * The host at which the workspace is *currently reachable* by others — the
   * assigned host, but only while publishing is enabled and the tunnel is
   * actually online; `null` otherwise. The single publish predicate behind
   * both the share-link origin registry and the Share dialog's link hint.
   */
  publishedHost: string | null;
  /**
   * The published site's real audience scope, read from the account (`SiteView.visibility`)
   * once the tunnel is online — `null` until loaded or when not published. A fresh
   * site is `restricted` by default, and the edge serves ONLY `public` anonymously, so
   * a page set "public" on a non-`public` address is still bounced for anyone not
   * signed in. Surfacing the REAL scope lets the UI say so honestly instead of implying
   * "anyone with the link" works when it doesn't.
   */
  siteVisibility: SiteVisibility | null;
  /** A {@link setSiteVisibility} PATCH is in flight. */
  siteVisibilityBusy: boolean;
  /**
   * Set the published site's audience scope via the existing account route
   * (`PATCH /api/sites/:id`, owner-only + whitelist-validated server-side). A no-op
   * when not published. The desktop only ever runs this on the owner's own device
   * under their device bearer token, so it can't widen anyone else's exposure.
   */
  setSiteVisibility: (v: SiteVisibility) => Promise<void>;
  busy: boolean;
  error: string | null;
  /**
   * A localizable audience-bind/unbind notice (OB-202), shown when the tunnel is up
   * but the audience hardening is incomplete (`partialUnscoped`/`ensureRescope`), a
   * bind step threw (`bindFailed`), or a disable couldn't confirm the relax
   * (`unbindHeld`). The view maps `code` to a `forwarding.*` string; `detail` is the
   * raw error for the `{error}` codes. `null` when there's nothing to show.
   */
  audienceNotice: {code: AudienceNoticeCode; detail?: string} | null;
  /**
   * Why a publish was refused before the tunnel opened, for localized + severity-aware
   * display: `unverified` is a precondition (the signed-in owner just needs a verified
   * identity — render it muted, like {@link signInHint}); `issuance-disabled` is that
   * precondition made terminal (the account server can't mint identities — 501 — so
   * don't offer the refresh affordance); `claim-failed` is a genuine failure (render
   * it as an error). `null` when there's nothing to show.
   */
  claimRefusal: 'unverified' | 'issuance-disabled' | 'claim-failed' | null;
  /**
   * A signed-out flip started the sign-in handoff and the enable will auto-resume
   * the moment the account connects (this session only — the intent is NOT
   * persisted, so an abandoned sign-in can never publish on a later launch). The
   * view renders an explicit "finish signing in" notice instead of letting the
   * toggle silently snap back.
   */
  signInPending: boolean;
  /** Turn forwarding on: claim the address (sign-in first if needed) + dial out. */
  enable: () => Promise<void>;
  /** Turn forwarding off: drop the tunnel but keep the site key (stable address). */
  disable: () => void;
}

const DEFAULT: ForwardingContextValue = {
  supported: false,
  enabled: false,
  status: 'idle',
  host: null,
  publishedHost: null,
  siteVisibility: null,
  siteVisibilityBusy: false,
  setSiteVisibility: async () => undefined,
  busy: false,
  error: null,
  audienceNotice: null,
  claimRefusal: null,
  signInPending: false,
  enable: async () => undefined,
  disable: () => undefined,
};

const ForwardingContext = createContext<ForwardingContextValue>(DEFAULT);

const readEnabled = (): boolean =>
  typeof localStorage !== 'undefined' && localStorage.getItem(ENABLED_KEY) === '1';
const writeEnabled = (on: boolean): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
};

export const ForwardingProvider: React.FC<PropsWithChildren> = ({children}) => {
  const {forwarding} = usePlatformLibrary();
  const {connected, token, accountUrl, status: accountStatus, signIn, remintIdentity, identityIssuance} =
    useAccount();
  const data = useData();
  const supported = !!forwarding;

  const clientRef = useRef<ForwardingClient | null>(null);
  // Synchronous re-entrancy latch: `clientRef` isn't set until AFTER the claim
  // `await` inside `startTunnel`, so two entry points firing in the same tick (an
  // explicit flip + the resume effect, or a StrictMode double-invoke) could both
  // pass the `!clientRef.current` gate and each perform the IRREVERSIBLE claim.
  // This closes the window before the first await; cleared in `startTunnel`'s finally.
  const startingRef = useRef(false);
  const [enabled, setEnabled] = useState<boolean>(() => readEnabled());
  const [status, setStatus] = useState<ForwardingStatus>('idle');
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audienceNotice, setAudienceNotice] = useState<{code: AudienceNoticeCode; detail?: string} | null>(null);
  const [claimRefusal, setClaimRefusal] = useState<'unverified' | 'issuance-disabled' | 'claim-failed' | null>(null);
  const [siteVisibility, setSiteVis] = useState<SiteVisibility | null>(null);
  const [siteVisibilityBusy, setSiteVisBusy] = useState(false);
  const [signInPending, setSignInPending] = useState(false);
  // The auto-resume (P1-6) can complete with Settings closed / off-screen, so flag
  // the resume so we can announce it with a toast once the address is live.
  const resumedRef = useRef(false);

  // The latest issuance verdict, read at claim time through a ref so the memoized
  // `audienceDeps` below stays stable across issuance state changes.
  const identityIssuanceRef = useRef(identityIssuance);
  identityIssuanceRef.current = identityIssuance;

  // Show the reserved address even before the tunnel connects.
  useEffect(() => {
    if (!forwarding) return;
    forwarding.keyStore
      .load()
      .then((id) => id && setHost(id.host))
      .catch(() => undefined);
  }, [forwarding]);

  // The side effects the audience-bind drives — the data-server policy writes
  // (`PUT /api/instance`), the owner-token re-mint, and the local scoping seam.
  // Bundled here so the orchestration (in `./forwardingAudience`) stays pure and
  // unit-tested without React.
  const audienceDeps = useMemo<AudienceBindDeps>(
    () => ({
      setInstancePolicy: (patch) => data.setInstancePolicy(patch),
      getInstanceInfo: () => data.getInstanceInfo(),
      remintIdentity: () => remintIdentity(),
      setLocalAudience: setForwardingAudience,
      identityIssuance: () => identityIssuanceRef.current,
    }),
    [data, remintIdentity],
  );

  // Bind the instance's identity audience to the canonical forwarded host (OB-202).
  // Once exposed, the edge mints aud-scoped viewer tokens for this host, so the
  // origin must accept that audience (and reject another site's — `requireAudience`,
  // fail-closed). The local owner reaches the SAME server over loopback with their
  // OWN token, so the bind is a seamless three-phase switch that proceeds to
  // `requireAudience` ONLY once the owner's token is confirmed host-scoped, and
  // rolls back rather than strand the owner — see `ensureForwardingAudience`.
  // `ensure` also short-circuits on relaunch when the server already persisted the
  // binding (it re-scopes this session's token instead of relaxing + re-asserting).
  const bindAudience = useCallback(
    async (assigned: string) => {
      const outcome = await ensureForwardingAudience(assigned, audienceDeps);
      // `bound` is the clean success; `partial`/`failed` keep the tunnel up (the local
      // UX is unaffected) but surface why hardening is incomplete — as a localizable
      // code, not raw English, so the view renders it through `t()`.
      setAudienceNotice(outcome.status === 'bound' ? null : {code: outcome.code, detail: outcome.reason});
    },
    [audienceDeps],
  );

  const startTunnel = useCallback(async () => {
    if (!forwarding || !token || clientRef.current || startingRef.current) return;
    startingRef.current = true; // latch BEFORE the first await (see startingRef)
    setBusy(true);
    setError(null);
    setAudienceNotice(null);
    setClaimRefusal(null);
    try {
      // Publish implies claim (OB-209): an outbound tunnel exposes the loopback
      // instance, bypassing the boot exposure backstop — so an UNCLAIMED instance
      // would be served anonymous + world-writable (rule-0 → guestAccess:'write').
      // Atomically claim ownership to this account's verified subject BEFORE dialing
      // out; refuse (and roll the intent back) if there's no verified identity to
      // claim with, so we never leave it unclaimed-and-exposed. The refusal is a
      // localized, severity-aware notice (`claimRefusal`), not a raw `error` string.
      const claim = await ensureClaimedForForwarding(audienceDeps);
      if (claim.status === 'refused') {
        setEnabled(false);
        writeEnabled(false);
        setStatus('offline');
        setClaimRefusal(claim.code);
        return;
      }
      const client = new ForwardingClient({
        accountUrl,
        authToken: token,
        keyStore: forwarding.keyStore,
        localOrigin: '',
        localFetchImpl: forwarding.localFetch,
        onStatus: setStatus,
      });
      clientRef.current = client;
      const {host: assigned} = await client.start();
      setHost(assigned);
      await bindAudience(assigned);
    } catch (e) {
      clientRef.current = null;
      setStatus('offline');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      startingRef.current = false;
    }
  }, [forwarding, token, accountUrl, bindAudience, audienceDeps]);

  // Resume on launch / once the account connects, when forwarding is enabled. This
  // is the SINGLE dial point for the intent-driven paths (relaunch, and the P1-6
  // signed-out auto-resume below): both just set `enabled`, and this effect opens
  // exactly one ForwardingClient into `clientRef` — so `disable()` can always stop
  // it (an orphaned client started off-book would stay published after an off flip).
  useEffect(() => {
    if (supported && enabled && connected && token && !clientRef.current && !startingRef.current) void startTunnel();
  }, [supported, enabled, connected, token, startTunnel]);

  // Drop the tunnel if the platform goes away (shouldn't happen mid-session).
  useEffect(() => () => clientRef.current?.stop(), []);

  // Where the workspace is currently reachable by others, or `null` (see the
  // context doc). Computed once so the registry effect below and every context
  // consumer (e.g. the Share dialog's link hint) share one publish predicate.
  const publishedHost = enabled && status === 'online' && host ? host : null;

  // Publish-aware copy links (P0-1): while the tunnel is live, "Copy link"
  // everywhere must emit the forwarded https host — `window.location` here is
  // `tauri://localhost`, dead for any recipient. Registered module-level (see
  // pageActions) so plain-module callers resolve it too; cleared the moment the
  // tunnel isn't actually serving, so we never hand out a link that 502s.
  useEffect(() => {
    setShareLinkOrigin(publishedHost);
    return () => setShareLinkOrigin(null);
  }, [publishedHost]);

  // Reflect the REAL published-site visibility from the account while online. A
  // fresh site defaults to `restricted`, and the edge serves ONLY `public`
  // anonymously — so a page set "public" on a restricted address is still bounced
  // for anyone not signed in. Reading the true scope here lets the Share dialog /
  // Sharing tab say so honestly (and offer the one-flip fix) instead of implying
  // "anyone with the link" works. Cleared the moment we're not published.
  useEffect(() => {
    const client = clientRef.current;
    if (!publishedHost || !client) {
      setSiteVis(null);
      return;
    }
    let live = true;
    client
      .getSiteVisibility()
      .then((v) => live && setSiteVis(v))
      .catch(() => undefined); // a read failure just leaves the control unshown; no false claim
    return () => {
      live = false;
    };
  }, [publishedHost]);

  // Flip the published site's audience scope through the EXISTING owner-only account
  // route. This never changes an access DEFAULT and only ever runs on the owner's own
  // device (their device bearer token), so it can't widen anyone else's exposure — the
  // account still whitelist-validates + enforces ownership server-side.
  const setSiteVisibility = useCallback(async (v: SiteVisibility) => {
    const client = clientRef.current;
    if (!client) return;
    setSiteVisBusy(true);
    try {
      setSiteVis(await client.setSiteVisibility(v));
    } catch {
      // Leave the shown value as the last-known server truth (never optimistic) and
      // tell the owner it didn't stick, so the UI can't imply a change that didn't land.
      showToast({message: t('forwarding.visibility.error')});
    } finally {
      setSiteVisBusy(false);
    }
  }, []);

  const enable = useCallback(async () => {
    if (!connected || !token) {
      // Can't claim an address without an account — start the sign-in handoff and
      // arm a resume intent for THIS attempt so the flip isn't a silent no-op: the
      // auto-resume effect below completes the enable once THIS sign-in connects.
      // The intent is deliberately not persisted (unlike ENABLED_KEY) and is bounded
      // (cleared on a cancelled/failed attempt, and after a TTL) so a later, unrelated
      // sign-in in the same session can't silently perform the irreversible claim.
      setSignInPending(true);
      signIn();
      return;
    }
    setSignInPending(false);
    setEnabled(true);
    writeEnabled(true);
    await startTunnel();
  }, [connected, token, signIn, startTunnel]);

  // Auto-resume the interrupted first flip (P1-6): the user flipped "Forward this
  // device" while signed out and we sent them off to sign in — complete the enable
  // for them once THIS sign-in attempt connects, instead of making them find the
  // toggle and flip it a second time. Crucially this does NOT dial directly: it only
  // sets `enabled`, and the single resume-on-launch effect above opens the one
  // ForwardingClient (so `disable()` can always stop it — a client started here
  // would be orphaned and stay published after an off flip). The claim warning is
  // shown before the flip even when signed out (see SharingPublishingSettings), so
  // the irreversible claim this may perform was consented to by that flip.
  useEffect(() => {
    if (!signInPending || !connected || !token) return;
    setSignInPending(false);
    resumedRef.current = true; // announce it once the address is live (may be off-screen)
    setEnabled(true);
    writeEnabled(true);
  }, [signInPending, connected, token]);

  // Bound the resume intent so it can only complete THE attempt that armed it — never
  // a later, unrelated sign-in (add/switch account, a settings sync) whose connect
  // would otherwise trip the auto-resume into an unconsented, irreversible claim.
  // Clear it the instant the attempt ends without connecting (explicit cancel →
  // `disconnected`, failure → `error`), and time it out as a backstop for the
  // popup-abandon case where the account status can stick at `connecting` forever.
  useEffect(() => {
    if (!signInPending) return;
    if (accountStatus === 'error' || accountStatus === 'disconnected') {
      setSignInPending(false);
      return;
    }
    const timer = setTimeout(() => setSignInPending(false), SIGN_IN_RESUME_TTL_MS);
    return () => clearTimeout(timer);
  }, [signInPending, accountStatus]);

  // Announce an auto-resume once the address is actually live — it can complete with
  // Settings closed / off-screen, so a passing toast is the only feedback the user gets.
  useEffect(() => {
    if (!resumedRef.current) return;
    if (status === 'online' && host) {
      resumedRef.current = false;
      showToast({message: t('forwarding.resumedToast', {host})});
    }
  }, [status, host]);

  const disable = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    setStatus('offline');
    setEnabled(false);
    writeEnabled(false);
    setAudienceNotice(null);
    setClaimRefusal(null);
    setSignInPending(false); // an explicit "off" also cancels a pending auto-resume
    resumedRef.current = false; // …and suppresses its (now-stale) "forwarding is on" toast
    // Unwind the audience binding SAFELY: relax `requireAudience` FIRST (while our
    // token is still scoped, so the PUT verifies) and only THEN drop the scoping +
    // re-mint unscoped. If the relax is NOT confirmed, the scoping is left intact
    // rather than unscoping the owner behind a still-required audience (a permanent
    // loopback lockout) — see `unbindForwardingAudience`.
    void (async () => {
      const outcome = await unbindForwardingAudience(audienceDeps);
      if (outcome.status === 'held') setAudienceNotice({code: outcome.code, detail: outcome.reason});
    })();
  }, [audienceDeps]);

  const value = useMemo<ForwardingContextValue>(
    () => ({
      supported, enabled, status, host, publishedHost,
      siteVisibility, siteVisibilityBusy, setSiteVisibility,
      busy, error, audienceNotice, claimRefusal, signInPending, enable, disable,
    }),
    [
      supported, enabled, status, host, publishedHost,
      siteVisibility, siteVisibilityBusy, setSiteVisibility,
      busy, error, audienceNotice, claimRefusal, signInPending, enable, disable,
    ],
  );

  return <ForwardingContext.Provider value={value}>{children}</ForwardingContext.Provider>;
};

export const useForwarding = (): ForwardingContextValue => useContext(ForwardingContext);
