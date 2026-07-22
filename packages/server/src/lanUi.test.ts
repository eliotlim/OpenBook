import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {startServer, type RunningServer} from './server';

// STAB-7 spike: prove the sidecar can ALSO serve a pre-built web UI on its TCP
// port (the LAN bind) without shadowing the API. A tiny fixture bundle stands in
// for the real Next static export — the serving contract is what's under test,
// not the bundle's contents.

let server: RunningServer;
let dataDir: string;
let uiDir: string;
let seq = 0;

const INDEX_HTML = '<!doctype html><html><head><title>OpenBook</title></head><body><div id="__next">shell</div><script src="/_next/static/app.abcdef01.js"></script></body></html>';
const APP_JS = 'console.log("openbook web bundle");';

beforeEach(() => {
  seq += 1;
  dataDir = join(tmpdir(), `ob-lanui-db-${process.pid}-${seq}`);
  uiDir = join(tmpdir(), `ob-lanui-ui-${process.pid}-${seq}`);
  rmSync(dataDir, {recursive: true, force: true});
  rmSync(uiDir, {recursive: true, force: true});
  // Lay down a minimal static bundle: index shell + one hashed asset in _next.
  mkdirSync(join(uiDir, '_next', 'static'), {recursive: true});
  writeFileSync(join(uiDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(uiDir, '_next', 'static', 'app.abcdef01.js'), APP_JS);
});

afterEach(async () => {
  await server?.close();
  rmSync(dataDir, {recursive: true, force: true});
  rmSync(uiDir, {recursive: true, force: true});
});

describe('STAB-7 — sidecar serves the LAN web UI alongside the API', () => {
  it('serves the SPA shell, hashed assets, deep-link fallback — and never shadows /api', async () => {
    server = await startServer({dataDir, host: '127.0.0.1', port: 0, uiDir});
    const base = server.url; // http://127.0.0.1:<port>

    // GET / → the UI shell (HTML), not a 404.
    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toMatch(/text\/html/);
    expect(await root.text()).toContain('id="__next"');

    // A hashed asset serves with the right type and an immutable cache hint.
    const asset = await fetch(`${base}/_next/static/app.abcdef01.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(await asset.text()).toBe(APP_JS);

    // The API still answers JSON on the same port — the UI catch-all is mounted
    // AFTER the API routes, so it never intercepts them.
    const pages = await fetch(`${base}/api/pages`);
    expect(pages.status).toBe(200);
    expect(pages.headers.get('content-type')).toMatch(/application\/json/);
    expect(Array.isArray(await pages.json())).toBe(true);

    // A round-trip write over the same origin proves the served UI could list/edit.
    const created = await fetch(`${base}/api/pages`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: 'LAN Page', data: {editorjs: {blocks: []}, values: [], names: []}}),
    });
    expect(created.status).toBe(201);
    const listed = await (await fetch(`${base}/api/pages`)).json();
    expect((listed as Array<{name: string}>).some((p) => p.name === 'LAN Page')).toBe(true);

    // A client-routed deep link (no such file) falls back to the SPA shell so the
    // browser boots the app and resolves the route client-side.
    const deep = await fetch(`${base}/some/nested/page`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toMatch(/text\/html/);
    expect(await deep.text()).toContain('id="__next"');

    // An UNMATCHED API path must still 404 as the API — NOT be answered with the
    // SPA shell. This is the anti-shadowing guarantee for /api.
    const missingApi = await fetch(`${base}/api/does-not-exist`);
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get('content-type') ?? '').not.toMatch(/text\/html/);

    // Health stays a plain text probe, not the shell.
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    // Path traversal out of the UI root is refused (falls back to the shell, never
    // leaks a file above the bundle).
    const traversal = await fetch(`${base}/../../../../etc/passwd`);
    expect(await traversal.text()).not.toContain('root:');
  });

  it('is OFF by default: with no uiDir a UI request 404s (API-only, unchanged)', async () => {
    server = await startServer({dataDir, host: '127.0.0.1', port: 0});
    const base = server.url;

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);

    // The API is unaffected.
    const pages = await fetch(`${base}/api/pages`);
    expect(pages.status).toBe(200);
    expect(Array.isArray(await pages.json())).toBe(true);
  });
});
