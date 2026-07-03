/**
 * ForwardingClient — the account-API error surfacing and the attach-ticket
 * retry. The challenge nonce is single-use with a ~120s TTL, so a slow keychain
 * sign (or clock skew) can burn it before the attach POST lands; the account
 * then 400s a perfectly healthy client. `mintAttach` must re-run the whole
 * challenge → sign → attach sequence ONCE with a fresh nonce — and every
 * non-OK response must carry the server's own `{error}` detail, so a "nonce
 * expired" is diagnosable instead of an anonymous 400.
 */

import {describe, expect, it} from 'vitest';
import type {FetchLike} from '../client';
import {ForwardingApiError, ForwardingClient, MemoryKeyStore, type SiteIdentity} from './forwardingClient';
import {mintSiteKeypair} from './siteKey';

const ACCOUNT = 'https://account.test';

/** A stored site identity backed by a REAL Ed25519 keypair, so the sign step runs. */
async function makeIdentity(): Promise<SiteIdentity> {
  const kp = await mintSiteKeypair();
  return {siteId: 'site-1', prefix: 'demo', host: 'demo.book.cloud', publicKey: kp.publicKey, privateKey: kp.privateKey};
}

type Route = (body: Record<string, unknown>, call: number) => {status: number; body: unknown};

/** A fake account API: routes by path, counts calls, records attach bodies. */
function fakeAccountApi(routes: Record<string, Route>) {
  const calls: Record<string, number> = {};
  const bodies: Record<string, Array<Record<string, unknown>>> = {};
  const fetchImpl: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls[path] = (calls[path] ?? 0) + 1;
    (bodies[path] ??= []).push(body);
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({error: 'not found'}), {status: 404});
    const {status, body: res} = route(body, calls[path]);
    return new Response(typeof res === 'string' ? res : JSON.stringify(res), {status});
  };
  return {fetchImpl, calls, bodies};
}

/** Reach the private mint (start() would also open the tunnel — not under test). */
const mintAttach = (client: ForwardingClient, id: SiteIdentity) =>
  (client as unknown as {mintAttach(i: SiteIdentity): Promise<{relayWsUrl: string; ticket: string; host: string}>}).mintAttach(id);

function makeClient(fetchImpl: FetchLike): ForwardingClient {
  return new ForwardingClient({
    accountUrl: ACCOUNT,
    authToken: 'device-tok',
    keyStore: new MemoryKeyStore(),
    localOrigin: 'http://127.0.0.1:1',
    fetchImpl,
  });
}

describe('ForwardingClient.api — error-body surfacing', () => {
  it('folds the server’s JSON {error} into the thrown message, with path + status', async () => {
    const {fetchImpl} = fakeAccountApi({
      '/api/sites': () => ({status: 400, body: {error: 'site quota exceeded'}}),
    });
    // An empty keystore drives ensureSite → provision → POST /api/sites.
    const err = await makeClient(fetchImpl).ensureSite().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForwardingApiError);
    expect((err as ForwardingApiError).message).toBe('/api/sites → 400 (site quota exceeded)');
    expect((err as ForwardingApiError).status).toBe(400);
    expect((err as ForwardingApiError).path).toBe('/api/sites');
  });

  it('falls back to the bare path + status when the error body is not JSON', async () => {
    const {fetchImpl} = fakeAccountApi({
      '/api/sites': () => ({status: 502, body: 'Bad Gateway'}),
    });
    const err = await makeClient(fetchImpl).ensureSite().catch((e: unknown) => e);

    expect((err as ForwardingApiError).message).toBe('/api/sites → 502');
  });
});

describe('ForwardingClient.mintAttach — single retry on a burnt challenge', () => {
  it('retries ONCE with a freshly minted challenge when the attach POST 400s', async () => {
    const id = await makeIdentity();
    const {fetchImpl, calls, bodies} = fakeAccountApi({
      '/api/sites/challenge': (_body, call) => ({status: 200, body: {nonce: `nonce-${call}`, ts: Date.now()}}),
      '/api/sites/attach-ticket': (_body, call) =>
        call === 1
          ? {status: 400, body: {error: 'challenge nonce expired'}}
          : {status: 200, body: {ticket: 'ticket-2', relayBase: 'https://relay.test/', host: 'demo.book.cloud', region: 'sin1'}},
    });

    const res = await mintAttach(makeClient(fetchImpl), id);

    expect(res.ticket).toBe('ticket-2');
    expect(res.host).toBe('demo.book.cloud');
    // The retry re-ran the WHOLE sequence: a second challenge, a second signed attach…
    expect(calls['/api/sites/challenge']).toBe(2);
    expect(calls['/api/sites/attach-ticket']).toBe(2);
    // …and the second attach carried the FRESH nonce, not the burnt one.
    expect(bodies['/api/sites/attach-ticket'][0].nonce).toBe('nonce-1');
    expect(bodies['/api/sites/attach-ticket'][1].nonce).toBe('nonce-2');
  });

  it('gives up after the second 400 (one retry, not a loop), surfacing the detail', async () => {
    const id = await makeIdentity();
    const {fetchImpl, calls} = fakeAccountApi({
      '/api/sites/challenge': (_body, call) => ({status: 200, body: {nonce: `nonce-${call}`, ts: Date.now()}}),
      '/api/sites/attach-ticket': () => ({status: 400, body: {error: 'site is suspended'}}),
    });

    const err = await mintAttach(makeClient(fetchImpl), id).catch((e: unknown) => e);

    expect((err as ForwardingApiError).message).toBe('/api/sites/attach-ticket → 400 (site is suspended)');
    expect(calls['/api/sites/attach-ticket']).toBe(2);
  });

  it('does NOT retry a non-400 attach failure (a 5xx is not a burnt nonce)', async () => {
    const id = await makeIdentity();
    const {fetchImpl, calls} = fakeAccountApi({
      '/api/sites/challenge': (_body, call) => ({status: 200, body: {nonce: `nonce-${call}`, ts: Date.now()}}),
      '/api/sites/attach-ticket': () => ({status: 503, body: {error: 'relay unavailable'}}),
    });

    const err = await mintAttach(makeClient(fetchImpl), id).catch((e: unknown) => e);

    expect((err as ForwardingApiError).status).toBe(503);
    expect(calls['/api/sites/attach-ticket']).toBe(1);
  });

  it('does NOT retry when the CHALLENGE itself 400s (nothing was burnt)', async () => {
    const id = await makeIdentity();
    const {fetchImpl, calls} = fakeAccountApi({
      '/api/sites/challenge': () => ({status: 400, body: {error: 'unknown public key'}}),
    });

    const err = await mintAttach(makeClient(fetchImpl), id).catch((e: unknown) => e);

    expect((err as ForwardingApiError).path).toBe('/api/sites/challenge');
    expect(calls['/api/sites/challenge']).toBe(1);
    expect(calls['/api/sites/attach-ticket']).toBeUndefined();
  });
});
