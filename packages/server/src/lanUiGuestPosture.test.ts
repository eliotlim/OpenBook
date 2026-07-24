import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';

// STAB-7 (LAN-hosted web UI) — TOKEN POSTURE.
//
// The spike decision: the sidecar-served LAN UI rides the library's `guestAccess`
// setting UNCHANGED and there is NO access token on the LAN bind for v1 (a
// guest-gated posture, not a shared-secret one). This test nails that contract at
// the server: the SAME app instance that serves the browser its UI shell also
// enforces `guestAccess` on the writes that browser then issues to /api — with NO
// `accessToken` configured. It complements lanUi.test.ts (the serving contract)
// by proving the AUTH contract of the served origin.
//
// Guest = no identity header + no access token: exactly what a plain LAN browser
// opening `http://<host>:4319/` sends. `guestAccess:'write'` must let it write;
// `'read'` must block the write but still allow reads (so the app still boots).

let store: PageStore;
let dir: string;
let uiDir: string;
let seq = 0;

const INDEX_HTML =
  '<!doctype html><html><head><title>OpenBook</title></head><body><div id="__next">shell</div></body></html>';

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
const pageBody = (name: string) => JSON.stringify({name, data: snapshot()});

// Identity wired (like the real desktop/LAN bind) so the guest-access gate is
// actually evaluated — but NO accessToken passed to createApp: the served origin
// is guest-gated, never shared-secret-gated.
const servedUiApp = () => createApp(store, undefined, new PageHub(), {uiDir, identity: new IdentityService(store)});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-lanui-guest-db-${process.pid}-${seq}`);
  uiDir = join(tmpdir(), `ob-lanui-guest-ui-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  rmSync(uiDir, {recursive: true, force: true});
  mkdirSync(uiDir, {recursive: true});
  writeFileSync(join(uiDir, 'index.html'), INDEX_HTML);
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
  rmSync(uiDir, {recursive: true, force: true});
});

describe('STAB-7 — the served-UI origin is guest-gated (no access token on the bind)', () => {
  it('guestAccess=write: a guest write through the served origin is allowed (no token)', async () => {
    // The default gate is `write`; assert it explicitly so the test states its premise.
    await store.updateInstanceConfig({guestAccess: 'write'});
    const app = servedUiApp();

    // The browser first receives its UI shell from THIS origin…
    const shell = await app.request('/');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toMatch(/text\/html/);

    // …then the app it just booted writes to the SAME origin's /api with no
    // identity header and no access token — a plain LAN guest. guestAccess=write
    // lets it through.
    const created = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`lan-guest-${seq}`),
    });
    expect(created.status).toBe(201);
  });

  it('guestAccess=read: a guest write is blocked (403) but reads still boot the app', async () => {
    await store.updateInstanceConfig({guestAccess: 'read'});
    const app = servedUiApp();

    // The UI shell is still served (the app must boot to show a read-only view).
    expect((await app.request('/')).status).toBe(200);
    // Reads over the served origin still work…
    expect((await app.request('/api/pages')).status).toBe(200);
    // …but a guest write is refused by the gate, NOT waved through for lack of a
    // token. This is the whole point of the guest-first posture.
    const blocked = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: pageBody(`lan-guest-ro-${seq}`),
    });
    expect(blocked.status).toBe(403);
  });
});
