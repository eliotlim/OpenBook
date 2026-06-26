import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  HttpDataClient,
  mintIdentityKeypair,
  signIdentity,
  type IdentityCredential,
  type IdentityKeypair,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';

const ISS = 'https://account.book.pub';
let store: PageStore;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-muc-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}]});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

/** An HttpDataClient whose transport is the in-process Hono app, with a settable identity. */
function clientWithIdentity(getId: () => IdentityCredential | undefined) {
  const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
  const captured: Array<{path: string; headers: Record<string, string>}> = [];
  const fetchImpl = (input: string, init?: RequestInit) => {
    captured.push({path: input, headers: {...((init?.headers as Record<string, string>) ?? {})}});
    return app.request(input, init);
  };
  return {client: new HttpDataClient('', undefined, {fetchImpl, getIdentity: getId}), captured};
}

describe('HttpDataClient identity transport', () => {
  it('sends X-OpenBook-Identity and attributes the write to the verified user', async () => {
    const jws = await signIdentity(
      kp.privateKey,
      {iss: ISS, sub: 'erin', name: 'Erin', exp: Math.floor(Date.now() / 1000) + 3600, jti: 'j-erin'},
      'k1',
    );
    const {client, captured} = clientWithIdentity(() => ({jws}));
    const page = await client.savePage({name: `mu-client-${seq}`, data: snapshot()});

    // The header was attached to the request.
    const post = captured.find((c) => c.path === '/api/pages');
    expect(post?.headers['X-OpenBook-Identity']).toBe(jws);

    // And the server attributed the change to the verified user.
    await new Promise((r) => setTimeout(r, 25));
    const edits = await store.listEdits(page.id);
    expect(edits[0]).toMatchObject({verifiedVia: 'jws', authorSubject: `${ISS}#erin`, authorName: 'Erin'});
  });

  it('sends X-OpenBook-Guest-Name and attributes the write to a named guest', async () => {
    const {client, captured} = clientWithIdentity(() => ({guestName: 'Frank'}));
    const page = await client.savePage({name: `mu-guest-${seq}`, data: snapshot()});
    const post = captured.find((c) => c.path === '/api/pages');
    expect(post?.headers['X-OpenBook-Guest-Name']).toBe('Frank');
    await new Promise((r) => setTimeout(r, 25));
    const edits = await store.listEdits(page.id);
    expect(edits[0]).toMatchObject({verifiedVia: 'guest', authorName: 'Frank'});
  });

  it('reads the instance policy + identity over the client', async () => {
    const jws = await signIdentity(
      kp.privateKey,
      {iss: ISS, sub: 'gwen', name: 'Gwen', exp: Math.floor(Date.now() / 1000) + 3600},
      'k1',
    );
    const {client} = clientWithIdentity(() => ({jws}));
    const info = await client.getInstanceInfo();
    expect(info.you).toMatchObject({kind: 'user', subject: `${ISS}#gwen`});
    const updated = await client.setInstancePolicy({guestAccess: 'read'});
    expect(updated.guestAccess).toBe('read');
  });
});
