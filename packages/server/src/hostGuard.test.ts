import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CLIENT_HEADER} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp, isAppOrigin} from './app';
import {isLoopbackHostname} from './hostGuard';
import {IdentityService} from './instanceConfig';

/**
 * STAB-10 — DNS-rebinding hardening: the `Host`-allowlist guard active on TCP binds.
 *
 * A page at `http://evil.com:4319` whose DNS rebinds `evil.com` → the loopback (or the
 * sidecar's LAN IP) becomes SAME-origin, defeating both STAB-8 defenses (CORS allowlist +
 * `X-OpenBook-Client` marker). The browser still sends `Host: evil.com:4319`, so the guard
 * rejects any TCP request whose `Host` isn't a hostname the sidecar actually serves on. It
 * is INERT off the TCP transport (Unix socket / in-webview), where `Host` is meaningless.
 *
 * The guard reads the accepting socket from the Node adapter's `c.env.incoming.socket`.
 * `app.request`'s third arg injects that env, so a TCP bind is simulated with a socket that
 * has `localAddress`/`localPort` (and a `remoteAddress` peer); the Unix-socket transport is
 * simulated by a socket with none of those (exactly what Node reports for a UDS connection).
 */

const PORT = 4319;
/** A simulated inbound TCP connection accepted on `localAddress:localPort`. */
const tcpEnv = (localAddress: string, localPort = PORT) => ({
  incoming: {socket: {remoteAddress: '203.0.113.9', localAddress, localPort}},
});
/** A Unix-domain-socket connection: Node reports no peer/local addresses. */
const udsEnv = () => ({incoming: {socket: {}}});

let store: PageStore;
let dir: string;
let seq = 0;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
const pageBody = (name: string) => JSON.stringify({name, data: snapshot()});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-stab10-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

describe('isLoopbackHostname — shared loopback host-set predicate', () => {
  it('accepts loopback literals (bare and bracketed), case-insensitively', () => {
    for (const h of ['localhost', 'LocalHost', '127.0.0.1', '127.1.2.3', '127.1', '::1', '[::1]']) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  it('rejects foreign hostnames and LAN IPs', () => {
    for (const h of ['evil.com', 'localhost.evil.com', '192.168.1.50', '10.0.0.1', '', 'notlocalhost', '127.0.0.1.evil.com', '127.foo.bar']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

describe('(guard) foreign Host on a loopback TCP bind → 403', () => {
  it('rejects a foreign Host on an /api route', async () => {
    const res = await app().request('/api/pages', {headers: {Host: 'evil.com:4319'}}, tcpEnv('127.0.0.1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('rebinding');
  });

  it('rejects a foreign Host on the served-UI (non-API) path', async () => {
    const uiDir = join(dir, 'ui');
    mkdirSync(uiDir, {recursive: true});
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>ob</title>');
    const ui = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), uiDir});
    // A loopback Host reaches the served shell…
    const ok = await ui.request('/', {headers: {Host: 'localhost:4319'}}, tcpEnv('127.0.0.1'));
    expect(ok.status).toBe(200);
    // …a rebound foreign Host does not.
    const blocked = await ui.request('/', {headers: {Host: 'evil.com:4319'}}, tcpEnv('127.0.0.1'));
    expect(blocked.status).toBe(403);
  });

  it('rejects a Host whose port ≠ the bound port (defense-in-depth)', async () => {
    const res = await app().request('/api/pages', {headers: {Host: 'localhost:5555'}}, tcpEnv('127.0.0.1', PORT));
    expect(res.status).toBe(403);
  });

  it('rejects a 127-prefixed foreign Host (anchored loopback match, no trailing label)', async () => {
    const res = await app().request('/api/pages', {headers: {Host: '127.0.0.1.evil.com:4319'}}, tcpEnv('127.0.0.1'));
    expect(res.status).toBe(403);
  });
});

describe('(guard) loopback literals at the expected port → pass', () => {
  it.each([['localhost:4319'], ['127.0.0.1:4319'], ['127.1:4319'], ['[::1]:4319']])('%s passes', async (host) => {
    const res = await app().request('/api/pages', {headers: {Host: host}}, tcpEnv('127.0.0.1'));
    expect(res.status).toBe(200);
  });

  it('a loopback guest WRITE (with the client header) is not blocked by the guard', async () => {
    const res = await app().request(
      '/api/pages',
      {method: 'POST', headers: {Host: 'localhost:4319', 'Content-Type': 'application/json', [CLIENT_HEADER]: '1'}, body: pageBody(`loop-${seq}`)},
      tcpEnv('127.0.0.1'),
    );
    expect(res.status).toBe(201);
  });
});

describe('(guard) Unix-socket transport → inert', () => {
  it('a foreign Host over a UDS connection passes through (Host is meaningless there)', async () => {
    const res = await app().request('/api/pages', {headers: {Host: 'evil.com:4319'}}, udsEnv());
    expect(res.status).toBe(200);
  });

  it('an in-process request with no socket at all passes through', async () => {
    // No env third-arg ⇒ no `c.env.incoming` — the desktop in-webview / `app.request` path.
    const res = await app().request('/api/pages', {headers: {Host: 'evil.com:4319'}});
    expect(res.status).toBe(200);
  });
});

describe('(guard) STAB-7 LAN publish', () => {
  it('the sidecar’s own LAN host:port passes; a foreign hostname resolving to the LAN IP is 403', async () => {
    const lanIp = '192.168.1.50';
    // The browser opened http://192.168.1.50:4319/ — Host is the LAN IP the sidecar serves on.
    const ok = await app().request('/api/pages', {headers: {Host: `${lanIp}:4319`}}, tcpEnv(lanIp));
    expect(ok.status).toBe(200);
    // A rebinding page (evil.com → 192.168.1.50): same accepting interface, foreign Host.
    const blocked = await app().request('/api/pages', {headers: {Host: 'evil.com:4319'}}, tcpEnv(lanIp));
    expect(blocked.status).toBe(403);
  });

  it('an IPv4-mapped-IPv6 localAddress (0.0.0.0/:: bind) matches the bare IPv4 Host', async () => {
    // A `::` bind serving an IPv4 client reports localAddress as ::ffff:192.168.1.50 while
    // the browser's Host carries the bare 192.168.1.50 — the guard normalizes both.
    const res = await app().request('/api/pages', {headers: {Host: '192.168.1.50:4319'}}, tcpEnv('::ffff:192.168.1.50'));
    expect(res.status).toBe(200);
  });
});

describe('isAppOrigin — STAB-8 LOW nit: case-insensitive scheme/host', () => {
  it('accepts app origins regardless of case', () => {
    expect(isAppOrigin('TAURI://localhost')).toBe(true);
    expect(isAppOrigin('tauri://LOCALHOST')).toBe(true);
    expect(isAppOrigin('HTTP://tauri.localhost')).toBe(true);
    expect(isAppOrigin('HTTP://LocalHost:3000')).toBe(true);
    expect(isAppOrigin('http://127.0.0.1:4319')).toBe(true);
  });
  it('still rejects foreign / look-alike origins in any case', () => {
    expect(isAppOrigin('HTTP://EVIL.COM')).toBe(false);
    expect(isAppOrigin('http://localhost.EVIL.com')).toBe(false);
    expect(isAppOrigin('http://192.168.1.10:4319')).toBe(false);
  });
});
