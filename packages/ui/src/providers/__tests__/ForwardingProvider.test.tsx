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
  reconcileSpy: vi.fn(),
  clientCtor: vi.fn(),
  clientStart: vi.fn(),
  clientStop: vi.fn(),
  clientCallbacks: {} as {onStatus?: (s: string) => void; onDialError?: (error: unknown) => void; onHost?: (host: string) => void},
  showToastSpy: vi.fn(),
  setHud: vi.fn(),
  data: {setInstancePolicy: vi.fn(), getInstanceInfo: vi.fn()},
}));

vi.mock('../AccountProvider', () => ({useAccount: () => h.account}));
vi.mock('../PlatformCapabilitiesProvider', () => ({
  usePlatformCapabilities: () => ({forwarding: {keyStore: {load: async () => null}, localFetch: vi.fn()}}),
}));
vi.mock('@/data/DataProvider', () => ({
  useData: () => h.data,
}));
vi.mock('../forwardingAudience', () => ({
  ensureClaimedForForwarding: h.claimSpy,
  reconcileForwardingAudience: h.reconcileSpy,
}));
vi.mock('@book.dev/sdk', () => ({
  setForwardingAudience: vi.fn(),
  ForwardingApiError: class extends Error {
    constructor(
      public readonly path: string,
      public readonly status: number,
    ) {
      super(`${path} → ${status}`);
    }
  },
  SiteReattachError: class extends Error {
    readonly retryable: boolean;
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.retryable = code === 'unreachable';
    }
  },
  ForwardingClient: class {
    onStatus?: (s: string) => void;
    constructor(opts: {onStatus?: (s: string) => void; onDialError?: (error: unknown) => void; onHost?: (host: string) => void}) {
      this.onStatus = opts.onStatus;
      h.clientCallbacks = opts;
      h.clientCtor();
    }
    async start() {
      return h.clientStart(this.onStatus);
    }
    async getSiteVisibility() {
      return 'restricted' as const; // account default; the load effect reads this once online
    }
    async setSiteVisibility(v: 'public' | 'restricted') {
      return v;
    }
    stop() {
      h.clientStop();
    }
  },
}));
vi.mock('@/components/ui/toast', () => ({showToast: h.showToastSpy}));
vi.mock('@/lib/pageActions', () => ({setShareLinkOrigin: vi.fn()}));
vi.mock('../HudProvider', () => ({useHud: () => ({setHud: h.setHud})}));

import {ForwardingApiError, SiteReattachError} from '@book.dev/sdk';
import {list as listErrors} from '@/lib/errorLog';
import {classifyForwardingError, ForwardingProvider, useForwarding} from '../ForwardingProvider';

const wrapper = ({children}: {children: React.ReactNode}) => <ForwardingProvider>{children}</ForwardingProvider>;

describe('classifyForwardingError', () => {
  it.each([
    [new Error('ipc connect failed: Connection refused'), 'ipc'],
    [new ForwardingApiError('/api/sites', 401), 'auth'],
    [new Error('keychain item is locked'), 'auth'],
    [new SiteReattachError('unreachable', 'account unavailable'), 'network'],
    [new TypeError('fetch failed'), 'network'],
    [new Error('site signature rejected'), 'unknown'],
  ] as const)('classifies %s as %s', (error, expected) => {
    expect(classifyForwardingError(error)).toBe(expected);
  });
});

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
  h.bindSpy.mockClear();
  h.unbindSpy.mockReset();
  h.unbindSpy.mockResolvedValue({status: 'relaxed'});
  h.reconcileSpy.mockReset();
  h.reconcileSpy.mockImplementation(async (host, state) => {
    if (state.hasPendingUnbind()) {
      const outcome = await h.unbindSpy() as {status: 'relaxed'} | {status: 'held'; code: 'unbindHeld'; reason: string};
      if (outcome.status === 'held') return outcome;
      state.clearPendingUnbind();
      if (!state.isEnabled()) return outcome;
    }
    if (host && state.isEnabled()) return h.bindSpy();
    return {status: 'idle'};
  });
  h.clientCtor.mockClear();
  h.clientStart.mockReset();
  h.clientStart.mockImplementation(async (onStatus?: (s: string) => void) => {
    onStatus?.('online');
    return {host: 'abc.book.cloud'};
  });
  h.clientStop.mockClear();
  h.clientCallbacks = {};
  h.showToastSpy.mockClear();
  h.setHud.mockClear();
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

    // enable() records intent and the launch effect owns the sole dial, while the
    // startingRef guard still protects effect re-entry during the async claim.
    await act(async () => {
      await result.current.enable();
    });

    await waitFor(() => expect(h.claimSpy).toHaveBeenCalledTimes(1));
    expect(h.clientCtor).toHaveBeenCalledTimes(1);
    expect(result.current.signInPending).toBe(false);
  });
});

describe('ForwardingProvider — retrying launch failures (TUN-1)', () => {
  it('retries a retryable failure after 2s and reaches online without another enable', async () => {
    vi.useFakeTimers();
    signIn();
    h.clientStart
      .mockRejectedValueOnce(new SiteReattachError('unreachable', 'account temporarily unavailable'))
      .mockImplementationOnce(async (onStatus?: (s: string) => void) => {
        onStatus?.('online');
        return {host: 'abc.book.cloud'};
      });
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => result.current.enable());
    expect(result.current.status).toBe('offline');
    expect(h.clientStart).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(h.clientStart).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(h.clientStart).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('online');
    expect(result.current.error).toBeNull();
    expect(listErrors()[0]).toMatchObject({subsystem: 'forwarding', code: 'unreachable'});
  });

  it('doubles launch backoff and caps every later delay at five minutes', async () => {
    vi.useFakeTimers();
    signIn();
    h.clientStart.mockRejectedValue(new ForwardingApiError('/api/sites/attach-ticket', 503));
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => result.current.enable());
    const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000];
    for (const [index, delay] of delays.entries()) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(h.clientStart).toHaveBeenCalledTimes(index + 1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(h.clientStart).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('leaves a non-retryable refusal terminal', async () => {
    vi.useFakeTimers();
    signIn();
    h.clientStart.mockRejectedValue(new SiteReattachError('wrong-account', 'use the account that owns this address'));
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => result.current.enable());
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1000));

    expect(h.clientStart).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('offline');
    expect(result.current.error).toContain('owns this address');
  });

  it('disable cancels a pending launch retry', async () => {
    vi.useFakeTimers();
    signIn();
    h.clientStart.mockRejectedValue(new TypeError('fetch failed'));
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => result.current.enable());
    await act(async () => {
      result.current.disable();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1000));

    expect(h.clientStart).toHaveBeenCalledTimes(1);
    expect(result.current.enabled).toBe(false);
  });
});

describe('ForwardingProvider — stalled dial diagnostics (TUN-3)', () => {
  it('debounces a 403 stall toast, exposes its code, logs it, and clears the error on recovery', async () => {
    signIn();
    h.clientStart.mockImplementationOnce(async (onStatus?: (s: string) => void) => {
      onStatus?.('connecting');
      return {host: 'abc.book.cloud'};
    });
    const {result} = renderHook(() => useForwarding(), {wrapper});
    await act(async () => result.current.enable());
    const forbidden = new ForwardingApiError('/api/sites/attach-ticket', 403);

    act(() => {
      h.clientCallbacks.onDialError?.(forbidden);
      h.clientCallbacks.onStatus?.('reconnecting');
    });
    expect(result.current.error).toBeNull();
    expect(h.showToastSpy).not.toHaveBeenCalled(); // one transient blip stays quiet

    act(() => {
      h.clientCallbacks.onDialError?.(forbidden);
      h.clientCallbacks.onStatus?.('stalled');
    });
    expect(result.current.status).toBe('stalled');
    expect(result.current.error).toContain('403');
    expect(h.showToastSpy).toHaveBeenCalledTimes(1);
    const toast = h.showToastSpy.mock.calls[0][0];
    expect(toast).toMatchObject({
      message: 'Publishing can\'t reconnect — your library isn\'t reachable online right now.',
      actionLabel: 'Open sharing settings',
      durationMs: 15_000,
    });
    expect(toast.message).not.toContain('403');
    expect(listErrors()[0]).toMatchObject({subsystem: 'forwarding', code: '403'});

    act(() => toast.onAction?.());
    const openSettings = h.setHud.mock.calls[0][0];
    const draft = {settings: {open: false, tab: 'general', section: 'stale'}};
    openSettings(draft);
    expect(draft.settings).toEqual({open: true, tab: 'sharing', section: null});

    act(() => {
      h.clientCallbacks.onDialError?.(forbidden);
      h.clientCallbacks.onStatus?.('stalled');
    });
    expect(h.showToastSpy).toHaveBeenCalledTimes(1); // no toast storm within one outage

    act(() => h.clientCallbacks.onStatus?.('online'));
    expect(result.current.status).toBe('online');
    expect(result.current.error).toBeNull();
  });
});

describe('ForwardingProvider — claim refusal intent (TUN-4)', () => {
  it('keeps persisted enable intent and auto-attaches when a boot-time refusal clears', async () => {
    vi.useFakeTimers();
    localStorage.setItem('openbook.forwarding.enabled', '1');
    signIn();
    h.claimSpy.mockResolvedValueOnce({
      status: 'refused',
      code: 'unverified',
      reason: 'identity is not ready yet',
    } as never);
    const {result} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    expect(h.clientCtor).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem('openbook.forwarding.enabled')).toBe('1');
    expect(result.current.claimRefusal).toBe('unverified');

    // The account/instance becomes claim-ready before the scheduled retry; the
    // mock's normal `claimed` result now succeeds without another user action.
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(h.claimSpy).toHaveBeenCalledTimes(2);
    expect(h.clientCtor).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('online');
    expect(result.current.claimRefusal).toBeNull();
    expect(localStorage.getItem('openbook.forwarding.enabled')).toBe('1');
  });

  it('clears a boot refusal across sign-out so signing back in can attach', async () => {
    vi.useFakeTimers();
    localStorage.setItem('openbook.forwarding.enabled', '1');
    signIn();
    h.claimSpy.mockResolvedValueOnce({
      status: 'refused',
      code: 'unverified',
      reason: 'identity is not ready yet',
    } as never);
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.claimRefusal).toBe('unverified');
    expect(h.clientCtor).not.toHaveBeenCalled();

    await act(async () => {
      h.account.connected = false;
      h.account.token = null;
      h.account.status = 'disconnected';
      rerender();
    });
    expect(result.current.claimRefusal).toBeNull();

    await act(async () => {
      signIn('fresh-token');
      rerender();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(h.clientCtor).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('online');
  });
});

describe('ForwardingProvider — durable unpublish (IPC-3)', () => {
  const pendingKey = 'openbook.forwarding.pendingUnbind:https%3A%2F%2Faccount.example';

  it('persists a held detach, retries on reconnect, and clears the notice and intent', async () => {
    signIn();
    h.unbindSpy
      .mockResolvedValueOnce({status: 'held', code: 'unbindHeld', reason: 'ipc unavailable'} as never)
      .mockResolvedValueOnce({status: 'relaxed'});
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    act(() => result.current.disable());
    await waitFor(() => expect(result.current.audienceNotice?.code).toBe('unbindHeld'));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem(pendingKey)).not.toBeNull();

    await act(async () => {
      h.account.connected = false;
      h.account.token = null;
      rerender();
    });
    await act(async () => {
      signIn('recovered-token');
      rerender();
    });
    await waitFor(() => expect(localStorage.getItem(pendingKey)).toBeNull());
    expect(result.current.audienceNotice).toBeNull();
    expect(h.unbindSpy).toHaveBeenCalledTimes(2);
  });

  it('re-enable cancels a pending detach and proceeds to bind', async () => {
    localStorage.setItem(pendingKey, 'abc.book.cloud');
    const foreignPendingKey = 'openbook.forwarding.pendingUnbind:https%3A%2F%2Fforeign.example';
    localStorage.setItem(foreignPendingKey, '1');
    const {result, rerender} = renderHook(() => useForwarding(), {wrapper});

    await act(async () => result.current.enable());
    await act(async () => {
      signIn();
      rerender();
    });
    await waitFor(() => expect(h.clientStart).toHaveBeenCalled());
    act(() => h.clientCallbacks.onHost?.('abc.book.cloud'));
    await waitFor(() => expect(h.reconcileSpy).toHaveBeenCalledWith('abc.book.cloud', expect.anything(), expect.anything()));
    expect(h.bindSpy).toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey)).toBeNull();
    expect(localStorage.getItem(foreignPendingKey)).toBeNull();
    expect(h.unbindSpy).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(true);
  });
});
