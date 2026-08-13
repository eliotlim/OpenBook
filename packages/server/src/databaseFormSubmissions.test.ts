import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  FORM_UPLOAD_ORPHAN_TTL_MS,
  mintIdentityKeypair,
  signIdentity,
  type DatabaseSchema,
  type DatabaseView,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp, type AppOptions} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {
  AGENT_API_SETTING_KEY,
  generateAgentToken,
} from './agentTokens';
import {
  FORM_REQUEST_RATE_LIMIT,
  FORM_REQUEST_RATE_WINDOW_MS,
  FORM_SUBMISSION_MAX_BODY_BYTES,
} from './formAccess';

const ISS = 'https://account.book.pub';
const OWNER = `${ISS}#owner`;

let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;
let ownerJws: string;

const emptySnapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const baseProperties: DatabaseSchema['properties'] = [
  {id: 'email', name: 'Email', type: 'email', description: 'private builder help'},
  {id: 'score', name: 'Score', type: 'number', numberFormat: 'percent', numberTarget: 100},
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [{id: 'open', label: 'Open', color: 'green'}],
  },
  {id: 'documents', name: 'Documents', type: 'files', pageHidden: true},
  {id: 'unmapped', name: 'Internal note', type: 'text'},
  {id: 'managed', name: 'Created', type: 'created_time'},
  {id: 'sys_private', name: 'Reserved', type: 'text'},
];

const formView = (id: string, over: Partial<DatabaseView> = {}): DatabaseView => ({
  id,
  name: 'Contact form',
  type: 'form',
  filters: [],
  sorts: [],
  visiblePropertyIds: ['email', 'score', 'status'],
  formFields: {
    email: {required: true, label: 'Your email', help: 'Never exposed by the descriptor test'},
  },
  formConfig: {
    title: 'Get in touch',
    description: 'Send us a response',
    submitLabel: 'Send',
    confirmationMessage: 'Received',
    acceptingResponses: true,
  },
  ...over,
});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-database-form-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
  kp = await mintIdentityKeypair('database-form-k1');
  jwks = {keys: [kp.publicJwk]};
  await store.updateInstanceConfig({
    trustedIssuers: [{issuer: ISS, jwks}],
    ownerSubject: OWNER,
    guestAccess: 'off',
  });
  ownerJws = await signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub: 'owner',
      name: 'Owner',
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `database-form-${seq}`,
    },
    kp.publicJwk.kid,
  );
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = (options: AppOptions = {}) => createApp(store, undefined, new PageHub(), {
  identity: new IdentityService(store),
  ...options,
});

async function seedForm(over: {
  view?: DatabaseView;
  properties?: DatabaseSchema['properties'];
} = {}) {
  const page = await store.upsertPage({name: `form-host-${seq}-${Math.random()}`, data: emptySnapshot()});
  const view = over.view ?? formView(`view-${seq}-${Math.random()}`);
  const database = await store.createDatabase({
    pageId: page.id,
    name: 'Responses',
    schema: {properties: over.properties ?? baseProperties, views: [view]},
  });
  return {page, database, view};
}

async function publish(
  a: ReturnType<typeof app>,
  databaseId: string,
  viewId: string,
): Promise<{capability: string; url: string}> {
  const response = await a.request(`/api/databases/${databaseId}/views/${viewId}/capability`, {
    method: 'POST',
    headers: {[IDENTITY_HEADER]: ownerJws, 'X-OpenBook-Client': '1'},
  });
  expect(response.status).toBe(201);
  const {url} = (await response.json()) as {url: string};
  const capability = new URLSearchParams(new URL(url).hash.slice(1)).get('capability');
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return {capability: capability!, url};
}

function submit(
  a: ReturnType<typeof app>,
  databaseId: string,
  viewId: string,
  capability: string,
  fields: Record<string, unknown>,
  idempotencyKey = `submission-${seq}-${Math.random()}`,
  remoteAddress?: string,
) {
  return a.request(`/api/databases/${databaseId}/views/${viewId}/submissions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify({capability, fields, idempotencyKey}),
  }, remoteAddress ? {incoming: {socket: {remoteAddress}}} : undefined);
}

function upload(
  a: ReturnType<typeof app>,
  databaseId: string,
  viewId: string,
  capability: string,
  fieldId: string,
  bytes: Uint8Array,
) {
  return a.request(`/api/databases/${databaseId}/views/${viewId}/uploads`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify({
      capability,
      fieldId,
      name: 'answer.pdf',
      mime: 'application/pdf',
      data: Buffer.from(bytes).toString('base64'),
    }),
  });
}

describe('database form-view public fill', () => {
  it('creates exactly one mapped row with honest synthetic attribution and stable replay', async () => {
    const seeded = await seedForm();
    const a = app({accessToken: 'instance-wide-secret'});
    const {capability} = await publish(app(), seeded.database.id, seeded.view.id);
    const idempotencyKey = `stable-${seq}`;

    const first = await submit(
      a,
      seeded.database.id,
      seeded.view.id,
      capability,
      {email: 'reader@example.com', score: 0, status: 'open'},
      idempotencyKey,
    );
    expect(first.status).toBe(201);
    const result = (await first.json()) as {rowId: string; submittedAt: string};
    const replay = await submit(
      a,
      seeded.database.id,
      seeded.view.id,
      capability,
      {email: 'changed@example.com', score: 99},
      idempotencyKey,
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(result);

    const rows = await store.listRows(seeded.database.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.rowId,
      name: null,
      properties: {email: 'reader@example.com', score: 0, status: 'open'},
    });
    expect(Object.keys(rows[0].properties).sort()).toEqual(['email', 'score', 'status']);
    const page = await store.getPage(result.rowId);
    expect(page?.data.authors).toBeUndefined();
    const edits = await store.listEdits(result.rowId);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      authorSubject: `form:${seeded.view.id}`,
      authorIssuer: '',
      authorName: 'Public form',
      verifiedVia: 'guest',
      kind: 'database.form.submit',
    });
  });

  it('rejects unmapped, managed, and reserved column injection without creating a row', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);
    const response = await submit(a, seeded.database.id, seeded.view.id, capability, {
      email: 'reader@example.com',
      unmapped: 'steal this column',
      managed: '2026-08-13T00:00:00.000Z',
      sys_private: 'reserved',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({errors: [
      {propertyId: 'unmapped', code: 'unknown_field'},
      {propertyId: 'managed', code: 'unknown_field'},
      {propertyId: 'sys_private', code: 'unknown_field'},
    ]});
    expect(await store.listRows(seeded.database.id)).toHaveLength(0);
  });

  it('requires the non-simple OpenBook client header before capability processing', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);
    const response = await a.request(
      `/api/databases/${seeded.database.id}/views/${seeded.view.id}/submissions`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({capability, fields: {email: 'reader@example.com'}, idempotencyKey: 'csrf'}),
      },
    );
    expect(response.status).toBe(403);
    expect(await store.listRows(seeded.database.id)).toHaveLength(0);
  });

  it('isolates capabilities and idempotency scopes and rejects oversized bodies', async () => {
    const first = await seedForm();
    const second = await seedForm();
    const a = app();
    const firstPublished = await publish(a, first.database.id, first.view.id);
    const secondPublished = await publish(a, second.database.id, second.view.id);

    expect((await submit(
      a,
      second.database.id,
      second.view.id,
      firstPublished.capability,
      {email: 'reader@example.com'},
      'shared-idempotency-key',
    )).status).toBe(404);
    expect((await submit(
      a,
      first.database.id,
      first.view.id,
      firstPublished.capability,
      {email: 'first@example.com'},
      'shared-idempotency-key',
    )).status).toBe(201);
    expect((await submit(
      a,
      second.database.id,
      second.view.id,
      secondPublished.capability,
      {email: 'second@example.com'},
      'shared-idempotency-key',
    )).status).toBe(201);
    expect(await store.listRows(first.database.id)).toHaveLength(1);
    expect(await store.listRows(second.database.id)).toHaveLength(1);

    const oversized = await a.request(
      `/api/databases/${first.database.id}/views/${first.view.id}/submissions`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
        body: JSON.stringify({
          capability: firstPublished.capability,
          fields: {email: 'reader@example.com', padding: 'x'.repeat(FORM_SUBMISSION_MAX_BODY_BYTES)},
          idempotencyKey: 'oversized',
        }),
      },
    );
    expect(oversized.status).toBe(413);
    expect(await store.listRows(first.database.id)).toHaveLength(1);
  });

  it('enforces required/format rules and the current column type when a client is stale', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);

    const missing = await submit(a, seeded.database.id, seeded.view.id, capability, {});
    expect(await missing.json()).toEqual({errors: [{propertyId: 'email', code: 'required'}]});
    const malformed = await submit(a, seeded.database.id, seeded.view.id, capability, {email: 'not-an-email'});
    expect(await malformed.json()).toEqual({errors: [{propertyId: 'email', code: 'email_format'}]});

    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...current.schema,
        properties: current.schema.properties.map((property) =>
          property.id === 'email' ? {...property, type: 'number'} : property),
      },
    });
    const stale = await submit(a, seeded.database.id, seeded.view.id, capability, {email: 'reader@example.com'});
    expect(await stale.json()).toEqual({errors: [{propertyId: 'email', code: 'type'}]});
    expect(await store.listRows(seeded.database.id)).toHaveLength(0);
  });

  it('returns byte-identical hidden denials for wrong, revoked, stopped, unknown, and managed states', async () => {
    const seeded = await seedForm();
    const a = app();
    const first = await publish(a, seeded.database.id, seeded.view.id);
    const wrong = await submit(a, seeded.database.id, seeded.view.id, 'wrong', {email: 'reader@example.com'});

    const revokedResponse = await a.request(
      `/api/databases/${seeded.database.id}/views/${seeded.view.id}/capability`,
      {method: 'DELETE', headers: {[IDENTITY_HEADER]: ownerJws, 'X-OpenBook-Client': '1'}},
    );
    expect(revokedResponse.status).toBe(204);
    const revoked = await submit(a, seeded.database.id, seeded.view.id, first.capability, {email: 'reader@example.com'});

    const second = await publish(a, seeded.database.id, seeded.view.id);
    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...current.schema,
        views: current.schema.views.map((view) => ({
          ...view,
          formConfig: {...view.formConfig, acceptingResponses: false},
        })),
      },
    });
    const stopped = await submit(a, seeded.database.id, seeded.view.id, second.capability, {email: 'reader@example.com'});
    const unknown = await submit(a, crypto.randomUUID(), seeded.view.id, second.capability, {email: 'reader@example.com'});

    const reopened = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(reopened.id, {
      schema: {
        ...reopened.schema,
        views: reopened.schema.views.map((view) => ({
          ...view,
          formConfig: {...view.formConfig, acceptingResponses: true},
        })),
      },
    });
    await store.setSetting('aiUsageDb', {databaseId: seeded.database.id, hostPageId: seeded.page.id});
    const managed = await submit(a, seeded.database.id, seeded.view.id, second.capability, {email: 'reader@example.com'});

    const denied = async (response: Response) => `${response.status}\n${await response.text()}`;
    const expected = '404\n{"error":"form not found"}';
    expect(await denied(wrong)).toBe(expected);
    expect(await denied(revoked)).toBe(expected);
    expect(await denied(stopped)).toBe(expected);
    expect(await denied(unknown)).toBe(expected);
    expect(await denied(managed)).toBe(expected);
  });

  it('exposes only sanitized form copy and current mapped field descriptors, never rows or schema', async () => {
    const seeded = await seedForm();
    await store.createRow(seeded.database.id, {properties: {email: 'existing@example.com', unmapped: 'secret'}});
    const a = app();
    const {url} = await publish(a, seeded.database.id, seeded.view.id);
    const descriptorResponse = await a.request(new URL(url).pathname);
    expect(descriptorResponse.status).toBe(200);
    expect(await descriptorResponse.json()).toEqual({
      formConfig: {
        title: 'Get in touch',
        description: 'Send us a response',
        submitLabel: 'Send',
        confirmationMessage: 'Received',
        acceptingResponses: true,
      },
      fields: [
        {id: 'email', name: 'Email', type: 'email'},
        {id: 'score', name: 'Score', type: 'number'},
        {id: 'status', name: 'Status', type: 'select', options: [{id: 'open', label: 'Open', color: 'green'}]},
      ],
    });

    expect((await a.request(`/api/databases/${seeded.database.id}`)).status).toBe(401);
    expect((await a.request(`/api/databases/${seeded.database.id}/rows`)).status).toBe(401);
    expect((await a.request(`/api/databases/${seeded.database.id}/stream`)).status).toBe(401);
  });

  it('rotates without retaining plaintext, gives a duplicated view a distinct capability, and revokes on deleteView', async () => {
    const seeded = await seedForm();
    const a = app();
    const first = await publish(a, seeded.database.id, seeded.view.id);
    const rotated = await publish(a, seeded.database.id, seeded.view.id);
    expect(rotated.capability).not.toBe(first.capability);
    expect((await submit(a, seeded.database.id, seeded.view.id, first.capability, {email: 'reader@example.com'})).status).toBe(404);

    const [stored] = await db.query<{capability_hash: string}>(
      'SELECT capability_hash FROM database_form_capabilities WHERE database_id = $1 AND view_id = $2',
      [seeded.database.id, seeded.view.id],
    );
    expect(stored.capability_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.capability_hash).not.toContain(rotated.capability);

    const duplicate = {...seeded.view, id: `${seeded.view.id}-copy`, name: 'Contact form copy'};
    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {schema: {...current.schema, views: [seeded.view, duplicate]}});
    expect(await store.getDatabaseFormCapabilityHash(current.id, duplicate.id)).toBeNull();
    const duplicatePublished = await publish(a, current.id, duplicate.id);
    expect(duplicatePublished.capability).not.toBe(rotated.capability);

    const withDuplicate = (await store.getDatabase(current.id))!;
    await store.updateDatabase(current.id, {
      schema: {...withDuplicate.schema, views: withDuplicate.schema.views.filter((view) => view.id !== seeded.view.id)},
    });
    expect(await store.getDatabaseFormCapabilityHash(current.id, seeded.view.id)).toBeNull();
    expect((await submit(a, current.id, seeded.view.id, rotated.capability, {email: 'reader@example.com'})).status).toBe(404);

    const duplicateIdState = (await store.getDatabase(current.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...duplicateIdState.schema,
        views: [duplicate, {...duplicate, name: 'Ambiguous copy'}],
      },
    });
    expect(await store.getDatabaseFormCapabilityHash(current.id, duplicate.id)).toBeNull();
  });

  it('fails closed on malformed persisted mappings instead of exposing a public error', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability, url} = await publish(a, seeded.database.id, seeded.view.id);
    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...current.schema,
        views: current.schema.views.map((view) => view.id === seeded.view.id
          ? {...view, visiblePropertyIds: 'email' as unknown as string[]}
          : view),
      },
    });

    const descriptor = await a.request(new URL(url).pathname);
    const submission = await submit(
      a,
      seeded.database.id,
      seeded.view.id,
      capability,
      {email: 'reader@example.com'},
    );
    expect(`${descriptor.status}\n${await descriptor.text()}`).toBe('404\n{"error":"form not found"}');
    expect(`${submission.status}\n${await submission.text()}`).toBe('404\n{"error":"form not found"}');
  });

  it('binds staged files to the active capability and resolves only freshly staged tokens', async () => {
    const view = formView(`files-${seq}`, {
      visiblePropertyIds: ['email', 'documents'],
    });
    const seeded = await seedForm({view});
    const a = app();
    const first = await publish(a, seeded.database.id, view.id);
    const stagedOld = await upload(a, seeded.database.id, view.id, first.capability, 'documents', new Uint8Array([1, 2, 3]));
    expect(stagedOld.status).toBe(201);
    const oldToken = ((await stagedOld.json()) as {token: string}).token;

    const rotated = await publish(a, seeded.database.id, view.id);
    const crossRotation = await submit(a, seeded.database.id, view.id, rotated.capability, {
      email: 'reader@example.com',
      documents: [oldToken],
    });
    expect(crossRotation.status).toBe(400);
    expect(await crossRotation.json()).toEqual({error: 'invalid or expired form upload'});

    const staged = await upload(a, seeded.database.id, view.id, rotated.capability, 'documents', new Uint8Array([4, 5, 6]));
    expect(staged.status).toBe(201);
    const token = ((await staged.json()) as {token: string}).token;
    const accepted = await submit(a, seeded.database.id, view.id, rotated.capability, {
      email: 'reader@example.com',
      documents: [token],
    });
    expect(accepted.status).toBe(201);
    const [row] = await store.listRows(seeded.database.id);
    expect(row.properties.documents).toEqual([
      expect.stringMatching(/^\/api\/assets\/[0-9a-f]{64}\?filename=answer\.pdf$/),
    ]);
    expect(await store.gcExpiredFormUploads(FORM_UPLOAD_ORPHAN_TTL_MS)).toMatchObject({reaped: expect.any(Number)});
  });

  it('trips independently per capability and per trusted socket IP with Retry-After', async () => {
    const capSeed = await seedForm();
    const capApp = app();
    const cap = await publish(capApp, capSeed.database.id, capSeed.view.id);
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const response = await submit(
        capApp,
        capSeed.database.id,
        capSeed.view.id,
        cap.capability,
        {unmapped: 'invalid'},
        `cap-${i}`,
        `10.0.0.${i + 1}`,
      );
      expect(response.status).toBe(400);
    }
    const capabilityLimited = await submit(
      capApp,
      capSeed.database.id,
      capSeed.view.id,
      cap.capability,
      {unmapped: 'invalid'},
      'cap-over',
      '10.0.1.1',
    );
    expect(capabilityLimited.status).toBe(429);
    expect(capabilityLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));

    const first = await seedForm();
    const second = await seedForm();
    const ipApp = app();
    const firstCap = await publish(ipApp, first.database.id, first.view.id);
    const secondCap = await publish(ipApp, second.database.id, second.view.id);
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const target = i % 2 === 0
        ? {seeded: first, capability: firstCap.capability}
        : {seeded: second, capability: secondCap.capability};
      const response = await submit(
        ipApp,
        target.seeded.database.id,
        target.seeded.view.id,
        target.capability,
        {unmapped: 'invalid'},
        `ip-${i}`,
        '10.10.10.10',
      );
      expect(response.status).toBe(400);
    }
    const ipLimited = await submit(
      ipApp,
      first.database.id,
      first.view.id,
      firstCap.capability,
      {unmapped: 'invalid'},
      'ip-over',
      '10.10.10.10',
    );
    expect(ipLimited.status).toBe(429);
    expect(ipLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));
  });

  it('denies PAT mint and revoke attempts at the scope gate', async () => {
    const seeded = await seedForm();
    const a = app();
    await publish(a, seeded.database.id, seeded.view.id);
    await store.setSetting(AGENT_API_SETTING_KEY, {enabled: true});
    const generated = generateAgentToken();
    await store.createAgentToken({
      name: 'form-control-attempt',
      tokenHash: generated.hash,
      preview: generated.preview,
      subject: OWNER,
      issuer: ISS,
      scope: 'write',
      createdBy: 'test',
      expiresAt: null,
    });
    const headers = {Authorization: `Bearer ${generated.token}`, 'X-OpenBook-Client': '1'};
    const path = `/api/databases/${seeded.database.id}/views/${seeded.view.id}/capability`;
    expect((await a.request(path, {method: 'POST', headers})).status).toBe(403);
    expect((await a.request(path, {method: 'DELETE', headers})).status).toBe(403);
    expect(await store.getDatabaseFormCapabilityHash(seeded.database.id, seeded.view.id)).not.toBeNull();
  });
});
