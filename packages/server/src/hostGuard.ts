import type {MiddlewareHandler} from 'hono';
import type {AppEnv} from './appEnv';

/**
 * STAB-10 — DNS-rebinding hardening: a `Host`-header allowlist active on TCP binds.
 *
 * THE HOLE (from Sasha's STAB-8 review). STAB-8 closed cross-origin READS (an app-origin
 * CORS allowlist) and cross-origin WRITES (a first-party `X-OpenBook-Client` marker on
 * guest writes). Both defenses key on the browser treating the request as CROSS-origin.
 * A DNS-rebinding attack defeats exactly that: a page at `http://evil.com:4319` whose DNS
 * re-resolves `evil.com` → `127.0.0.1` (or the sidecar's LAN IP) becomes SAME-origin with
 * the sidecar — no CORS, no preflight, and the page can set `X-OpenBook-Client` itself and
 * read every response. That reopens guest-level read/write of the local library whenever a
 * TCP listener is bound: ALWAYS on Windows (no Unix-domain socket), on `pnpm dev` (:4319),
 * under the STAB-5 MCP-loopback toggle, and for the STAB-7 LAN publish. (Owner/admin/jws
 * routes stay gated; the exposure is the guest surface.)
 *
 * THE FIX. In a rebinding attack the browser still sends the ORIGINAL hostname in the
 * `Host` header (`Host: evil.com:4319`) — `Host` is a forbidden header JS cannot override.
 * So we reject any TCP request whose `Host` is not a hostname we actually serve on. The
 * allowlist is derived PER-REQUEST from the accepting socket, not from config, so it is
 * always exactly the sidecar's real bind/publish state (this is the STAB-7 interaction —
 * see {@link hostIsAllowed}):
 *
 *  - `socket.localAddress` — the local interface IP this connection was accepted on. For a
 *    loopback bind that is `127.0.0.1`/`::1`; for a LAN publish (STAB-7, incl. a `0.0.0.0`/
 *    `::` bind) it is the exact LAN interface IP the browser reached, e.g. `192.168.1.50`.
 *  - `socket.localPort` — the bound TCP port (the "expected port").
 *
 * A `Host` is allowed iff its hostname is a loopback literal (`localhost`, `127.x.x.x`,
 * `::1`) OR an IP literal equal to `localAddress`, AND its port (when present) equals
 * `localPort`. A rebound foreign hostname (`evil.com`) is neither a loopback literal nor an
 * IP literal matching the local interface, so it is rejected — even when it resolves to the
 * loopback or the real LAN IP.
 *
 * TRANSPORT GATE. The guard is INERT off TCP: a Unix-domain-socket connection (the desktop
 * IPC default) reports no `remoteAddress`/`localAddress` — `Host` is meaningless there —
 * and Hono's in-process `app.request` / the in-webview `LocalDataClient` carry no Node
 * socket at all. In every one of those cases the guard falls through untouched, so existing
 * behavior on the socket transport is unchanged. It is therefore safe to mount
 * unconditionally: it only bites a real inbound TCP connection.
 */

/**
 * Is `host` a loopback LITERAL — the machine-owner-only hosts safe to serve without a
 * Host-allowlist rebinding check? Accepts `localhost`, any `127.x.x.x`, and `::1` (bare or
 * `[::1]`-bracketed). This is the shared source of truth for the loopback host-set: the
 * §2.6 bind backstop's {@link isLoopbackHost} (server.ts) delegates here, and the
 * rebinding guard reuses it for the Host hostname check.
 */
export function isLoopbackHostname(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(?:\.\d{1,3}){1,3}$/.test(h);
}

/** A parsed `Host` header: the hostname (IPv6 brackets stripped) and its port (or ''). */
interface ParsedHost {
  hostname: string;
  port: string;
}

/**
 * Parse a `Host` header into hostname + port. Uses the URL parser so IPv6 brackets and the
 * `:port` split are handled correctly (`[::1]:4319` → `{'::1', '4319'}`, `evil.com:4319` →
 * `{'evil.com', '4319'}`, `localhost` → `{'localhost', ''}`). Returns null on a malformed
 * or empty Host — the caller treats that as not-allowed.
 */
function parseHost(hostHeader: string): ParsedHost | null {
  const raw = hostHeader.trim();
  if (!raw) return null;
  try {
    const url = new URL(`http://${raw}`);
    // Reject a Host that smuggled anything but authority (userinfo/path/etc.).
    if (url.pathname !== '/' || url.username || url.password || url.search || url.hash) return null;
    if (!url.hostname) return null;
    return {hostname: url.hostname, port: url.port};
  } catch {
    return null;
  }
}

/**
 * Normalize an IP literal for comparison: lowercase, strip IPv6 brackets, and drop the
 * `::ffff:` IPv4-mapped-IPv6 prefix. A `::`/`0.0.0.0` bind serving an IPv4 client reports
 * `localAddress` as `::ffff:192.168.1.50` while the browser's `Host` carries the bare
 * `192.168.1.50` — this maps both to the same literal so they compare equal.
 */
function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.startsWith('::ffff:')) s = s.slice('::ffff:'.length);
  return s;
}

/**
 * The core allow decision. `host` is the parsed `Host`; `localAddress`/`localPort` come
 * from the accepting socket (the sidecar's own bind state — see the module doc).
 *
 * Hostname: a loopback literal, or an IP literal equal to the local interface IP (the
 * STAB-7 LAN-publish host the sidecar is actually serving on). A rebound foreign HOSTNAME
 * is neither, so it is rejected regardless of what IP it resolved to.
 *
 * Port: when the Host carries an explicit port it must equal the bound `localPort` (the
 * "expected port"); a port-less Host passes the port sub-check (the hostname gate still
 * applies). This keeps the check strict without false-rejecting the rare port-less client.
 */
function hostIsAllowed(host: ParsedHost, localAddress: string, localPort: number | undefined): boolean {
  if (host.port !== '' && localPort != null && Number(host.port) !== localPort) return false;
  if (isLoopbackHostname(host.hostname)) return true;
  return normalizeIp(host.hostname) === normalizeIp(localAddress);
}

/**
 * The STAB-10 middleware. Mount once at `'*'` (ahead of the API/served-UI handlers) so it
 * guards both `/api/*` and the STAB-7 served UI. Inert off the TCP transport (see the
 * module doc) — safe to mount unconditionally.
 */
export function hostAllowlistGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // The Node adapter exposes the accepting socket at `c.env.incoming.socket` (same seam
    // clientIpKey reads). A UDS connection reports no addresses; an in-process request has
    // no socket at all. Cast inline (AppEnv declares no Bindings) — established pattern.
    const env = c.env as {incoming?: {socket?: {remoteAddress?: string; localAddress?: string; localPort?: number}}} | undefined;
    const socket = env?.incoming?.socket;
    const localAddress = socket?.localAddress;
    // Transport gate: enforce only on a real TCP connection. `remoteAddress` (peer) and
    // `localAddress` (our accepting interface) are both undefined over a Unix-domain socket
    // and absent for `app.request`/in-webview — Host is meaningless there, so fall through.
    if (!socket || socket.remoteAddress == null || localAddress == null) return next();

    const parsed = parseHost(c.req.header('host') ?? '');
    if (parsed && hostIsAllowed(parsed, localAddress, socket.localPort)) return next();

    // Rebound / foreign Host on a loopback-or-LAN TCP bind. Fail closed for BOTH the API
    // and the served UI — the attack's whole point is to become same-origin and read them.
    return c.json({error: 'Host not allowed (DNS-rebinding guard)'}, 403);
  };
}
