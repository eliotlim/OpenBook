/**
 * Forwarded-exposure backstop on an UNCLAIMED instance (OB-209).
 *
 * Forwarding is an OUTBOUND tunnel: the instance stays on loopback/IPC, so a
 * forwarded request slips past the BOOT exposure backstop (`assertExposureSafe`,
 * which only guards a *listener* bind — OB-191). On an UNCLAIMED instance
 * `authorize()` rule-0 short-circuits to the legacy guest gate (default
 * `guestAccess:'write'`), so exposing it unclaimed would serve it anonymous +
 * world-writable over the public `*.book.cloud` address.
 *
 * The tunnel client marks every request it forwards (`FORWARDED_HEADER`); the origin
 * fails CLOSED on that marker while still unclaimed — the defense-in-depth backstop
 * behind the client's claim-on-publish guard. A loopback request never carries the
 * marker, so the local single-user experience is untouched, and once the instance is
 * claimed the marked path is served by the normal per-page enforcement (OB-190/202).
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  FORWARDED_HEADER,
  mintIdentityKeypair,
  signIdentity,
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

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-fwdclaim-${process.pid}-${seq}`);
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

const withIdentity = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
const legacy = () => createApp(store, undefined, new PageHub()); // no identity provider configured

/** A request through the tunnel: the marker the tunnel client always sets (OB-209). */
const fwdHeaders = (extra: Record<string, string> = {}) => ({[FORWARDED_HEADER]: '1', ...extra});

const getPages = (a: ReturnType<typeof withIdentity>, headers: Record<string, string> = {}) =>
  a.request('/api/pages', {headers});

const createPage = (a: ReturnType<typeof withIdentity>, headers: Record<string, string> = {}) =>
  a.request('/api/pages', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify({name: `p-${seq}-${Math.random()}`, data: snapshot()}),
  });

describe('unclaimed instance: a forwarded request fails CLOSED (not world-writable)', () => {
  it('a forwarded anonymous WRITE is refused (403), and no page is created', async () => {
    const a = withIdentity();
    const res = await createPage(a, fwdHeaders());
    expect(res.status).toBe(403);
    // Prove it really did not write: the workspace is still empty.
    expect((await store.listPages()).length).toBe(0);
  });

  it('a forwarded anonymous READ is refused too (the whole exposed surface is closed)', async () => {
    const a = withIdentity();
    expect((await getPages(a, fwdHeaders())).status).toBe(403);
  });

  it('fails closed even with NO identity provider configured (a legacy instance)', async () => {
    const a = legacy();
    expect((await createPage(a, fwdHeaders())).status).toBe(403);
    expect((await store.listPages()).length).toBe(0);
  });

  it('a spoofed marker value is still treated as forwarded (any value closes the gate)', async () => {
    const a = withIdentity();
    expect((await createPage(a, {[FORWARDED_HEADER]: 'anything'})).status).toBe(403);
  });
});

describe('unclaimed instance: a LOOPBACK request is untouched (no marker)', () => {
  it('an unmarked anonymous write still succeeds (local single-user preserved)', async () => {
    const a = withIdentity();
    const res = await createPage(a); // no forwarded marker — the owner over loopback
    expect(res.status).toBe(201);
    expect((await store.listPages()).length).toBe(1);
  });

  it('an unmarked anonymous read still succeeds', async () => {
    const a = withIdentity();
    expect((await getPages(a)).status).toBe(200);
  });
});

describe('claimed instance: the forwarded path is served (the backstop is unclaimed-only)', () => {
  const owner = () =>
    signIdentity(
      kp.privateKey,
      {
        iss: ISS,
        sub: 'owner',
        name: 'owner',
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-owner-${Math.random()}`,
      },
      kp.publicJwk.kid,
    );

  beforeEach(async () => {
    // Claim through the real CAS exactly as the publish flow does (no audience bind
    // here — this isolates the claim backstop from the OB-202 audience enforcement).
    // claimOwnership also downgrades the default guestAccess 'write' → 'read'.
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}]});
    await store.claimOwnership(`${ISS}#owner`);
  });

  it('a forwarded owner JWS now passes the backstop and reads (200)', async () => {
    const a = withIdentity();
    expect((await getPages(a, fwdHeaders({[IDENTITY_HEADER]: await owner()}))).status).toBe(200);
  });

  it('a forwarded anonymous guest is no longer world-writable: the claimed guest gate denies the write', async () => {
    const a = withIdentity();
    // Claiming downgraded guestAccess 'write' → 'read' (OB-191), so an anonymous
    // forwarded write is now 403 by the guest gate — NOT by the unclaimed backstop.
    const res = await createPage(a, fwdHeaders());
    expect(res.status).toBe(403);
    expect((await store.listPages()).length).toBe(0);
  });
});
