import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mintIdentityKeypair, signIdentity, type IdentityKeypair, type StoredPage} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ISS = 'https://account.book.pub';
let seq = 0;
const dirs: string[] = [];

async function freshStore(tag: string): Promise<PageStore> {
  seq += 1;
  const dir = join(tmpdir(), `ob-sync-${tag}-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  return store;
}

const docWithBlock = (text: string) => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

let kp: IdentityKeypair;
const stores: PageStore[] = [];

beforeEach(async () => {
  kp = await mintIdentityKeypair('account-1');
});

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

describe('offline attribution through sync/merge (OB-170)', () => {
  it('carries the verified author with the snapshot, and credits them on the receiving instance', async () => {
    // Instance A: a verified user (alice) edits a page.
    const a = await freshStore('a');
    stores.push(a);
    await a.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}]});
    const appA = createApp(a, undefined, new PageHub(), {identity: new IdentityService(a)});
    const jws = await signIdentity(
      kp.privateKey,
      {iss: ISS, sub: 'alice', name: 'Alice', exp: Math.floor(Date.now() / 1000) + 3600, jti: 'j-a'},
      'account-1',
    );
    const page: StoredPage = await (
      await appA.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', [IDENTITY_HEADER]: jws},
        body: JSON.stringify({name: `sync-${seq}`, data: docWithBlock('hello')}),
      })
    ).json();

    // The author travels in the snapshot.
    expect(new Map(page.data.authors)).toEqual(new Map([['b1', `${ISS}#alice`]]));

    // Instance B: import A's page (the sync/merge path). B has no idea who alice
    // is at request time — but the carried attribution credits her.
    const b = await freshStore('b');
    stores.push(b);
    await b.importBundle({pages: [page], databases: [], mode: 'copy'});
    const synced = (await b.listEdits()).filter((e) => e.kind === 'page.synced');
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({authorSubject: `${ISS}#alice`, authorIssuer: ISS, verifiedVia: 'synced'});
  });

  it('carries nothing for a guest edit (only verified identity travels)', async () => {
    const a = await freshStore('guest');
    stores.push(a);
    const appA = createApp(a, undefined, new PageHub(), {identity: new IdentityService(a)});
    const page: StoredPage = await (
      await appA.request('/api/pages', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-OpenBook-Guest-Name': 'Caryl'},
        body: JSON.stringify({name: `sync-guest-${seq}`, data: docWithBlock('hi')}),
      })
    ).json();
    expect(page.data.authors).toBeUndefined();

    const b = await freshStore('guest-b');
    stores.push(b);
    await b.importBundle({pages: [page], databases: [], mode: 'copy'});
    expect((await b.listEdits()).filter((e) => e.kind === 'page.synced')).toHaveLength(0);
  });
});
