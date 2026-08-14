import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CLIENT_HEADER, type StoredDatabase, type StoredPage} from '@book.dev/sdk';
import {createApp} from './app';
import {PgliteDb} from './db';
import {PageHub} from './hub';
import {PageStore} from './store';

const KEY = '018f90d8-4b62-7c31-9a2f-62c4d5ea3f17';
const OTHER_KEY = 'f6ee99a6-cdc1-4ad8-91ba-b9dbd47b3014';
const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

let store: PageStore;
let db: PgliteDb;
let host: StoredPage;
let database: StoredDatabase;

beforeEach(async () => {
  db = await PgliteDb.create('memory://');
  store = new PageStore(db);
  await store.migrate();
  host = await store.upsertPage({name: 'Idempotency host', data: snapshot()});
  database = await store.createDatabase({
    pageId: host.id,
    name: 'Idempotency rows',
    schema: {properties: [], views: []},
  });
});

afterEach(async () => {
  await store.close();
});

const rowRequest = (body: string, key = KEY, path = `/api/databases/${database.id}/rows`) =>
  createApp(store, undefined, new PageHub()).request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      [CLIENT_HEADER]: '1',
      'Idempotency-Key': key,
    },
    body,
  });

describe('Idempotency-Key route contract', () => {
  it('rejects an unauthenticated keyed write without buffering or touching the ledger', async () => {
    const request = new Request('http://localhost/api/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: '1',
        'Idempotency-Key': KEY,
      },
      body: '{}',
    });
    const clone = vi.spyOn(request, 'clone');
    const ledger = vi.spyOn(store, 'idempotentWrite');
    const response = await createApp(store, undefined, new PageHub(), {accessToken: 'secret'}).fetch(request);

    expect(response.status).toBe(401);
    expect(clone).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(0);
  });

  it('rejects a malformed key before buffering or touching the ledger', async () => {
    const request = new Request('http://localhost/api/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'Idempotency-Key': 'not-a-uuid',
      },
      body: '{}',
    });
    const clone = vi.spyOn(request, 'clone');
    const ledger = vi.spyOn(store, 'idempotentWrite');
    const response = await createApp(store, undefined, new PageHub(), {accessToken: 'secret'}).fetch(request);

    expect(response.status).toBe(400);
    expect(clone).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM idempotency_responses')).toHaveLength(0);
  });

  it('replays duplicate POST /rows with one durable row and a byte-identical response', async () => {
    const body = JSON.stringify({name: 'Only once', properties: {amount: 42}});
    const first = await rowRequest(body);
    const replay = await rowRequest(body);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(await first.text());
    const rows = await store.listRows(database.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({name: 'Only once', properties: {amount: 42}});
  });

  it('fingerprints exact body bytes and returns the typed 409 reuse envelope on a mismatch', async () => {
    expect((await rowRequest('{"name":"same semantics"}')).status).toBe(201);
    const mismatch = await rowRequest('{ "name": "same semantics" }');

    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: 'idempotency key was already used for a different request',
      code: 'idempotency-key-reused',
      retryable: false,
    });
    expect(await store.listRows(database.id)).toHaveLength(1);
  });

  it('binds a key across routes but scopes it per resolved actor', async () => {
    expect((await rowRequest('{"name":"first actor"}')).status).toBe(201);

    const crossRoute = await createApp(store).request('/api/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: '1',
        'Idempotency-Key': KEY,
      },
      body: JSON.stringify({name: 'Different route', data: snapshot()}),
    });
    expect(crossRoute.status).toBe(409);
    expect(await crossRoute.json()).toMatchObject({code: 'idempotency-key-reused'});

    const otherActor = await createApp(store).request(`/api/databases/${database.id}/rows`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: '1',
        'X-OpenBook-Guest-Name': 'Ada',
        'Idempotency-Key': KEY,
      },
      body: '{"name":"second actor"}',
    });
    expect(otherActor.status).toBe(201);
    expect(await store.listRows(database.id)).toHaveLength(2);
  });

  it('rejects malformed keys and non-empty queries without consuming a key', async () => {
    const malformed = await rowRequest('{}', 'not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({code: 'invalid-input', retryable: false});

    const queried = await rowRequest('{}', OTHER_KEY, `/api/databases/${database.id}/rows?mode=x`);
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({code: 'invalid-input', retryable: false});

    // Neither 400 consumed a row: the same valid key succeeds on its canonical target.
    expect((await rowRequest('{}', OTHER_KEY)).status).toBe(201);
    expect(await store.listRows(database.id)).toHaveLength(1);
  });

  it('rejects the header on a mutation outside the wave-1 route table', async () => {
    const response = await createApp(store, undefined, new PageHub(), {embedded: true}).request(
      '/api/maintenance/compact',
      {
        method: 'POST',
        headers: {[CLIENT_HEADER]: '1', 'Idempotency-Key': KEY},
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Idempotency-Key is not supported on this mutation route',
      code: 'invalid-input',
      retryable: false,
    });
  });

  it('requires the legacy page-create body key to byte-match the header', async () => {
    const response = await createApp(store).request('/api/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: '1',
        'Idempotency-Key': KEY,
      },
      body: JSON.stringify({name: 'Mismatch', data: snapshot(), idempotencyKey: OTHER_KEY}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({code: 'invalid-input', retryable: false});
  });

  it('advertises writeContract: 1 on GET /api/instance', async () => {
    const response = await createApp(store).request('/api/instance');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({writeContract: 1});
  });

  it('captures a successful response on every wave-1 route', async () => {
    const app = createApp(store);
    const request = async (
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<Response> => app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        [CLIENT_HEADER]: '1',
        'Idempotency-Key': randomUUID(),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });

    const createdPageResponse = await request('POST', '/api/pages', {name: 'Wave page', data: snapshot()});
    expect(createdPageResponse.status).toBe(201);
    const createdPage = await createdPageResponse.json() as StoredPage;

    const changedSnapshot = {
      editorjs: {blocks: [{id: 'block-1', type: 'paragraph', data: {text: 'changed'}}]},
      values: [],
      names: [],
    };
    expect((await request('PUT', `/api/pages/${createdPage.id}`, {
      name: createdPage.name,
      data: changedSnapshot,
    })).status).toBe(200);
    expect((await request('PATCH', `/api/pages/${createdPage.id}`, {name: 'Renamed'})).status).toBe(200);
    expect((await request('PATCH', `/api/pages/${createdPage.id}/properties`, {
      properties: {priority: 'high'},
    })).status).toBe(200);
    expect((await request('PUT', `/api/pages/${createdPage.id}/move`, {
      parentId: null,
      orderedIds: [createdPage.id],
    })).status).toBe(200);
    expect((await request('PUT', `/api/pages/${createdPage.id}/visibility`, {listed: false})).status).toBe(200);
    expect((await request('PUT', `/api/pages/${createdPage.id}/agent-edits`, {agentEdits: 'direct'})).status).toBe(200);

    const versions = await store.listPageVersions(createdPage.id);
    expect(versions.length).toBeGreaterThan(0);
    expect((await request(
      'POST',
      `/api/pages/${createdPage.id}/versions/${versions[0].id}/restore`,
    )).status).toBe(200);
    expect((await request('DELETE', `/api/pages/${createdPage.id}`)).status).toBe(204);
    expect((await request('POST', `/api/pages/${createdPage.id}/restore`)).status).toBe(200);

    const rowResponse = await request('POST', `/api/databases/${database.id}/rows`, {name: 'Wave row'});
    expect(rowResponse.status).toBe(201);
    const row = await rowResponse.json() as StoredPage;
    expect((await request('PATCH', `/api/databases/${database.id}/rows/${row.id}`, {
      name: 'Wave row renamed',
    })).status).toBe(200);
    expect((await request('PUT', `/api/databases/${database.id}/rows/order`, {
      orderedIds: [row.id],
    })).status).toBe(200);

    const databaseHost = await store.upsertPage({name: 'Wave database host', data: snapshot()});
    const databaseResponse = await request('POST', '/api/databases', {
      pageId: databaseHost.id,
      name: 'Wave database',
      schema: {properties: [], views: []},
    });
    expect(databaseResponse.status).toBe(201);
    const createdDatabase = await databaseResponse.json() as StoredDatabase;
    expect((await request('PATCH', `/api/databases/${createdDatabase.id}`, {name: 'Wave database renamed'})).status)
      .toBe(200);
    expect((await request('DELETE', `/api/databases/${createdDatabase.id}`)).status).toBe(204);

    expect((await request('PUT', '/api/instance', {guestAccess: 'write'})).status).toBe(200);

    const captured = await db.query<{count: number | string}>(
      'SELECT count(*)::int AS count FROM idempotency_responses',
    );
    expect(Number(captured[0].count)).toBe(17);
  });
});
