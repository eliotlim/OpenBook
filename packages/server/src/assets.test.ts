/**
 * Content-addressed asset store + gated routes (OB-ASSETS A1).
 *
 * Covers the storage foundation A0's image block and A2's DataClient build on:
 *  - `putAsset` dedups byte-identical uploads to one row by SHA-256 content hash;
 *  - `getAsset` round-trips bytes + mime + size exactly;
 *  - `POST /api/assets` enforces the 10 MiB bodyLimit + the write-gate + refs the
 *    asset to its page;
 *  - the **read-gate**: an asset inherits its referencing page's read-gate, so a
 *    caller who can't read any referencing page gets 404 (no existence oracle, no
 *    cross-page/cross-principal leak); a reader of a referencing page gets the bytes;
 *  - the base64-JSON variant is byte-exact with the raw binary.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
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

const ISS = 'https://account.book.pub';
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {
      iss: ISS,
      sub,
      name: sub,
      iat: Math.floor(Date.now() / 1000) - 30,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${sub}-${Math.random()}`,
      ...over,
    },
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-assets-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

// ── Store layer ───────────────────────────────────────────────────────────────

describe('asset store', () => {
  it('putAsset dedups byte-identical uploads to one id (content hash = PK)', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 72, 73]);
    const {id: a} = await store.putAsset(bytes, 'image/png');
    const {id: b} = await store.putAsset(new Uint8Array(bytes), 'image/png'); // same content → same id
    expect(b).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex; id IS the PK, so same id ⇒ one row
    expect(await store.pagesReferencingAsset(a)).toEqual([]); // put doesn't ref
    const {id: c} = await store.putAsset(new Uint8Array([9, 9, 9]), 'image/png'); // different content
    expect(c).not.toBe(a);
  });

  it('getAsset round-trips bytes + mime + size, and null for a miss', async () => {
    const bytes = new Uint8Array([10, 20, 30, 0, 255, 128]);
    const {id} = await store.putAsset(bytes, 'application/pdf');
    const got = await store.getAsset(id);
    expect(got).not.toBeNull();
    expect(got!.mime).toBe('application/pdf');
    expect(got!.size).toBe(bytes.byteLength);
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes));
    expect(await store.getAsset('deadbeef')).toBeNull();
  });

  it('refAsset is idempotent and unrefAsset removes the edge', async () => {
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = await store.putAsset(new Uint8Array([1, 2, 3]), 'image/png');
    await store.refAsset(id, page.id);
    await store.refAsset(id, page.id); // idempotent (composite PK)
    expect(await store.pagesReferencingAsset(id)).toEqual([page.id]);
    await store.unrefAsset(id, page.id);
    expect(await store.pagesReferencingAsset(id)).toEqual([]);
  });

  it('an asset ref cascade-deletes when its page is hard-purged', async () => {
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = await store.putAsset(new Uint8Array([4, 5, 6]), 'image/png');
    await store.refAsset(id, page.id);
    await store.deletePage(page.id);
    await store.purgePage(page.id); // hard delete → FK cascade drops the ref
    expect(await store.pagesReferencingAsset(id)).toEqual([]);
  });
});

// ── Routes: open (legacy, unclaimed) instance — guest has full access ───────────

describe('asset routes — open instance', () => {
  const app = () => createApp(store, undefined, new PageHub());

  const upload = (a: ReturnType<typeof app>, pageId: string, bytes: Uint8Array<ArrayBuffer>, mime = 'image/png') =>
    a.request(`/api/assets?pageId=${encodeURIComponent(pageId)}`, {
      method: 'POST',
      headers: {'Content-Type': mime, 'X-OpenBook-Client': '1'},
      body: bytes,
    });

  it('uploads → 201 {id}, then serves the raw binary byte-exact with the stored mime', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1, 2]); // PNG-ish
    const res = await upload(a, page.id, bytes, 'image/png');
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const got = await a.request(`/api/assets/${id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/png');
    const roundTrip = new Uint8Array(await got.arrayBuffer());
    expect(Array.from(roundTrip)).toEqual(Array.from(bytes));
  });

  it('the base64 variant is byte-exact with the raw binary', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const {id} = (await (await upload(a, page.id, bytes)).json()) as {id: string};

    const res = await a.request(`/api/assets/${id}?encoding=base64`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {id: string; mime: string; size: number; data: string};
    expect(body.id).toBe(id);
    expect(body.size).toBe(bytes.byteLength);
    expect(Array.from(new Uint8Array(Buffer.from(body.data, 'base64')))).toEqual(Array.from(bytes));
  });

  it('accepts a base64-JSON upload body (in-webview transport)', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array([5, 6, 7, 8, 9, 200, 201]);
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({data: Buffer.from(bytes).toString('base64'), mime: 'image/webp'}),
    });
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    const got = await store.getAsset(id);
    expect(got!.mime).toBe('image/webp');
    expect(Array.from(got!.bytes)).toEqual(Array.from(bytes));
  });

  it('gates the cache header behind the read-gate: 404 has no immutable cache header', async () => {
    const a = app();
    const missing = await a.request(`/api/assets/${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store'); // never immutable on a miss
  });

  it('sets an immutable, private cache header only on the authorized served asset', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = (await (await upload(a, page.id, new Uint8Array([1, 1, 2, 3, 5]))).json()) as {id: string};
    const got = await a.request(`/api/assets/${id}`);
    expect(got.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
  });

  // ── ETag / 304 conditional GET (Assets A5) ──────────────────────────────────

  it('sets a strong content-addressed ETag ("<id>") on the raw + base64 GET', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = (await (await upload(a, page.id, new Uint8Array([9, 8, 7, 6]))).json()) as {id: string};

    const raw = await a.request(`/api/assets/${id}`);
    expect(raw.headers.get('ETag')).toBe(`"${id}"`); // strong (no W/); id IS the sha-256

    const b64 = await a.request(`/api/assets/${id}?encoding=base64`);
    expect(b64.status).toBe(200);
    expect(b64.headers.get('ETag')).toBe(`"${id}"`); // the base64 variant carries it too
  });

  it('If-None-Match matching the ETag → 304 with an empty body, keeping ETag + cache header', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const {id} = (await (await upload(a, page.id, bytes)).json()) as {id: string};

    const res = await a.request(`/api/assets/${id}`, {headers: {'If-None-Match': `"${id}"`}});
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(`"${id}"`);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    // 304 is bodyless — it must NOT ship the asset bytes.
    expect((await res.arrayBuffer()).byteLength).toBe(0);

    // `*` (any existing representation) and a weak `W/` prefix also 304; base64 too.
    expect((await a.request(`/api/assets/${id}`, {headers: {'If-None-Match': '*'}})).status).toBe(304);
    expect((await a.request(`/api/assets/${id}`, {headers: {'If-None-Match': `W/"${id}"`}})).status).toBe(304);
    const b64_304 = await a.request(`/api/assets/${id}?encoding=base64`, {headers: {'If-None-Match': `"${id}"`}});
    expect(b64_304.status).toBe(304);
    expect((await b64_304.text()).length).toBe(0);
  });

  it('a NON-matching If-None-Match still serves the full 200 (no false 304)', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array([2, 4, 6, 8]);
    const {id} = (await (await upload(a, page.id, bytes)).json()) as {id: string};
    const res = await a.request(`/api/assets/${id}`, {headers: {'If-None-Match': `"${'f'.repeat(64)}"`}});
    expect(res.status).toBe(200);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it('413s an over-cap (>10 MiB) upload body', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const huge = new Uint8Array(10 * 1024 * 1024 + 1024);
    const res = await upload(a, page.id, huge);
    expect(res.status).toBe(413);
  });

  it('accepts a ~9 MiB image over the base64 body (base64 overhead fits the raised body cap)', async () => {
    // A2 regression: the base64 body inflates ~4/3, so a 9 MiB raw image is a
    // ~12 MiB body. The raw-body limit is sized for that overhead so the honest
    // sub-10-MiB image uploads (a flat 10 MiB body limit would 413 it).
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes[0] = 137; // non-empty
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({data: Buffer.from(bytes).toString('base64'), mime: 'image/png'}),
    });
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect((await store.getAsset(id))!.size).toBe(bytes.byteLength);
  });

  it('413s a base64 body whose DECODED size exceeds the 10 MiB cap', async () => {
    // The DECODED-size check keeps the advertised 10 MiB cap honest even though
    // the raw-body limit is larger to accommodate base64 overhead.
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const over = new Uint8Array(10 * 1024 * 1024 + 4096);
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({data: Buffer.from(over).toString('base64'), mime: 'image/png'}),
    });
    expect(res.status).toBe(413);
  });

  it('400s a missing pageId and an empty body', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const noPage = await a.request('/api/assets', {method: 'POST', headers: {'Content-Type': 'image/png', 'X-OpenBook-Client': '1'}, body: new Uint8Array([1])});
    expect(noPage.status).toBe(400);
    const empty = await upload(a, page.id, new Uint8Array([]));
    expect(empty.status).toBe(400);
  });

  // ── Stored-XSS defenses (Quinn + Sasha review of #66) ───────────────────────

  it('serves the raw binary with nosniff + Content-Disposition: attachment', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = (await (await upload(a, page.id, new Uint8Array([1, 2, 3, 4]))).json()) as {id: string};
    const got = await a.request(`/api/assets/${id}`);
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(got.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('coerces a non-image mime (text/html) to octet-stream so it cannot execute', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    const res = await upload(a, page.id, new Uint8Array(html), 'text/html');
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect((await store.getAsset(id))!.mime).toBe('application/octet-stream'); // never text/html
    const got = await a.request(`/api/assets/${id}`);
    expect(got.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(got.headers.get('Content-Disposition')).toBe('attachment');
  });

  it('coerces image/svg+xml (script-carrying) to octet-stream — SVG is not allowlisted', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const {id} = (await (await upload(a, page.id, new Uint8Array(svg), 'image/svg+xml')).json()) as {id: string};
    expect((await store.getAsset(id))!.mime).toBe('application/octet-stream');
  });

  it('rejects a mime carrying CR/LF (header injection / 500 risk) with 400, not 500', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({data: Buffer.from([1, 2, 3]).toString('base64'), mime: 'image/png\r\nSet-Cookie: x=y'}),
    });
    expect(res.status).toBe(400);
  });

  it('404s a malformed :id (not a 64-hex content hash) before any store lookup', async () => {
    const a = app();
    expect((await a.request('/api/assets/not-a-hash')).status).toBe(404);
    expect((await a.request(`/api/assets/${'A'.repeat(64)}`)).status).toBe(404); // uppercase: not our hex form
    expect((await a.request(`/api/assets/${'0'.repeat(63)}`)).status).toBe(404); // too short
  });
});

// ── Routes: claimed instance — the read-gate + the upload write-gate ────────────

describe('asset routes — claimed instance read-gate (no leak)', () => {
  const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
  const req = (a: ReturnType<typeof app>, path: string, jws?: string) =>
    a.request(path, {headers: {'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})}});

  let restr: string; // a restricted page, ACL-granted to `granted` only
  let assetId: string; // an asset referenced ONLY by `restr`

  beforeEach(async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    restr = (await store.upsertPage({name: `restr-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restr, 'restricted');
    await store.setPageAcl(restr, {subject: `${ISS}#granted`, level: 'read'});

    // The owner uploads an asset attached to the restricted page.
    const a = app();
    const res = await a.request(`/api/assets?pageId=${restr}`, {
      method: 'POST',
      headers: {'Content-Type': 'image/png', [IDENTITY_HEADER]: await idFor('owner')},
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    expect(res.status).toBe(201);
    assetId = ((await res.json()) as {id: string}).id;
  });

  it('serves the bytes to a reader of the referencing page (owner + ACL grantee)', async () => {
    const a = app();
    expect((await req(a, `/api/assets/${assetId}`, await idFor('owner'))).status).toBe(200);
    expect((await req(a, `/api/assets/${assetId}`, await idFor('granted'))).status).toBe(200);
  });

  it('404s a caller who cannot read any referencing page — no oracle, no leak', async () => {
    const a = app();
    // A member (viewer) who is NOT an ACL grantee of the restricted page.
    expect((await req(a, `/api/assets/${assetId}`, await idFor('viewer'))).status).toBe(404);
    // A jws stranger, and an anonymous guest.
    expect((await req(a, `/api/assets/${assetId}`, await idFor('stranger'))).status).toBe(404);
    expect((await req(a, `/api/assets/${assetId}`)).status).toBe(404);
    // The 404 for a real-but-unreadable asset is indistinguishable from a nonexistent one.
    expect((await req(a, `/api/assets/${'a'.repeat(64)}`, await idFor('viewer'))).status).toBe(404);
  });

  it('If-None-Match does NOT bypass the read-gate: a non-reader still 404s (never a 304 oracle)', async () => {
    // A5: the ETag/304 short-circuit runs AFTER the read-gate, so a caller who
    // cannot read any referencing page gets the same plain 404 — never a 304 that
    // would confirm the asset (and its exact content hash) exists. The `If-None-Match`
    // even *carries* the real content-hash ETag, and it still 404s (no confirmation).
    const a = app();
    const cond = {[IDENTITY_HEADER]: await idFor('viewer'), 'If-None-Match': `"${assetId}"`};
    const asViewer = await a.request(`/api/assets/${assetId}`, {headers: cond});
    expect(asViewer.status).toBe(404); // NOT 304
    expect(asViewer.headers.get('ETag')).toBeNull(); // no validator leaks on the gated 404
    // A `*` (any existing representation) from a non-reader is likewise a plain 404.
    const star = await a.request(`/api/assets/${assetId}`, {
      headers: {[IDENTITY_HEADER]: await idFor('stranger'), 'If-None-Match': '*'},
    });
    expect(star.status).toBe(404);
  });

  it('a second readable ref opens the SAME asset to that page’s readers (dedup is not a leak)', async () => {
    // A public page the viewer can read, referencing the same asset content.
    const pub = (await store.upsertPage({name: `pub-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(pub, 'public');
    await store.refAsset(assetId, pub);
    const a = app();
    // The viewer can now read it via the public page; the restricted page is still hidden.
    expect((await req(a, `/api/assets/${assetId}`, await idFor('viewer'))).status).toBe(200);
    expect((await req(a, `/api/pages/${restr}`, await idFor('viewer'))).status).toBe(404);
  });

  it('the upload write-gate: a non-writer of the page is denied (404 hide-existence / 403)', async () => {
    const a = app();
    const body = new Uint8Array([9, 9, 9]);
    // A viewer can't even read the restricted page → 404 (existence hidden).
    const asViewer = await a.request(`/api/assets?pageId=${restr}`, {
      method: 'POST',
      headers: {'Content-Type': 'image/png', [IDENTITY_HEADER]: await idFor('viewer')},
      body,
    });
    expect(asViewer.status).toBe(404);

    // On a members page the viewer CAN read but NOT write → 403.
    const mem = (await store.upsertPage({name: `mem-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(mem, 'members');
    const asViewerMem = await a.request(`/api/assets?pageId=${mem}`, {
      method: 'POST',
      headers: {'Content-Type': 'image/png', [IDENTITY_HEADER]: await idFor('viewer')},
      body,
    });
    expect(asViewerMem.status).toBe(403);
  });
});
