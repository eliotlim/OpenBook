import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DEFAULT_INSTANCE_CONFIG, mintIdentityKeypair, signIdentity} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

const ACCOUNT = 'https://account.book.pub';
let store: PageStore;
let dir: string;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-defiss-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  // NOTE: intentionally no trustedIssuers override — exercise the default.
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('default account.book.pub trust', () => {
  it('ships account.book.pub as a default trusted issuer', () => {
    expect(DEFAULT_INSTANCE_CONFIG.trustedIssuers.map((i) => i.issuer)).toContain(ACCOUNT);
  });

  it('verifies an account-issued JWS by fetching the issuer JWKS URL', async () => {
    const kp = await mintIdentityKeypair('account-1');
    let fetched = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetched += 1;
      return new Response(JSON.stringify({keys: [kp.publicJwk]}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    };
    const identity = new IdentityService(store, {fetchImpl});
    const app = createApp(store, undefined, new PageHub(), {identity});

    const jws = await signIdentity(
      kp.privateKey,
      {iss: ACCOUNT, sub: 'u9', name: 'Zed', exp: Math.floor(Date.now() / 1000) + 3600, jti: 'j9'},
      'account-1',
    );
    const info = await (await app.request('/api/instance', {headers: {[IDENTITY_HEADER]: jws}})).json();
    expect(info.you).toMatchObject({kind: 'user', subject: `${ACCOUNT}#u9`, name: 'Zed', verifiedVia: 'jws'});
    expect(fetched).toBeGreaterThan(0); // it actually consulted the JWKS URL
  });
});
