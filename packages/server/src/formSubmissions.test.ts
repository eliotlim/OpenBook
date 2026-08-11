import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  FORWARDED_HEADER,
  generateSubmissionKey,
  mintIdentityKeypair,
  signIdentity,
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
  FORM_SUBMISSION_PROVENANCE_PROPERTY,
} from './formAccess';

const ISS = 'https://account.book.pub';

let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const emptySnapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

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
  store = new PageStore(await PgliteDb.create(dir));
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
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

async function seedForm(over: {enabled?: boolean; visibility?: 'public' | 'members' | 'restricted'} = {}) {
  const page = await store.upsertPage({name: `form-host-${seq}`, data: emptySnapshot()});
  const database = await store.createDatabase({pageId: page.id, name: 'Submissions'});
  const formId = `contact-${seq}`;
  const submissionKey = generateSubmissionKey();
  const props = {
    formId,
    submissionKey,
    enabled: over.enabled ?? true,
    databaseId: database.id,
    schema: {fields: []},
  };
  await store.upsertPage({
    id: page.id,
    name: page.name,
    data: {
      editorjs: {blocks: [{id: `form-block-${seq}`, type: 'form', props}]},
      values: [],
      names: [],
    },
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
    expect(rows[0].properties[FORM_SUBMISSION_PROVENANCE_PROPERTY]).toEqual({
      formId: seeded.formId,
      submittedAt: result.submittedAt,
    });
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
      data: {
        editorjs: {blocks: [{type: 'form', props: {...seeded.props, enabled: false}}]},
        values: [],
        names: [],
      },
    });
    responses.push(await submit(a, seeded.pageId, seeded.formId, validBody));

    await store.upsertPage({
      id: seeded.pageId,
      name: `form-host-${seq}`,
      data: {editorjs: {blocks: [{type: 'form', props: seeded.props}]}, values: [], names: []},
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

  it('replays an idempotency key as the exact original success without a second row', async () => {
    const seeded = await seedForm();
    const a = app();
    const body = submissionBody(seeded.submissionKey, `stable-replay-${seq}`);
    const first = await submit(a, seeded.pageId, seeded.formId, body);
    const firstBytes = await first.text();
    const replay = await submit(a, seeded.pageId, seeded.formId, body);
    const replayBytes = await replay.text();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayBytes).toBe(firstBytes);
    expect(await store.listRows(seeded.databaseId)).toHaveLength(1);
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
      data: {
        editorjs: {blocks: [{type: 'form', props: {...seeded.props, databaseId: otherDatabase.id}}]},
        values: [],
        names: [],
      },
    });
    const response = await submit(app(), seeded.pageId, seeded.formId, submissionBody(seeded.submissionKey));
    expect(`${response.status}\n${await response.text()}`).toBe('404\n{"error":"form not found"}');
    expect(await store.listRows(otherDatabase.id)).toHaveLength(0);
  });
});
