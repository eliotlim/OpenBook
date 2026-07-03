/**
 * `AccountClient.getIdentityToken` — the discriminated mint outcomes. The split
 * is load-bearing for the identity-resilience fix: an issuer that refuses the
 * *audience* (400 with `aud` supplied — the account's default when no allowlist
 * is configured) must be distinguishable from one that mints nothing (501) and
 * from a transient failure, so the provider can retry unscoped instead of
 * silently demoting the signed-in owner to guest.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AccountClient, AccountError} from './account';

const BASE = 'https://account.test';
const TOKEN = 'tok-1';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

/** Stub global fetch with a single handler; records every requested URL. */
function stubFetch(handler: (url: URL) => Response): {urls: URL[]} {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      urls.push(url);
      return handler(url);
    }),
  );
  return {urls};
}

describe('AccountClient.getIdentityToken — discriminated outcomes', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('200 → ok, with the minted identity + expiry', async () => {
    const {urls} = stubFetch(() => json(200, {identity: 'a.b.c', expiresAt: '2026-01-01T00:00:00.000Z'}));
    const res = await new AccountClient(BASE).getIdentityToken(TOKEN, 'site.book.cloud');

    expect(res).toEqual({status: 'ok', identity: 'a.b.c', expiresAt: '2026-01-01T00:00:00.000Z'});
    // The requested audience rode along as the `aud` query param.
    expect(urls[0].searchParams.get('aud')).toBe('site.book.cloud');
  });

  it('501 → unconfigured (terminal: the account issues no identities)', async () => {
    stubFetch(() => json(501, {error: 'identity issuance is not configured'}));
    const res = await new AccountClient(BASE).getIdentityToken(TOKEN);

    expect(res).toEqual({status: 'unconfigured'});
  });

  it('400 with an aud supplied → audRejected, carrying the server’s own error text', async () => {
    stubFetch(() => json(400, {error: 'audience binding is not configured on this server'}));
    const res = await new AccountClient(BASE).getIdentityToken(TOKEN, 'site.book.cloud');

    expect(res).toEqual({status: 'audRejected', error: 'audience binding is not configured on this server'});
  });

  it('400 with an aud but a non-JSON body → audRejected with a generic explanation', async () => {
    stubFetch(() => new Response('nope', {status: 400}));
    const res = await new AccountClient(BASE).getIdentityToken(TOKEN, 'site.book.cloud');

    expect(res.status).toBe('audRejected');
    if (res.status === 'audRejected') expect(res.error).toContain('site.book.cloud');
  });

  it('400 with NO aud supplied → throws (not an audience problem)', async () => {
    stubFetch(() => json(400, {error: 'bad request'}));
    await expect(new AccountClient(BASE).getIdentityToken(TOKEN)).rejects.toBeInstanceOf(AccountError);
  });

  it('401/5xx → throws AccountError with the status (transient/auth, never a terminal tag)', async () => {
    stubFetch(() => json(401, {}));
    await expect(new AccountClient(BASE).getIdentityToken(TOKEN)).rejects.toMatchObject({status: 401});

    stubFetch(() => json(503, {}));
    await expect(new AccountClient(BASE).getIdentityToken(TOKEN, 'site.book.cloud')).rejects.toMatchObject({status: 503});
  });

  it('200 with a malformed body → unconfigured (the legacy guest fallback)', async () => {
    stubFetch(() => json(200, {}));
    const res = await new AccountClient(BASE).getIdentityToken(TOKEN);

    expect(res).toEqual({status: 'unconfigured'});
  });
});
