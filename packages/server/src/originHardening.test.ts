import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  CLIENT_HEADER,
  LOCAL_OWNER_HEADER,
  mintIdentityKeypair,
  signIdentity,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp, isAppOrigin} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

/**
 * STAB-8 — sidecar browser-reachability hardening. Two independent gates close the
 * cross-origin read/write that a wildcard `cors()` + default `guestAccess:'write'`
 * left open while ANY TCP listener is bound (LAN publish, dev :4319, the STAB-5 MCP
 * loopback toggle, Windows):
 *
 *  (a) an app-origin CORS allowlist — a foreign origin gets no `Access-Control-Allow-
 *      Origin`, so a web page the browser visits cannot READ a cross-origin response;
 *  (b) a first-party `X-OpenBook-Client` header required on guest WRITES — a
 *      cross-origin browser SIMPLE request cannot attach it, so it cannot WRITE.
 */

const ISS = 'https://account.book.pub';
const EVIL = 'https://evil.example.com';
const APP_ORIGIN = 'tauri://localhost';

let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
const pageBody = (name: string) => JSON.stringify({name, data: snapshot()});

const jwsFor = (sub: string): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${seq}`,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  // PGlite create()+migrate() can exceed the 10s hook default under load; the suite's
  // vitest.config.ts raises hookTimeout to 30s (the documented server-suite pattern).
  seq += 1;
  dir = join(tmpdir(), `ob-stab8-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}]});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const appWithIdentity = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

describe('isAppOrigin — app-origin allowlist predicate', () => {
  it('accepts the desktop webview + loopback dev origins', () => {
    expect(isAppOrigin('tauri://localhost')).toBe(true);
    expect(isAppOrigin('http://tauri.localhost')).toBe(true);
    expect(isAppOrigin('https://tauri.localhost')).toBe(true);
    expect(isAppOrigin('http://localhost:3000')).toBe(true);
    expect(isAppOrigin('http://localhost')).toBe(true);
    expect(isAppOrigin('http://127.0.0.1:4319')).toBe(true);
    expect(isAppOrigin('https://127.0.0.1')).toBe(true);
    expect(isAppOrigin('http://[::1]:5173')).toBe(true);
  });

  it('rejects foreign origins, LAN IPs, look-alikes, and the empty/absent origin', () => {
    expect(isAppOrigin('')).toBe(false); // no Origin header ⇒ not CORS-relevant
    expect(isAppOrigin(EVIL)).toBe(false);
    expect(isAppOrigin('null')).toBe(false); // sandboxed-iframe / file: origin
    expect(isAppOrigin('http://192.168.1.10:4319')).toBe(false); // a real LAN IP is never the app
    expect(isAppOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAppOrigin('http://127.0.0.1.evil.com')).toBe(false);
    expect(isAppOrigin('https://tauri.localhost.evil.com')).toBe(false);
    expect(isAppOrigin('http://notlocalhost')).toBe(false);
  });
});

describe('(a) CORS app-origin allowlist', () => {
  it('reflects ACAO for an app origin', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {headers: {Origin: APP_ORIGIN}});
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
  });

  it('sends NO ACAO for a foreign origin — its response is unreadable cross-origin', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {headers: {Origin: EVIL}});
    // The read itself still executes on the server, but the browser refuses to expose
    // the body cross-origin because there is no ACAO naming the foreign origin.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sends nothing CORS for a request with no Origin (same-origin / curl / IPC)', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preflight for an app origin allows the first-party headers incl X-OpenBook-Client', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {
      method: 'OPTIONS',
      headers: {Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'POST'},
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers') ?? '').toContain(CLIENT_HEADER);
  });

  it('preflight for a foreign origin gets no ACAO', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {
      method: 'OPTIONS',
      headers: {Origin: EVIL, 'Access-Control-Request-Method': 'POST'},
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('(b) guest-write first-party-header gate', () => {
  it('a foreign-origin SIMPLE guest POST (no client header) is rejected 403', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: EVIL},
      body: pageBody(`evil-${seq}`),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('a guest POST WITHOUT the client header is rejected 403 even with no Origin', async () => {
    // Closes the Origin: null / origin-stripped edge — the requirement is unconditional.
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`bare-${seq}`),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('X-OpenBook-Client');
  });

  it('a guest POST WITH the client header succeeds (the app itself, LAN guest write)', async () => {
    const app = appWithIdentity();
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [CLIENT_HEADER]: '1', Origin: APP_ORIGIN},
      body: pageBody(`app-${seq}`),
    });
    expect(res.status).toBe(201);
  });

  it('a guest READ without the header still works (reads are never gated)', async () => {
    const app = appWithIdentity();
    expect((await app.request('/api/pages')).status).toBe(200);
  });

  it('the gate applies on a LEGACY instance with NO identity provider too', async () => {
    // The default guestAccess:'write' hole was worst here — a legacy instance served
    // every anonymous write. The gate must still require the header.
    const legacy = createApp(store);
    const blocked = await legacy.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`legacy-blocked-${seq}`),
    });
    expect(blocked.status).toBe(403);
    const ok = await legacy.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [CLIENT_HEADER]: '1'},
      body: pageBody(`legacy-ok-${seq}`),
    });
    expect(ok.status).toBe(201);
  });

  it('an AUTHENTICATED (jws) write is EXEMPT — its identity header is already non-simple', async () => {
    const app = appWithIdentity();
    const jws = await jwsFor('user-1');
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
      body: pageBody(`jws-${seq}`),
    });
    expect(res.status).toBe(201);
  });

  it('an accessToken BEARER write is EXEMPT even without the client header — Authorization is non-simple', async () => {
    // The legacy `accessToken` authenticates but leaves the principal `guest`; a
    // bearer-authed API write (curl / a headless integration, not the sdk) must not be
    // 403'd for lacking the marker — a foreign simple request can never set Authorization.
    const token = 'e2e-access-token-stab8';
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store), accessToken: token});
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: pageBody(`bearer-${seq}`),
    });
    expect(res.status).toBe(201);
  });

  it('a LOCAL-OWNER write is EXEMPT — the loopback secret is already non-simple', async () => {
    const secret = 'local-owner-secret-stab8';
    const app = createApp(store, undefined, new PageHub(), {
      identity: new IdentityService(store),
      localOwnerSecret: secret,
    });
    const res = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', [LOCAL_OWNER_HEADER]: secret},
      body: pageBody(`owner-${seq}`),
    });
    expect(res.status).toBe(201);
  });
});
