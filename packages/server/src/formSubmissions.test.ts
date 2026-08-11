import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  FORM_SUBMISSION_PROPERTY_ID,
  FORM_UPLOAD_MAX_FILE_BYTES,
  FORM_UPLOAD_MAX_FORM_BYTES,
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
import {createApp, type AppOptions} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {
  FORM_SUBMISSION_MAX_BODY_BYTES,
  FORM_SUBMISSION_MAX_VALUE_BYTES,
  FORM_REQUEST_RATE_LIMIT,
  FORM_REQUEST_RATE_WINDOW_MS,
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

const app = (options: AppOptions = {}) => createApp(store, undefined, new PageHub(), {
  ...options,
  identity: new IdentityService(store),
});

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

function upload(
  a: ReturnType<typeof app>,
  pageId: string,
  formId: string,
  key: string,
  fieldId: string,
  bytes: Uint8Array,
  over: {name?: string; mime?: string} = {},
) {
  return a.request(`/api/pages/${pageId}/forms/${formId}/uploads`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify({
      key,
      fieldId,
      name: over.name ?? 'upload.bin',
      mime: over.mime ?? 'application/octet-stream',
      data: Buffer.from(bytes).toString('base64'),
    }),
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

describe('FORM-6 staged uploads and abuse controls', () => {
  const filesField: FormField = {
    id: 'documents',
    kind: 'files',
    label: 'Documents',
    required: false,
    columnId: 'documents',
  };
  const filesDatabase: DatabaseSchema = {
    properties: [{id: 'documents', name: 'Documents', type: 'files'}],
    views: [],
  };

  it('stages opaque tokens, stores asset URLs on one row, and replays safely', async () => {
    const seeded = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const a = app();
    const bytes = new Uint8Array([60, 115, 99, 114, 105, 112, 116, 62]);
    const stagedResponse = await upload(
      a,
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      bytes,
      {name: 'résumé.pdf', mime: 'text/html'},
    );
    expect(stagedResponse.status).toBe(201);
    const staged = (await stagedResponse.json()) as {token: string; name: string; size: number};
    expect(staged).toMatchObject({name: 'résumé.pdf', size: bytes.byteLength});
    expect(staged.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(staged.token).not.toContain(Buffer.from(bytes).toString('hex'));

    const body = submissionBody(seeded.submissionKey, `files-${seq}`, {documents: [staged.token]});
    const first = await submit(a, seeded.pageId, seeded.formId, body);
    const firstBody = await first.text();
    const replay = await submit(a, seeded.pageId, seeded.formId, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstBody);

    const rows = await store.listRows(seeded.databaseId);
    expect(rows).toHaveLength(1);
    const values = rows[0].properties.documents as string[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^\/api\/assets\/[0-9a-f]{64}\?filename=/);
    expect(values[0]).toContain(encodeURIComponent('résumé.pdf'));
    const assetId = /\/api\/assets\/([0-9a-f]{64})/.exec(values[0])![1];
    expect(await store.getAsset(assetId)).toMatchObject({mime: 'application/octet-stream', size: bytes.byteLength});

    const served = await a.request(`/api/assets/${assetId}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toBe('attachment');
  });

  it('rejects a decoded file over 5 MiB with 413', async () => {
    const seeded = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const response = await upload(
      app(),
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      new Uint8Array(FORM_UPLOAD_MAX_FILE_BYTES + 1),
    );
    expect(response.status).toBe(413);
  });

  it('rejects more than five upload tokens in one submission', async () => {
    const seeded = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const a = app();
    const tokens: string[] = [];
    for (let i = 0; i <= 5; i += 1) {
      const response = await upload(
        a,
        seeded.pageId,
        seeded.formId,
        seeded.submissionKey,
        filesField.id,
        new Uint8Array([i + 1]),
      );
      tokens.push(((await response.json()) as {token: string}).token);
    }
    const response = await submit(
      a,
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `too-many-files-${seq}`, {documents: tokens}),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: 'too many files'});
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);
  });

  it('uses the submission route\'s byte-identical 404 for wrong keys and forms without files', async () => {
    const files = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const a = app();
    const uploadDenied = await upload(a, files.pageId, files.formId, 'wrong-key', filesField.id, new Uint8Array([1]));
    const submitDenied = await submit(a, files.pageId, files.formId, submissionBody('wrong-key'));
    expect(`${uploadDenied.status}\n${await uploadDenied.text()}`).toBe(`${submitDenied.status}\n${await submitDenied.text()}`);
    expect(`${submitDenied.status}`).toBe('404');

    const noFiles = await seedForm();
    const carveOutDenied = await upload(
      app(),
      noFiles.pageId,
      noFiles.formId,
      noFiles.submissionKey,
      'email',
      new Uint8Array([1]),
    );
    expect(`${carveOutDenied.status}\n${await carveOutDenied.text()}`).toBe('404\n{"error":"form not found"}');
  });

  it('returns 429 plus Retry-After when either public form route floods its window', async () => {
    const submitSeed = await seedForm();
    const submitApp = app();
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const response = await submit(
        submitApp,
        submitSeed.pageId,
        submitSeed.formId,
        submissionBody(submitSeed.submissionKey, `flood-submit-${seq}-${i}`),
      );
      expect(response.status).toBe(201);
    }
    const submitLimited = await submit(
      submitApp,
      submitSeed.pageId,
      submitSeed.formId,
      submissionBody(submitSeed.submissionKey, `flood-submit-${seq}-limited`),
    );
    expect(submitLimited.status).toBe(429);
    expect(submitLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));

    const uploadSeed = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const uploadApp = app();
    for (let i = 0; i < FORM_REQUEST_RATE_LIMIT; i += 1) {
      const response = await upload(
        uploadApp,
        uploadSeed.pageId,
        uploadSeed.formId,
        uploadSeed.submissionKey,
        filesField.id,
        new Uint8Array([1]),
      );
      expect(response.status).toBe(201);
    }
    const uploadLimited = await upload(
      uploadApp,
      uploadSeed.pageId,
      uploadSeed.formId,
      uploadSeed.submissionKey,
      filesField.id,
      new Uint8Array([1]),
    );
    expect(uploadLimited.status).toBe(429);
    expect(uploadLimited.headers.get('retry-after')).toBe(String(FORM_REQUEST_RATE_WINDOW_MS / 1000));
  });

  it('sweeps a staged orphan after 30 minutes on the next submission', async () => {
    const seeded = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const stagedResponse = await upload(
      app(),
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      new Uint8Array([91, 92, 93]),
    );
    const {token} = (await stagedResponse.json()) as {token: string};
    const [{asset_id: assetId}] = await db.query<{asset_id: string}>(
      'SELECT asset_id FROM form_uploads WHERE token = $1',
      [token],
    );
    await db.query(
      'UPDATE form_uploads SET created_at = now() - interval \'31 minutes\' WHERE token = $1',
      [token],
    );

    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `orphan-sweep-${seq}`, {}),
    );
    expect(response.status).toBe(201);
    expect(await store.getAsset(assetId)).toBeNull();
    expect(await db.query('SELECT token FROM form_uploads WHERE token = $1', [token])).toHaveLength(0);
  });

  it('fake-succeeds a honeypot carrying an upload and retains neither row nor staged asset', async () => {
    const seeded = await seedForm({
      fields: [
        filesField,
        {id: 'website', kind: 'text', label: 'Website', required: false, honeypot: true},
      ],
      databaseSchema: filesDatabase,
    });
    const stagedResponse = await upload(
      app(),
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      new Uint8Array([201, 202, 203]),
    );
    const {token} = (await stagedResponse.json()) as {token: string};
    const [{asset_id: assetId}] = await db.query<{asset_id: string}>(
      'SELECT asset_id FROM form_uploads WHERE token = $1',
      [token],
    );
    const response = await submit(
      app(),
      seeded.pageId,
      seeded.formId,
      submissionBody(seeded.submissionKey, `honeypot-upload-${seq}`, {
        documents: [token],
        website: 'https://spam.example',
      }),
    );
    expect(response.status).toBe(201);
    expect(await store.listRows(seeded.databaseId)).toHaveLength(0);
    expect(await store.getAsset(assetId)).toBeNull();
    expect(await db.query('SELECT token FROM form_uploads WHERE token = $1', [token])).toHaveLength(0);
  });

  it('returns 507 when the per-form 50 MiB asset budget is exhausted', async () => {
    const seeded = await seedForm({fields: [filesField], databaseSchema: filesDatabase});
    const first = await upload(
      app(),
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      new Uint8Array([41]),
    );
    expect(first.status).toBe(201);
    const {token} = (await first.json()) as {token: string};
    const [{asset_id: assetId}] = await db.query<{asset_id: string}>(
      'SELECT asset_id FROM form_uploads WHERE token = $1',
      [token],
    );
    await db.query('UPDATE assets SET size = $2 WHERE id = $1', [assetId, FORM_UPLOAD_MAX_FORM_BYTES]);

    const overBudget = await upload(
      app(),
      seeded.pageId,
      seeded.formId,
      seeded.submissionKey,
      filesField.id,
      new Uint8Array([42]),
    );
    expect(overBudget.status).toBe(507);
    expect(await overBudget.json()).toEqual({error: 'asset storage is full'});
    expect(await db.query('SELECT id FROM assets')).toHaveLength(1);
  });
});
