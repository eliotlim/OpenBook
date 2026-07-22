/**
 * STAB-5: the stable per-library instance id.
 *
 * The out-of-process MCP connector verifies it reached the RIGHT library by
 * comparing the `instanceId` on `GET /api/instance` against its configured value.
 * That guarantee rests on the id being (a) minted once, (b) stable across calls and
 * config edits, and (c) actually surfaced on the instance route.
 */
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {InstanceInfo} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';

let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;

const appWith = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-instanceid-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('ensureInstanceId', () => {
  it('mints a non-empty id and is idempotent (stable across calls)', async () => {
    const first = await store.ensureInstanceId();
    expect(typeof first).toBe('string');
    expect(first.length).toBeGreaterThan(0);
    // Second call must NOT re-mint — the connector relies on a stable id across restarts.
    const second = await store.ensureInstanceId();
    expect(second).toBe(first);
    expect((await store.getInstanceConfig()).instanceId).toBe(first);
  });

  it('survives an unrelated policy update (not clobbered by a shallow merge)', async () => {
    const id = await store.ensureInstanceId();
    await store.updateInstanceConfig({guestAccess: 'read'});
    const config = await store.getInstanceConfig();
    expect(config.instanceId).toBe(id);
    expect(config.guestAccess).toBe('read');
  });
});

describe('GET /api/instance', () => {
  it('advertises the minted instanceId', async () => {
    const id = await store.ensureInstanceId();
    const app = appWith();
    const res = await app.request('/api/instance');
    expect(res.status).toBe(200);
    const info = (await res.json()) as InstanceInfo;
    expect(info.instanceId).toBe(id);
  });

  it('reports null before an id is ever minted (pre-STAB-5 config shape)', async () => {
    // Without an ensureInstanceId() call the settings row carries no id, so the
    // route reports null rather than inventing an unstable per-request value.
    const app = appWith();
    const res = await app.request('/api/instance');
    const info = (await res.json()) as InstanceInfo;
    expect(info.instanceId).toBeNull();
  });
});
