import React from 'react';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {renderHook, act, waitFor, cleanup} from '@testing-library/react';

// The signed-out-flip resume lifecycle (P1-6) is the unit under test: arm on a
// signed-out flip, auto-complete THE attempt that armed it (exactly one claim,
// via the single launch-effect dial), and drop the intent when the attempt is
// cancelled/failed or times out — so a later unrelated sign-in never trips an
// unconsented, irreversible claim.

// Shared mutable account state + spies, hoisted so the vi.mock factories can close
// over them (vi.mock is hoisted above imports).
const h = vi.hoisted(() => ({
  account: {
    connected: false,
    token: null as string | null,
    accountUrl: 'https://account.example',
    status: 'disconnected' as string,
    // Mirror the real AccountProvider.signIn(): it synchronously moves status to
    // 'connecting' (same React batch as the flip), so the resume guard never sees a
    // terminal 'disconnected' while the attempt is genuinely in flight.
    signIn: vi.fn(() => {
      h.account.status = 'connecting';
    }),
    remintIdentity: vi.fn(async () => null),
  },
  claimSpy: vi.fn(async () => ({status: 'claimed'}) as {status: 'claimed'}),
  bindSpy: vi.fn(async () => ({status: 'bound'}) as {status: 'bound'}),
  unbindSpy: vi.fn(async () => ({status: 'relaxed'}) as {status: 'relaxed'}),
  clientCtor: vi.fn(),
  showToastSpy: vi.fn(),
}));

vi.mock('../AccountProvider', () => ({useAccount: () => h.account}));
vi.mock('../PlatformCapabilitiesProvider', () => ({
  usePlatformCapabilities: () => ({forwarding: {keyStore: {load: async () => null}, localFetch: vi.fn()}}),
}));
vi.mock('@/data/DataProvider', () => ({
  useData: () => ({setInstancePolicy: vi.fn(), getInstanceInfo: vi.fn()}),
}));
vi.mock('../forwardingAudience', () => ({
  ensureClaimedForForwarding: h.claimSpy,
  ensureForwardingAudience: h.bindSpy,
  unbindForwardingAudience: h.unbindSpy,
}));
vi.mock('@book.dev/sdk', () => ({
  setForwardingAudience: vi.fn(),
  ForwardingClient: class {
    onStatus?: (s: string) => void;
    constructor(opts: {onStatus?: (s: string) => void}) {
      this.onStatus = opts.onStatus;
      h.clientCtor();
    }
    async start() {
      this.onStatus?.('online');
      return {host: 'abc.book.cloud'};
    }
    async getSiteVisibility() {
      return 'restricted' as const; // account default; the load effect reads this once online
    }
    async setSiteVisibility(v: 'public' | 'restricted') {
      return v;
    }
    stop() {}
  },
}));
vi.mock('@/components/ui/toast', () => ({showToast: h.showToastSpy}));
vi.mock('@/lib/pageActions', () => ({setShareLinkOrigin: vi.fn()}));

import {ForwardingProvider, useForwarding} from '../ForwardingProvider';

const wrapper = ({children}: {children: React.ReactNode}) => <ForwardingProvider>{children}</ForwardingProvider>;

/** Flip the fake account to a connected/signed-in state. */
function signIn(token = 'tok', status = 'connected'): void {
  h.account.connected = true;
  h.account.token = token;
  h.account.status = status;
}

beforeEach(() => {
  localStorage.clear();
  h.account.connected = false;
  h.account.token = null;
  h.account.status = 'disconnected';
  h.account.signIn.mockClear();
  h.claimSpy.mockClear();
  h.clientCtor.mockClear();
  h.showToastSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ForwardingProvider — signed-out flip resume (P1-6)', () => {
  it('arms the resume intent and does not claim until sign-in completes', async () => {
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => {
      await result.current.enable();
    });

    // The flip started sign-in and armed the intent — but claimed nothing yet.
    expect(h.account.signIn).toHaveBeenCalledTimes(1);
    expect(result.current.signInPending).toBe(true);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('auto-completes THE attempt exactly once (single dial, one claim) and toasts', async () => {
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.signInPending).toBe(true);

    // The user finishes signing in; the provider should resume on its own.
    await act(async () => {
      signIn();
      rerender();
    });

    await waitFor(() => expect(h.claimSpy).toHaveBeenCalledTimes(1));
    // Exactly one ForwardingClient opened — the launch effect is the sole dial point,
    // so disable() can always stop it, and the startingRef guard blocks a double.
    expect(h.clientCtor).toHaveBeenCalledTimes(1);
    expect(result.current.signInPending).toBe(false);
    await waitFor(() =>
      expect(h.showToastSpy).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('abc.book.cloud')})),
    );
  });

  it('clears the intent when the sign-in attempt fails, and never claims on a later connect', async () => {
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.signInPending).toBe(true);

    // The attempt errors out (still not connected) — the intent must drop.
    await act(async () => {
      h.account.status = 'error';
      rerender();
    });
    await waitFor(() => expect(result.current.signInPending).toBe(false));

    // A LATER, unrelated sign-in connects — it must NOT resume the abandoned flip.
    await act(async () => {
      signIn();
      rerender();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.claimSpy).not.toHaveBeenCalled();
    expect(h.clientCtor).not.toHaveBeenCalled();
  });

  it('clears the intent after the TTL backstop (popup-abandon: status stuck connecting)', async () => {
    vi.useFakeTimers();
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.signInPending).toBe(true);

    // Sign-in never completes; status sticks at 'connecting'.
    act(() => {
      h.account.status = 'connecting';
      rerender();
    });
    act(() => {
      vi.advanceTimersByTime(3 * 60 * 1000 + 1);
    });
    expect(result.current.signInPending).toBe(false);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('claims exactly once on a direct signed-in flip (double-start guard)', async () => {
    signIn(); // already connected before the flip
    const {result} = renderHook(() => useForwarding(), {wrapper});

    // enable() dials directly AND sets `enabled`, which also arms the launch effect —
    // the startingRef guard must collapse that into a single claim.
    await act(async () => {
      await result.current.enable();
    });

    await waitFor(() => expect(h.claimSpy).toHaveBeenCalledTimes(1));
    expect(h.clientCtor).toHaveBeenCalledTimes(1);
    expect(result.current.signInPending).toBe(false);
  });
});
