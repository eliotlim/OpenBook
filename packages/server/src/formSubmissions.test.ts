import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FORM_SUBMISSION_PROPERTY_ID,
  FORWARDED_HEADER,
  generateSubmissionKey,
  mintIdentityKeypair,
  signIdentity,
  type DatabaseSchema,
  type FormField,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {
  FORM_SUBMISSION_MAX_BODY_BYTES,
  FORM_SUBMISSION_MAX_VALUE_BYTES,
} from './formAccess';

const ISS = 'https://account.book.pub';

let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const emptySnapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const formSnapshot = (props: Record<string, unknown>, id = `form-block-${seq}`) => ({
  // Mirrors projectBlockPageSnapshot: editorjs is the export projection, while
  // blockdoc retains the raw props/children consumed by the capability gate.
  editorjs: {blocks: [{id, type: 'form', data: {props, text: ''}}]},
  values: [],
  names: [],
  editor: 'blocks' as const,
  blockdoc: {v: 1 as const, update: '', blocks: [{id, type: 'form', props}]},
});

const identityFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `form-${sub}-${Math.random()}`,
      ...over,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-form-submit-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
  kp = await mintIdentityKeypair('form-k1');
  jwks = {keys: [kp.publicJwk]};
  await store.updateInstanceConfig({
    trustedIssuers: [{issuer: ISS, jwks}],
    ownerSubject: `${ISS}#owner`,
    guestAccess: 'read',
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

async function seedForm(over: {
  enabled?: boolean;
  visibility?: 'public' | 'members' | 'restricted';
  maxSubmissions?: number;
  fields?: FormField[];
  databaseSchema?: DatabaseSchema;
} = {}) {
  const page = await store.upsertPage({name: `form-host-${seq}`, data: emptySnapshot()});
  const database = await store.createDatabase({
    pageId: page.id,
    name: 'Submissions',
    schema: over.databaseSchema ?? {
      properties: [{id: 'email', name: 'Email', type: 'email'}],
      views: [],
    },
  });
  const formId = `contact-${seq}`;
  const submissionKey = generateSubmissionKey();
  const enabled = over.enabled ?? true;
  const props = {
    formId,
    submissionKey,
    enabled,
    databaseId: database.id,
    schema: {
      formId,
      submissionKey,
      enabled,
      databaseId: database.id,
      fields: over.fields ?? [{id: 'email', kind: 'email', label: 'Email', required: false, columnId: 'email'}],
      confirmation: {message: 'Received'},
      ...(over.maxSubmissions === undefined ? {} : {maxSubmissions: over.maxSubmissions}),
    },
  };
  await store.upsertPage({
    id: page.id,
    name: page.name,
    data: formSnapshot(props),
  });
  await store.setPageVisibility(page.id, over.visibility ?? 'public');
  return {pageId: page.id, databaseId: database.id, formId, submissionKey, props};
}

function submissionBody(key: string, idempotencyKey = `idem-${seq}`, values: Record<string, unknown> = {email: 'reader@example.com'}) {
  return JSON.stringify({key, values, idempotencyKey});
}

function submit(
  a: ReturnType<typeof app>,
  pageId: string,
  formId: string,
  body: string,
  opts: {jws?: string; clientHeader?: boolean; forwarded?: boolean} = {},
) {
  return a.request(`/api/pages/${pageId}/forms/${formId}/submissions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.clientHeader === false ? {} : {'X-OpenBook-Client': '1'}),
      ...(opts.jws ? {[IDENTITY_HEADER]: opts.jws} : {}),
      ...(opts.forwarded ? {[FORWARDED_HEADER]: '1'} : {}),
    },
    body,
  });
}

describe('POST /api/pages/:pageId/forms/:formId/submissions', () => {
  it('creates one provenance-stamped row for an anonymous capability on a forwarded public page', async () => {
    const seeded = await seedForm();
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey),
      {forwarded: true},
    );

    expect(response.status).toBe(201);
    const result = (await response.json()) as {rowId: string; submittedAt: string};
    expect(Number.isFinite(Date.parse(result.submittedAt))).toBe(true);
    const rows = await store.listRows(seeded.databaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.rowId);
    expect(rows[0].properties.email).toBe('reader@example.com');
    expect(rows[0].properties[FORM_SUBMISSION_PROPERTY_ID]).toEqual({
      formId: seeded.formId,
      submittedAt: result.submittedAt,
    });
  });

  it('returns schema field errors only after the capability gate passes', async () => {
    const seeded = await seedForm();
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `invalid-${seq}`, {email: 'not-an-email'}),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({errors: [{fieldId: 'email', code: 'email_format'}]});
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);

    const denied = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody('wrong-key', `invalid-denied-${seq}`, {email: 'not-an-email'}),
    );
    expect(`${denied.status}\n${await denied.text()}`).toBe('404\n{"error":"form not found"}');
  });

  it('silently fake-succeeds a tripped honeypot without creating a row', async () => {
    const seeded = await seedForm({
      fields: [
        {id: 'email', kind: 'email', label: 'Email', required: false, columnId: 'email'},
        {id: 'website', kind: 'text', label: 'Website', required: false, honeypot: true},
      ],
    });
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `honeypot-${seq}`, {
        email: 'bot@example.com',
        website: 'https://spam.example',
      }),
    );

    expect(response.status).toBe(201);
    const result = (await response.json()) as {rowId: string; submittedAt: string};
    expect(result.rowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(result.submittedAt))).toBe(true);
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);
  });

  it('projects validated field values onto bound database property ids', async () => {
    const seeded = await seedForm({
      fields: [{id: 'contactEmail', kind: 'email', label: 'Email', required: true, columnId: 'email'}],
    });
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `projected-${seq}`, {contactEmail: 'ada@example.com'}),
    );

    expect(response.status).toBe(201);
    const rows = await store.listRows(seeded.databaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].properties.email).toBe('ada@example.com');
    expect(rows[0].properties).not.toHaveProperty('contactEmail');
  });

  it('logs discarded projection warnings without changing the success response', async () => {
    const seeded = await seedForm({
      fields: [
        {id: 'unbound', kind: 'text', label: 'Unbound', required: false},
        {id: 'missing', kind: 'text', label: 'Missing', required: false, columnId: 'missing'},
        {id: 'mismatch', kind: 'text', label: 'Mismatch', required: false, columnId: 'email'},
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `warnings-${seq}`, {
        unbound: 'one',
        missing: 'two',
        mismatch: 'three',
      }),
    );

    expect(response.status).toBe(201);
    const result = await response.json() as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['rowId', 'submittedAt']);
    expect(warn).toHaveBeenCalledWith('OpenBook form submission projection discarded fields:', {
      pageId: seeded.pageId,
      formId: seeded.formId,
      warnings: [
        {fieldId: 'unbound', code: 'unbound_field'},
        {fieldId: 'missing', code: 'column_not_found'},
        {fieldId: 'mismatch', code: 'column_type_mismatch'},
      ],
    });
  });

  it.each([
    ['non-object schema', null],
    ['non-array fields', {fields: {}}],
  ] as const)('uniformly denies a persisted %s', async (_name, schema) => {
    const seeded = await seedForm();
    await store.upsertPage({
      id: seeded.pageId,
      name: `form-host-${seq}`,
      data: formSnapshot({...seeded.props, schema}),
    });

    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey));
    expect(`${response.status}\n${await response.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);
  });

  it('returns byte-identical denials for every existence/capability/read failure', async () => {
    const seeded = await seedForm();
    const a = app();
    const validBody = submissionBody(seeded.submissionKey);
    const responses: Response[] = [];

    responses.push(await submit(a, '00000000-0000-4000-8000-000000000001', seeded.formId, validBody));
    responses.push(await submit(a, seeded.pageId, 'missing-form', validBody));
    responses.push(await submit(a, seeded.pageId, seeded.formId, submissionBody('wrong-key')));
    responses.push(
      await submit(
        a,
        seeded.pageId,
        seeded.formId,
        JSON.stringify({values: {email: 'reader@example.com'}, idempotencyKey: `missing-key-${seq}`}),
      ),
    );

    await store.upsertPage({
      id: seeded.pageId,
      name: `form-host-${seq}`,
      data: formSnapshot({...seeded.props, enabled: false}),
    });
    responses.push(await submit(a, seeded.pageId, seeded.formId, validBody));

    await store.upsertPage({
      id: seeded.pageId,
      name: `form-host-${seq}`,
      data: formSnapshot(seeded.props),
    });
    await store.setPageVisibility(seeded.pageId, 'members');
    responses.push(await submit(a, seeded.pageId, seeded.formId, validBody));
    await store.setPageVisibility(seeded.pageId, 'restricted');
    responses.push(await submit(a, seeded.pageId, seeded.formId, validBody));
    await store.setPageVisibility(seeded.pageId, 'public');
    await store.updateInstanceConfig({guestAccess: 'off'});
    responses.push(await submit(a, seeded.pageId, seeded.formId, validBody));

    const fingerprints = await Promise.all(
      responses.map(async (response) => `${response.status}\n${await response.text()}`),
    );
    expect(new Set(fingerprints)).toEqual(new Set(['404\n{"error":"form not found"}']));
  });

  it('allows an authenticated owner who can read the host page (key still required)', async () => {
    const seeded = await seedForm({visibility: 'restricted'});
    const ownerJws = await identityFor('owner');
    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey), {
      jws: ownerJws,
      clientHeader: false,
    });
    expect(response.status).toBe(201);
    expect(await store.listRows(seeded.databaseId)).toHaveLength(1);
  });

  it('replays in the same millisecond with the exact original success and one edit-log row', async () => {
    const seeded = await seedForm();
    const a = app();
    const body = submissionBody(seeded.submissionKey, `stable-replay-${seq}`);
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-08-12T01:02:03.456Z');
    const first = await submit(a, seeded.pageId, seeded.formId, body);
    const firstBytes = await first.text();
    const replay = await submit(a, seeded.pageId, seeded.formId, body);
    const replayBytes = await replay.text();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayBytes).toBe(firstBytes);
    expect(await store.listRows(seeded.databaseId)).toHaveLength(1);
    const rowId = (JSON.parse(firstBytes) as {rowId: string}).rowId;
    expect((await store.listEdits(rowId)).filter((edit) => edit.kind === 'form.submit')).toHaveLength(1);
  });

  it('allows a submission below maxSubmissions and uniformly denies once the cap is reached', async () => {
    const seeded = await seedForm({maxSubmissions: 2});
    await store.createRow(seeded.databaseId, {name: 'existing'});

    const belowCap = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `below-cap-${seq}`),
    );
    expect(belowCap.status).toBe(201);
    expect(await store.countActiveRows(seeded.databaseId)).toBe(2);

    const atCap = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `at-cap-${seq}`),
    );
    expect(`${atCap.status}\n${await atCap.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.countActiveRows(seeded.databaseId)).toBe(2);
  });

  it('rejects raw-body and per-value oversize submissions', async () => {
    const seeded = await seedForm();
    const a = app();
    const bodyLimited = await submit(
      a,
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `body-big-${seq}`, {blob: 'x'.repeat(FORM_SUBMISSION_MAX_BODY_BYTES)}),
    );
    expect(bodyLimited.status).toBe(413);

    const valueLimited = await submit(
      a,
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `value-big-${seq}`, {blob: 'x'.repeat(FORM_SUBMISSION_MAX_VALUE_BYTES)}),
    );
    expect(valueLimited.status).toBe(400);
  });

  it('requires X-OpenBook-Client on an anonymous POST', async () => {
    const seeded = await seedForm();
    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey), {
      clientHeader: false,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'this write must originate from an OpenBook client (missing X-OpenBook-Client header)',
    });
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);
  });

  it('fails closed when form props point at a database hosted by another page', async () => {
    const seeded = await seedForm();
    const otherPage = await store.upsertPage({name: 'other', data: emptySnapshot()});
    const otherDatabase = await store.createDatabase({pageId: otherPage.id, name: 'Other'});
    await store.upsertPage({
      id: seeded.pageId,
      name: `form-host-${seq}`,
      data: formSnapshot({...seeded.props, databaseId: otherDatabase.id}),
    });
    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey));
    expect(`${response.status}\n${await response.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.listRows(otherDatabase.id)).toHaveLength(0);
  });

  it('uniformly denies a form bound to an authoritative managed database', async () => {
    const seeded = await seedForm();
    await store.setSetting('aiUsageDb', {databaseId: seeded.databaseId, hostPageId: seeded.pageId});

    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey));
    expect(`${response.status}\n${await response.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.countActiveRows(seeded.databaseId)).toBe(0);
  });

  it('uniformly denies a form bound to a ledger database before createRow can leak its managed 403', async () => {
    const info = await store.ledger.ensureSetup();
    const databaseId = info.databases!.transactions;
    const database = (await store.getDatabase(databaseId))!;
    const formId = `ledger-form-${seq}`;
    const submissionKey = generateSubmissionKey();
    const snapshot = formSnapshot({
      formId,
      submissionKey,
      enabled: true,
      databaseId,
      schema: {fields: []},
    }, `ledger-form-block-${seq}`);
    // Deliberately bypass the ledger store guard to exercise hostile persisted
    // state: ordinary APIs correctly cannot put a form on a ledger host page.
    await db.query('UPDATE pages SET data = $2::jsonb WHERE id = $1', [database.pageId, JSON.stringify(snapshot)]);
    const before = await store.countActiveRows(databaseId);

    const response = await submit(
      app(),
      database.pageId,
      formId,
      submissionBody(submissionKey, `ledger-${seq}`),
      {jws: await identityFor('owner'), clientHeader: false},
    );
    expect(`${response.status}\n${await response.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.countActiveRows(databaseId)).toBe(before);
  });
});
