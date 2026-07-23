/**
 * Identity-lifecycle divergence between the durable nav LIST and one-shot CONTENT
 * (the cross-server "titles show, content blank" bug).
 *
 * The client carries the nav list over durable surfaces — the initial `listPages`
 * and the `/api/live` SSE, whose identity is baked into the EventSource URL when it
 * OPENS and then frozen (an EventSource can't send headers, so the JWS rides
 * `?identity=`). Page CONTENT is a fresh one-shot `GET /api/pages/:id` reading the
 * CURRENT credential. So when the account identity for a remote data server lapses,
 * the already-open list keeps asserting the identity it opened with while content
 * fetches move to the (dropped/expired) current one — titles persist, bodies 401/404.
 *
 * This suite PINS that asymmetry at the server: the gate itself is symmetric per
 * credential (proved in `forwardedAccess.test.ts`); the divergence is purely
 * credential-in-flight. A list opened with a valid identity is authorized and
 * carries an authenticated-scope page, while a content GET whose identity has
 * DROPPED to guest is 404 and one still presenting an EXPIRED assertion is a hard
 * 401 — never a silent guest downgrade.
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
const nowS = () => Math.floor(Date.now() / 1000);

/** A verified identity for this issuer (UNSCOPED — no audience is bound, so the
 *  only thing separating the control from the lapse cases is the time window). */
const token = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
  signIdentity(
    kp.privateKey,
    {iss: ISS, sub, name: sub, iat: nowS() - 30, exp: nowS() + 3600, jti: `jti-${sub}-${Math.random()}`, ...over},
    kp.publicJwk.kid,
  );

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-idlife-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
  // Trust the issuer so a presented assertion is VERIFIED (not merely claimed) —
  // no audience binding, so an expired/absent identity is the only failure axis.
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], ownerSubject: `${ISS}#owner`});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const app = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
type App = ReturnType<typeof app>;

const get = (a: App, path: string, jws?: string) =>
  a.request(path, {headers: {'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})}});

/** Open the firehose with `query` and return the ids in its FIRST `list` frame,
 *  then cancel — modelling the client baking its identity into the stream URL at
 *  open time. */
async function openListIds(a: App, query: string): Promise<string[]> {
  const res = await a.request(`/api/live${query ? `?${query}` : ''}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (let i = 0; i < 50; i++) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      const line = buf.split('\n').find((l) => l.startsWith('data:') && l.includes('"type":"list"'));
      if (line) {
        const frame = JSON.parse(line.slice('data:'.length).trim()) as {pages: Array<{id: string}>};
        return frame.pages.map((p) => p.id);
      }
    }
    return [];
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe('identity lifecycle — an open authenticated list outlives a lapsed content credential', () => {
  let authPage: string;

  beforeEach(async () => {
    authPage = (await store.upsertPage({name: `auth-${seq}`, data: snapshot()})).id;
    await store.setPageVisibility(authPage, 'authenticated'); // any verified reader; guest hidden
  });

  it('the list opened with a valid identity carries the page; a DROPPED-identity content GET is 404', async () => {
    const a = app();
    // The nav list, opened with a valid verified identity, is authorized.
    expect(await openListIds(a, `identity=${await token('reader')}`)).toContain(authPage);
    // A one-shot content fetch whose identity has lapsed to guest (none presented)
    // can't read the authenticated page — its existence is hidden (404), not served.
    expect((await get(a, `/api/pages/${authPage}`)).status).toBe(404);
    // Control: the SAME still-valid identity reads the content fine — the gate is
    // symmetric per credential; only the credential-in-flight diverged.
    expect((await get(a, `/api/pages/${authPage}`, await token('reader'))).status).toBe(200);
  });

  it('a content GET still presenting an EXPIRED identity is a hard 401 (no silent guest downgrade)', async () => {
    const a = app();
    // The list opened while the identity was valid stays authorized (carries the page).
    expect(await openListIds(a, `identity=${await token('reader')}`)).toContain(authPage);
    // Later, the SAME assertion is past its `exp`: a present-but-invalid credential
    // is an ERROR (401), never a downgrade to an over-granted guest. This is the
    // path that threw in `getPage` → blank content while the title persisted.
    const expired = await token('reader', {iat: nowS() - 7200, exp: nowS() - 3600});
    expect((await get(a, `/api/pages/${authPage}`, expired)).status).toBe(401);
  });

  it('the divergence is credential-lifecycle, not the list vs content GATE: a guest list hides the page too', async () => {
    const a = app();
    // Opened WITHOUT an identity, the very same firehose filters the authenticated
    // page out — so nothing about the list surface over-grants; only a list opened
    // earlier under a since-lapsed identity keeps showing it.
    expect(await openListIds(a, '')).not.toContain(authPage);
  });
});
