import React, {createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {ForwardingClient, type TunnelStatus} from '@book.dev/sdk';
import {useAccount} from './AccountProvider';
import {usePlatformLibrary} from './PlatformLibraryProvider';

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
  busy: boolean;
  error: string | null;
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
  busy: false,
  error: null,
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
  const {connected, token, accountUrl, signIn} = useAccount();
  const supported = !!forwarding;

  const clientRef = useRef<ForwardingClient | null>(null);
  const [enabled, setEnabled] = useState<boolean>(() => readEnabled());
  const [status, setStatus] = useState<ForwardingStatus>('idle');
  const [host, setHost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the reserved address even before the tunnel connects.
  useEffect(() => {
    if (!forwarding) return;
    forwarding.keyStore
      .load()
      .then((id) => id && setHost(id.host))
      .catch(() => undefined);
  }, [forwarding]);

  const startTunnel = useCallback(async () => {
    if (!forwarding || !token || clientRef.current) return;
    setBusy(true);
    setError(null);
    try {
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
    } catch (e) {
      clientRef.current = null;
      setStatus('offline');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [forwarding, token, accountUrl]);

  // Resume on launch / once the account connects, when forwarding is enabled.
  useEffect(() => {
    if (supported && enabled && connected && token && !clientRef.current) void startTunnel();
  }, [supported, enabled, connected, token, startTunnel]);

  // Drop the tunnel if the platform goes away (shouldn't happen mid-session).
  useEffect(() => () => clientRef.current?.stop(), []);

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
  }, []);

  const value = useMemo<ForwardingContextValue>(
    () => ({supported, enabled, status, host, busy, error, enable, disable}),
    [supported, enabled, status, host, busy, error, enable, disable],
  );

  return <ForwardingContext.Provider value={value}>{children}</ForwardingContext.Provider>;
};

export const useForwarding = (): ForwardingContextValue => useContext(ForwardingContext);
