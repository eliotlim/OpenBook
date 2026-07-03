import React, {createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {ForwardingClient, setForwardingAudience, type TunnelStatus} from '@book.dev/sdk';
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
   * identity — render it muted, like {@link signInHint}); `claim-failed` is a genuine
   * failure (render it as an error). `null` when there's nothing to show.
   */
  claimRefusal: 'unverified' | 'claim-failed' | null;
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
  busy: false,
  error: null,
  audienceNotice: null,
  claimRefusal: null,
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
  const {connected, token, accountUrl, signIn, remintIdentity} = useAccount();
  const data = useData();
  const supported = !!forwarding;

  const clientRef = useRef<ForwardingClient | null>(null);
  const [enabled, setEnabled] = useState<boolean>(() => readEnabled());
  const [status, setStatus] = useState<ForwardingStatus>('idle');
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audienceNotice, setAudienceNotice] = useState<{code: AudienceNoticeCode; detail?: string} | null>(null);
  const [claimRefusal, setClaimRefusal] = useState<'unverified' | 'claim-failed' | null>(null);

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
    if (!forwarding || !token || clientRef.current) return;
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
    }
  }, [forwarding, token, accountUrl, bindAudience, audienceDeps]);

  // Resume on launch / once the account connects, when forwarding is enabled.
  useEffect(() => {
    if (supported && enabled && connected && token && !clientRef.current) void startTunnel();
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

  const enable = useCallback(async () => {
    if (!connected || !token) {
      signIn(); // can't claim an address without an account — start sign-in
      return;
    }
    setEnabled(true);
    writeEnabled(true);
    await startTunnel();
  }, [connected, token, signIn, startTunnel]);

  const disable = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    setStatus('offline');
    setEnabled(false);
    writeEnabled(false);
    setAudienceNotice(null);
    setClaimRefusal(null);
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
    () => ({supported, enabled, status, host, publishedHost, busy, error, audienceNotice, claimRefusal, enable, disable}),
    [supported, enabled, status, host, publishedHost, busy, error, audienceNotice, claimRefusal, enable, disable],
  );

  return <ForwardingContext.Provider value={value}>{children}</ForwardingContext.Provider>;
};

export const useForwarding = (): ForwardingContextValue => useContext(ForwardingContext);
