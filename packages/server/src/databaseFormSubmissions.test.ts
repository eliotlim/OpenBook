import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  API,
  FORM_SUBMISSION_PROPERTY_ID,
  FORM_UPLOAD_ORPHAN_TTL_MS,
  TITLE_PROPERTY_ID,
  mintIdentityKeypair,
  signIdentity,
  type DatabaseFormDescriptor,
  type DatabaseFormSubmissionMarker,
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
  databaseFormResponseCap,
  FORM_REQUEST_RATE_LIMIT,
  FORM_REQUEST_RATE_WINDOW_MS,
  FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS,
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
  {id: 'bio', name: 'Biography', type: 'text'},
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
    confirmation: {type: 'message', message: 'Received'},
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
  expect(new URL(url).pathname).toBe(API.databaseForm(databaseId, viewId));
  return {capability: capability!, url};
}

function descriptor(
  a: ReturnType<typeof app>,
  databaseId: string,
  viewId: string,
  capability: string,
  remoteAddress?: string,
) {
  return a.request(API.databaseForm(databaseId, viewId), {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify({capability}),
  }, remoteAddress ? {incoming: {socket: {remoteAddress}}} : undefined);
}

function submit(
  a: ReturnType<typeof app>,
  databaseId: string,
  viewId: string,
  capability: string,
  fields: Record<string, unknown>,
  idempotencyKey: string = crypto.randomUUID(),
  remoteAddress?: string,
) {
  return a.request(API.databaseFormSubmissions(databaseId, viewId), {
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
    const idempotencyKey = crypto.randomUUID();

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
      name: '',
      properties: {email: 'reader@example.com', score: 0, status: 'open'},
    });
    expect(Object.keys(rows[0].properties).sort()).toEqual([
      'email',
      'score',
      'status',
      FORM_SUBMISSION_PROPERTY_ID,
    ]);
    const marker = rows[0].properties[FORM_SUBMISSION_PROPERTY_ID] as DatabaseFormSubmissionMarker;
    expect(marker).toEqual({submittedViaViewId: seeded.view.id, submittedAt: result.submittedAt});
    expect(await store.countDatabaseFormResponses(seeded.database.id, seeded.view.id)).toBe(1);
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

  it('rejects low-entropy idempotency keys before claiming a shared replay scope', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);
    const response = await submit(
      a,
      seeded.database.id,
      seeded.view.id,
      capability,
      {email: 'reader@example.com'},
      'predictable',
    );
    expect(`${response.status}\n${await response.text()}`).toBe('400\n{"error":"invalid form submission"}');
    expect(await store.listRows(seeded.database.id)).toHaveLength(0);
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

  it('passes the mapped virtual title through to createRow and uses an explicit empty title when unmapped', async () => {
    const titleView = formView(`title-${seq}`, {
      visiblePropertyIds: [TITLE_PROPERTY_ID, 'email'],
      formFields: {
        [TITLE_PROPERTY_ID]: {required: true, validation: {minLength: 2}},
        email: {required: true},
      },
    });
    const seeded = await seedForm({view: titleView});
    const a = app();
    const {capability} = await publish(a, seeded.database.id, titleView.id);

    const missing = await submit(a, seeded.database.id, titleView.id, capability, {email: 'reader@example.com'});
    expect(await missing.json()).toEqual({errors: [{propertyId: TITLE_PROPERTY_ID, code: 'required'}]});

    const named = await submit(a, seeded.database.id, titleView.id, capability, {
      [TITLE_PROPERTY_ID]: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    expect(named.status).toBe(201);
    const namedResult = await named.json() as {rowId: string};
    const namedRow = await store.getPage(namedResult.rowId);
    expect(namedRow?.name).toBe('Ada Lovelace');
    expect(namedRow?.properties).not.toHaveProperty(TITLE_PROPERTY_ID);

    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...current.schema,
        views: current.schema.views.map((view) => view.id === titleView.id
          ? {...view, visiblePropertyIds: ['email']}
          : view),
      },
    });
    const injected = await submit(a, seeded.database.id, titleView.id, capability, {
      [TITLE_PROPERTY_ID]: 'Not accepted',
      email: 'reader@example.com',
    });
    expect(await injected.json()).toEqual({errors: [{propertyId: TITLE_PROPERTY_ID, code: 'unknown_field'}]});

    const untitled = await submit(a, seeded.database.id, titleView.id, capability, {email: 'reader@example.com'});
    expect(untitled.status).toBe(201);
    const untitledResult = await untitled.json() as {rowId: string};
    expect((await store.getPage(untitledResult.rowId))?.name).toBe('');
  });

  it('enforces the per-view marker ceiling without counting ordinary, legacy, or other-view rows', async () => {
    expect(databaseFormResponseCap(formView('default-cap'))).toBe(FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS);
    const limitedView = formView(`limited-${seq}`, {
      formConfig: {
        title: 'Limited',
        acceptingResponses: true,
        maxResponses: 1,
      },
    });
    const seeded = await seedForm({view: limitedView});
    const submittedAt = new Date().toISOString();
    await store.createRow(seeded.database.id, {properties: {email: 'ordinary@example.com'}});
    await store.createRow(seeded.database.id, {
      properties: {[FORM_SUBMISSION_PROPERTY_ID]: {formId: 'legacy-form', submittedAt}},
    });
    await store.createRow(seeded.database.id, {
      properties: {
        [FORM_SUBMISSION_PROPERTY_ID]: {
          submittedViaViewId: 'another-view',
          submittedAt,
        } satisfies DatabaseFormSubmissionMarker,
      },
    });

    const a = app();
    const {capability} = await publish(a, seeded.database.id, limitedView.id);
    const firstKey = crypto.randomUUID();
    const first = await submit(
      a,
      seeded.database.id,
      limitedView.id,
      capability,
      {email: 'first@example.com'},
      firstKey,
    );
    expect(first.status).toBe(201);
    const firstResult = await first.json();
    const replay = await submit(
      a,
      seeded.database.id,
      limitedView.id,
      capability,
      {email: 'changed@example.com'},
      firstKey,
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstResult);

    const overLimit = await submit(a, seeded.database.id, limitedView.id, capability, {
      email: 'second@example.com',
    });
    expect(`${overLimit.status}\n${await overLimit.text()}`).toBe('429\n{"error":"response limit reached"}');
    expect(await store.countDatabaseFormResponses(seeded.database.id, limitedView.id)).toBe(1);
    expect(await store.listRows(seeded.database.id)).toHaveLength(4);
  });

  it('returns form_closed only after a valid capability and keeps all hidden states byte-identical', async () => {
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
          formConfig: {...view.formConfig, acceptingResponses: false, closedMessage: 'Back soon'},
        })),
      },
    });
    const stopped = await submit(a, seeded.database.id, seeded.view.id, second.capability, {email: 'reader@example.com'});
    const wrongWhileStopped = await submit(a, seeded.database.id, seeded.view.id, 'wrong', {email: 'reader@example.com'});
    const closedDescriptor = await descriptor(a, seeded.database.id, seeded.view.id, second.capability);
    const unknown = await submit(a, crypto.randomUUID(), seeded.view.id, second.capability, {email: 'reader@example.com'});

    expect(`${stopped.status}\n${await stopped.text()}`).toBe('403\n{"error":"form_closed"}');
    expect(closedDescriptor.status).toBe(200);
    expect(await closedDescriptor.json()).toMatchObject({
      acceptingResponses: false,
      closedMessage: 'Back soon',
    });

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
    expect(await denied(wrongWhileStopped)).toBe(expected);
    expect(await denied(unknown)).toBe(expected);
    expect(await denied(managed)).toBe(expected);
  });

  it('denies submissions while the host page is trashed and accepts them after restore', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);

    expect(await store.deletePage(seeded.page.id)).toBe(true);
    const trashed = await submit(a, seeded.database.id, seeded.view.id, capability, {
      email: 'trashed@example.com',
    });
    expect(`${trashed.status}\n${await trashed.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.listRows(seeded.database.id)).toHaveLength(0);

    expect(await store.restorePage(seeded.page.id)).not.toBeNull();
    const restored = await submit(a, seeded.database.id, seeded.view.id, capability, {
      email: 'restored@example.com',
    });
    expect(restored.status).toBe(201);
    expect(await store.listRows(seeded.database.id)).toHaveLength(1);
  });

  it('POSTs the fragment capability in the body and returns only the SDK descriptor projection', async () => {
    const view = formView(`descriptor-${seq}`, {
      visiblePropertyIds: ['email', 'bio', 'score', 'status'],
      formFields: {
        email: {required: true, label: 'Your email', help: 'We never publish the column description'},
        bio: {
          multiline: true,
          placeholder: 'Tell us about yourself',
          validation: {minLength: 4, maxLength: 200, pattern: '^[A-Z]'},
        },
        score: {validation: {min: 0, max: 100}},
      },
    });
    const seeded = await seedForm({view});
    await store.createRow(seeded.database.id, {properties: {email: 'existing@example.com', unmapped: 'secret'}});
    const a = app();
    const {capability, url} = await publish(a, seeded.database.id, seeded.view.id);
    const descriptorResponse = await descriptor(a, seeded.database.id, seeded.view.id, capability);
    expect(descriptorResponse.status).toBe(200);
    expect(await descriptorResponse.json() as DatabaseFormDescriptor).toEqual({
      title: 'Get in touch',
      description: 'Send us a response',
      submitLabel: 'Send',
      acceptingResponses: true,
      fields: [
        {
          propertyId: 'email',
          type: 'email',
          label: 'Your email',
          help: 'We never publish the column description',
          required: true,
          placeholder: '',
        },
        {
          propertyId: 'bio',
          type: 'text',
          label: 'Biography',
          help: '',
          required: false,
          placeholder: 'Tell us about yourself',
          multiline: true,
          validation: {minLength: 4, maxLength: 200},
        },
        {
          propertyId: 'score',
          type: 'number',
          label: 'Score',
          help: '',
          required: false,
          placeholder: '',
          validation: {min: 0, max: 100},
          numberTarget: 100,
        },
        {
          propertyId: 'status',
          type: 'select',
          label: 'Status',
          help: '',
          required: false,
          placeholder: '',
          options: [{id: 'open', label: 'Open', color: 'green'}],
        },
      ],
    });

    const queryOnly = await a.request(`${new URL(url).pathname}?capability=${encodeURIComponent(capability)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({}),
    });
    expect(`${queryOnly.status}\n${await queryOnly.text()}`).toBe('404\n{"error":"form not found"}');

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
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);
    const current = (await store.getDatabase(seeded.database.id))!;
    await store.updateDatabase(current.id, {
      schema: {
        ...current.schema,
        views: current.schema.views.map((view) => view.id === seeded.view.id
          ? {...view, visiblePropertyIds: 'email' as unknown as string[]}
          : view),
      },
    });

    const descriptorResponse = await descriptor(a, seeded.database.id, seeded.view.id, capability);
    const submission = await submit(
      a,
      seeded.database.id,
      seeded.view.id,
      capability,
      {email: 'reader@example.com'},
    );
    expect(`${descriptorResponse.status}\n${await descriptorResponse.text()}`).toBe('404\n{"error":"form not found"}');
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

  it('trips per capability and isolates the trusted socket budget per database form', async () => {
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
        `capability-rate-limit-key-${i}`,
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
      'capability-rate-limit-over',
      '10.0.1.1',
    );
    expect(capabilityLimited.status).toBe(429);
    expect(capabilityLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));

    const first = await seedForm();
    const second = await seedForm();
    const ipApp = app();
    const firstCap = await publish(ipApp, first.database.id, first.view.id);
    const secondCap = await publish(ipApp, second.database.id, second.view.id);
    for (let i = 0; i <= FORM_REQUEST_RATE_LIMIT; i += 1) {
      const target = i % 2 === 0
        ? {seeded: first, capability: firstCap.capability}
        : {seeded: second, capability: secondCap.capability};
      const response = await submit(
        ipApp,
        target.seeded.database.id,
        target.seeded.view.id,
        target.capability,
        {unmapped: 'invalid'},
        `trusted-peer-rate-limit-key-${i}`,
        '10.10.10.10',
      );
      expect(response.status).toBe(400);
    }
  });

  it('meters wrong capabilities before both gates and early-429s an exhausted peer', async () => {
    const descriptorSeed = await seedForm();
    const descriptorApp = app();
    const descriptorCap = await publish(descriptorApp, descriptorSeed.database.id, descriptorSeed.view.id);
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const response = await descriptor(
        descriptorApp,
        descriptorSeed.database.id,
        descriptorSeed.view.id,
        'wrong-capability',
        '10.20.30.40',
      );
      expect(response.status).toBe(404);
    }
    const descriptorLimited = await descriptor(
      descriptorApp,
      descriptorSeed.database.id,
      descriptorSeed.view.id,
      'wrong-capability',
      '10.20.30.40',
    );
    expect(descriptorLimited.status).toBe(429);
    expect(descriptorLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));
    expect((await descriptor(
      descriptorApp,
      descriptorSeed.database.id,
      descriptorSeed.view.id,
      descriptorCap.capability,
      '10.20.30.40',
    )).status).toBe(429);

    const submitSeed = await seedForm();
    const submitApp = app();
    const submitCap = await publish(submitApp, submitSeed.database.id, submitSeed.view.id);
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const response = await submit(
        submitApp,
        submitSeed.database.id,
        submitSeed.view.id,
        'wrong-capability',
        {email: 'reader@example.com'},
        crypto.randomUUID(),
        '10.20.30.41',
      );
      expect(response.status).toBe(404);
    }
    const submitLimited = await submit(
      submitApp,
      submitSeed.database.id,
      submitSeed.view.id,
      'wrong-capability',
      {email: 'reader@example.com'},
      crypto.randomUUID(),
      '10.20.30.41',
    );
    expect(submitLimited.status).toBe(429);
    expect(submitLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));
    expect((await submit(
      submitApp,
      submitSeed.database.id,
      submitSeed.view.id,
      submitCap.capability,
      {email: 'reader@example.com'},
      crypto.randomUUID(),
      '10.20.30.41',
    )).status).toBe(429);
  });

  it('uses the shared peer fallback instead of the 30-request instance-global bucket', async () => {
    const first = await seedForm();
    const second = await seedForm();
    const a = app();
    await publish(a, first.database.id, first.view.id);
    await publish(a, second.database.id, second.view.id);

    // No socket environment is supplied, so clientIpKey returns `peer`. These
    // failed gates would trip the old instance-global 30/minute bucket; the shared
    // fallback is both larger and namespaced to each database form.
    for (let i = 0; i <= FORM_REQUEST_RATE_LIMIT; i += 1) {
      const target = i % 2 === 0 ? first : second;
      const response = await submit(
        a,
        target.database.id,
        target.view.id,
        'wrong-capability',
        {email: 'reader@example.com'},
      );
      expect(response.status).toBe(404);
    }
  });

  it('applies the post-auth capability limiter to descriptor reads', async () => {
    const seeded = await seedForm();
    const a = app();
    const {capability} = await publish(a, seeded.database.id, seeded.view.id);
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      expect((await descriptor(
        a,
        seeded.database.id,
        seeded.view.id,
        capability,
        `10.30.0.${i + 1}`,
      )).status).toBe(200);
    }
    const limited = await descriptor(a, seeded.database.id, seeded.view.id, capability, '10.31.0.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));
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
