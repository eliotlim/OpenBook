/**
 * HTML-artifact asset INERTNESS + lifecycle (security lock-in).
 *
 * OpenBook is adding HTML-artifact blocks whose bytes live in the same
 * content-addressed asset store that already backs image blocks (A1/A6). The
 * security design REQUIRES that HTML payloads are stored and served EXACTLY as
 * inert as the store behaves today — i.e. `text/html` is NOT allowlisted, so it
 * is coerced to `application/octet-stream` BEFORE it is stored, and served with
 * `X-Content-Type-Options: nosniff` + `Content-Disposition: attachment`. That
 * combination means an uploaded `<script>…</script>` document can NEVER execute
 * in the app origin — the browser downloads bytes, it does not render a page.
 *
 * These tests pin that inertness for HTML specifically (the image suites in
 * `assets.test.ts` / `assetGc.test.ts` already cover the image path). They also
 * confirm the rest of the asset lifecycle behaves identically for an HTML
 * payload: the read-gate (no existence oracle), the blockdoc-usage-safe GC
 * (an `htmlArtifact` block's `props.assetId` in a page document protects the
 * asset even with 0 `asset_refs`, and while the page is trashed), byte-identical
 * dedup, and the 10 MiB oversize 413.
 *
 * INVARIANT UNDER TEST — do NOT "fix" a failure here by adding `text/html`
 * (or `image/svg+xml`) to `ASSET_IMAGE_MIMES` (app.ts). The whole point is that
 * HTML is served inert; the allowlist stays image-only. See app.ts:63-97.
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
  type PageSnapshot,
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

const snapshot = (): PageSnapshot => ({editorjs: {blocks: []}, values: [], names: []});

/**
 * A page document whose block-editor projection references `assetId` from an
 * `htmlArtifact` block (`props.assetId`) — the shape the forthcoming HTML-artifact
 * block persists. The id lands in `data::text`, which is exactly what the GC's
 * live-document scan reads (the scan is block-type-agnostic: it looks for the
 * 64-hex id as text, so an `htmlArtifact` block protects its asset identically to
 * an `image` block). See store.ts gcUnreferencedAssets.
 */
const snapWithHtmlArtifact = (assetId: string): PageSnapshot => ({
  editorjs: {blocks: []},
  values: [],
  names: [],
  editor: 'blocks',
  blockdoc: {v: 1, update: '', blocks: [{id: 'html1', type: 'htmlArtifact', props: {assetId}}]},
});

/** A representative hostile HTML payload — inert once stored/served correctly. */
const HTML_PAYLOAD = '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>';
// Fresh `ArrayBuffer`-backed copy so the value is a valid `BodyInit` (fetch bodies
// reject a `SharedArrayBuffer`-typed `Uint8Array<ArrayBufferLike>`).
const htmlBytes = (): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(HTML_PAYLOAD));

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
  dir = join(tmpdir(), `ob-html-asset-${process.pid}-${seq}`);
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

// ── Inertness: HTML is stored + served as application/octet-stream ──────────────

describe('HTML asset inertness — open instance', () => {
  const app = () => createApp(store, undefined, new PageHub());

  it('a RAW-body text/html upload is stored AND served as application/octet-stream', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'text/html'},
      body: htmlBytes(),
    });
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    // Coerced BEFORE the store write (safeAssetMime), so the row never holds text/html.
    expect((await store.getAsset(id))!.mime).toBe('application/octet-stream');

    const got = await a.request(`/api/assets/${id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('application/octet-stream'); // never text/html
    // Bytes are preserved verbatim — inertness is about the served TYPE, not mangling content.
    expect(new TextDecoder().decode(new Uint8Array(await got.arrayBuffer()))).toBe(HTML_PAYLOAD);
  });

  it('a base64-JSON text/html upload is ALSO stored + served as application/octet-stream', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({data: Buffer.from(htmlBytes()).toString('base64'), mime: 'text/html'}),
    });
    expect(res.status).toBe(201);
    const {id} = (await res.json()) as {id: string};
    expect((await store.getAsset(id))!.mime).toBe('application/octet-stream');

    const got = await a.request(`/api/assets/${id}`);
    expect(got.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('the served HTML asset carries nosniff + Content-Disposition: attachment (cannot render/execute)', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const {id} = (await (
      await a.request(`/api/assets?pageId=${page.id}`, {
        method: 'POST',
        headers: {'Content-Type': 'text/html'},
        body: htmlBytes(),
      })
    ).json()) as {id: string};

    const got = await a.request(`/api/assets/${id}`);
    expect(got.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(got.headers.get('Content-Disposition')).toBe('attachment');
    // nosniff + octet-stream + attachment ⇒ the browser downloads bytes; it never
    // parses them as HTML in the app origin, so the inline <script> can't run.
  });

  it('?encoding=base64 round-trips the EXACT HTML bytes for the in-webview transport', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const bytes = htmlBytes();
    const {id} = (await (
      await a.request(`/api/assets?pageId=${page.id}`, {
        method: 'POST',
        headers: {'Content-Type': 'text/html'},
        body: bytes,
      })
    ).json()) as {id: string};

    const res = await a.request(`/api/assets/${id}?encoding=base64`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {id: string; mime: string; size: number; data: string};
    expect(body.id).toBe(id);
    expect(body.mime).toBe('application/octet-stream'); // the base64 variant reports the inert mime too
    expect(body.size).toBe(bytes.byteLength);
    expect(Array.from(new Uint8Array(Buffer.from(body.data, 'base64')))).toEqual(Array.from(bytes));
  });

  it('byte-identical HTML uploads dedup to the SAME content-hash id', async () => {
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const upload = () =>
      a.request(`/api/assets?pageId=${page.id}`, {
        method: 'POST',
        headers: {'Content-Type': 'text/html'},
        body: htmlBytes(),
      });
    const first = (await (await upload()).json()) as {id: string};
    const second = (await (await upload()).json()) as {id: string};
    expect(second.id).toBe(first.id); // same bytes ⇒ same SHA-256 ⇒ one row
    // A different HTML payload hashes differently.
    const other = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'text/html'},
      body: new Uint8Array(new TextEncoder().encode('<p>different</p>')),
    });
    expect(((await other.json()) as {id: string}).id).not.toBe(first.id);
  });

  it('413s an over-cap (>10 MiB decoded) HTML upload', async () => {
    // The client caps an HTML artifact at the SAME 10 MiB ceiling as an image
    // (ASSET_MAX_BYTES) — there is one asset store, one budget, one body limit; the
    // producing block type doesn't change the cap. A raw body past the limit trips
    // the pre-handler bodyLimit; the decoded-size check backs it up for base64 bodies.
    const a = app();
    const page = await store.upsertPage({name: `p-${seq}`, data: snapshot()});
    const huge = new Uint8Array(10 * 1024 * 1024 + 1024); // > 10 MiB of "HTML"
    huge[0] = 0x3c; // '<' — non-empty, HTML-ish
    const res = await a.request(`/api/assets?pageId=${page.id}`, {
      method: 'POST',
      headers: {'Content-Type': 'text/html'},
      body: huge,
    });
    expect(res.status).toBe(413);
  });
});

// ── Read-gate: an HTML asset inherits its referencing page's read-gate ──────────

describe('HTML asset read-gate — claimed instance (no existence oracle)', () => {
  const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
  const req = (a: ReturnType<typeof app>, path: string, jws?: string) =>
    a.request(path, {headers: jws ? {[IDENTITY_HEADER]: jws} : {}});

  let restr: string; // a restricted page, readable only by owner + ACL grantee
  let assetId: string; // an HTML asset referenced ONLY by `restr`

  beforeEach(async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
    await store.addMember({subject: `${ISS}#viewer`, role: 'viewer', status: 'active'});
    restr = (await store.upsertPage({name: `restr-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(restr, 'restricted');
    await store.setPageAcl(restr, {subject: `${ISS}#granted`, level: 'read'});

    const a = app();
    const res = await a.request(`/api/assets?pageId=${restr}`, {
      method: 'POST',
      headers: {'Content-Type': 'text/html', [IDENTITY_HEADER]: await idFor('owner')},
      body: htmlBytes(),
    });
    expect(res.status).toBe(201);
    assetId = ((await res.json()) as {id: string}).id;
  });

  it('serves the inert bytes to a reader of the referencing page (owner + ACL grantee)', async () => {
    const a = app();
    const asOwner = await req(a, `/api/assets/${assetId}`, await idFor('owner'));
    expect(asOwner.status).toBe(200);
    expect(asOwner.headers.get('Content-Type')).toBe('application/octet-stream'); // still inert on the gated path
    expect(asOwner.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(asOwner.headers.get('Content-Disposition')).toBe('attachment');
    expect((await req(a, `/api/assets/${assetId}`, await idFor('granted'))).status).toBe(200);
  });

  it('404s a caller who cannot read the sole referencing page — no oracle, no leak', async () => {
    const a = app();
    // A member (viewer) who is NOT an ACL grantee, a jws stranger, and an anon guest.
    expect((await req(a, `/api/assets/${assetId}`, await idFor('viewer'))).status).toBe(404);
    expect((await req(a, `/api/assets/${assetId}`, await idFor('stranger'))).status).toBe(404);
    expect((await req(a, `/api/assets/${assetId}`)).status).toBe(404);
    // The 404 for a real-but-unreadable HTML asset is indistinguishable from a nonexistent one.
    expect((await req(a, `/api/assets/${'a'.repeat(64)}`, await idFor('viewer'))).status).toBe(404);
    // And no validator leaks on the gated 404 (never a 304/ETag oracle).
    const gated = await req(a, `/api/assets/${assetId}`, await idFor('viewer'));
    expect(gated.headers.get('ETag')).toBeNull();
  });
});

// ── GC: an htmlArtifact block prop protects its asset (blockdoc-usage-safe) ──────

describe('HTML asset GC — htmlArtifact block prop is usage-safe', () => {
  it('KEEPS an HTML asset referenced ONLY by an htmlArtifact block prop (asset_refs empty)', async () => {
    // The block-move/copy hazard: the asset is live in a page DOCUMENT via
    // props.assetId, but asset_refs is empty. A naive ref-only GC would reap it and
    // break the artifact; the doc scan must protect it.
    const {id} = await store.putAsset(htmlBytes(), 'application/octet-stream');
    const page = await store.upsertPage({name: `p-${seq}`, data: snapWithHtmlArtifact(id)});
    expect(await store.pagesReferencingAsset(id)).toEqual([]); // 0 refs — kept purely via the doc
    expect(page.id).toBeTruthy();

    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
  });

  it('KEEPS the HTML asset while its holding page is SOFT-DELETED (trashed), reaps only after hard purge', async () => {
    // Trash retention (30d) far outlives the GC grace (24h): a trashed page's document
    // must keep protecting its HTML asset so a restore-within-retention is not broken.
    const {id} = await store.putAsset(htmlBytes(), 'application/octet-stream');
    const page = await store.upsertPage({name: `p-${seq}`, data: snapWithHtmlArtifact(id)});
    await store.refAsset(id, page.id);

    await store.deletePage(page.id); // soft delete → ref survives AND its trashed doc is scanned
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();

    await store.purgePage(page.id); // hard purge → FK cascade drops the ref + no page doc
    expect((await store.gcUnreferencedAssets({graceMs: 0})).reaped).toBe(1);
    expect(await store.getAsset(id)).toBeNull();
  });

  it('reaps a TRULY-unreferenced HTML asset after the grace, but keeps a young one', async () => {
    const {id} = await store.putAsset(htmlBytes(), 'application/octet-stream'); // never ref'd, in no doc
    // Young orphan (within grace) is kept — the just-uploaded-not-yet-saved case.
    expect((await store.gcUnreferencedAssets({graceMs: 60 * 60 * 1000})).reaped).toBe(0);
    expect(await store.getAsset(id)).not.toBeNull();
    // Past the grace, the same orphan is reaped.
    const aged = await store.gcUnreferencedAssets({graceMs: 0});
    expect(aged.reaped).toBe(1);
    expect(aged.ids).toEqual([id]);
    expect(await store.getAsset(id)).toBeNull();
  });
});
