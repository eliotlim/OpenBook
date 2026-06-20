import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';

const TOKEN = 'test-access-token-abc123';
let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-auth-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('access-token auth', () => {
  it('rejects /api/* without a token when one is configured', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    const res = await app.request('/api/pages');
    expect(res.status).toBe(401);
  });

  it('accepts the token via Authorization: Bearer', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    const res = await app.request('/api/pages', {headers: {Authorization: `Bearer ${TOKEN}`}});
    expect(res.status).toBe(200);
  });

  it('accepts the token via ?token= (for EventSource)', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    const res = await app.request(`/api/pages?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    expect((await app.request('/api/pages', {headers: {Authorization: 'Bearer nope'}})).status).toBe(401);
    expect((await app.request('/api/pages?token=nope')).status).toBe(401);
  });

  it('leaves /health open even when a token is configured', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('requires no token when none is configured (loopback/local UX)', async () => {
    const app = createApp(store, undefined, new PageHub());
    expect((await app.request('/api/pages')).status).toBe(200);
  });

  it('gates writes too, not just reads', async () => {
    const app = createApp(store, undefined, new PageHub(), {accessToken: TOKEN});
    const body = JSON.stringify({name: `n-${seq}`, data: {editorjs: {blocks: []}, values: [], names: []}});
    const noauth = await app.request('/api/pages', {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
    expect(noauth.status).toBe(401);
    const authed = await app.request('/api/pages', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`},
      body,
    });
    expect(authed.status).toBe(201);
  });
});
