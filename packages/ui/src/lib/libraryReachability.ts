import {useEffect, useState} from 'react';
import {API} from '@book.dev/sdk';

/**
 * How a library's server appears from this device:
 *  - `connected`   — the library we're currently talking to (no probe needed);
 *  - `reachable`   — a short health probe answered OK (or it's this device);
 *  - `unreachable` — the server answered, but not with a healthy status;
 *  - `checking`    — a probe is in flight;
 *  - `unknown`     — the probe couldn't complete (timeout, network, CORS). This is
 *                    the graceful-degrade state: we never claim a server is down,
 *                    only that we couldn't tell.
 */
export type LibraryStatus = 'connected' | 'reachable' | 'unreachable' | 'checking' | 'unknown';

/** How long a reachability probe waits before giving up (never hangs the menu). */
const PROBE_TIMEOUT_MS = 3000;

/**
 * Best-effort reachability of a library's server, for a subtle status dot. The
 * active library is `connected` without a probe; the local library (`serverUrl:
 * null`) is this device and always `reachable`; a remote library gets one short,
 * abortable `GET /health` (the always-open, unauthenticated endpoint), degrading
 * to `unknown` on any failure so it can never block or hang the UI.
 */
export function useLibraryStatus(serverUrl: string | null, active: boolean): LibraryStatus {
  const [status, setStatus] = useState<LibraryStatus>(active ? 'connected' : 'checking');

  useEffect(() => {
    if (active) {
      setStatus('connected');
      return;
    }
    // A null server URL is this device's local server — no network to probe.
    if (!serverUrl) {
      setStatus('reachable');
      return;
    }

    let origin: string;
    try {
      origin = new URL(serverUrl).origin;
    } catch {
      setStatus('unknown');
      return;
    }

    let cancelled = false;
    setStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    fetch(`${origin}${API.health}`, {signal: controller.signal})
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? 'reachable' : 'unreachable');
      })
      .catch(() => {
        // Timeout / network / CORS — we couldn't tell, so degrade rather than lie.
        if (!cancelled) setStatus('unknown');
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [serverUrl, active]);

  return status;
}
