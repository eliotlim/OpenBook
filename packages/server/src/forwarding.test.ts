import {describe, expect, it} from 'vitest';
import {ForwardingClient, MemoryKeyStore, mintSiteKeypair, type SiteIdentity} from '@open-book/sdk';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

const opts = (keyStore: MemoryKeyStore, fetchImpl: typeof fetch) => ({
  accountUrl: 'https://account.book.pub',
  authToken: 'device-token',
  keyStore,
  localOrigin: '',
  fetchImpl,
});

describe('ForwardingClient.ensureSite (the provisioning toggle)', () => {
  it('provisions a new site when the keystore is empty, and persists it', async () => {
    const calls: Array<{url: string; auth?: string}> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({url: String(input), auth: (init?.headers as Record<string, string>)?.authorization});
      return json(
        {site: {id: 's1', prefix: 'library-foo-bar-ab12', host: 'library-foo-bar-ab12.book.pub', publicKey: 'PUB'}, privateKey: 'PRIV'},
        201,
      );
    };
    const keyStore = new MemoryKeyStore();
    const id = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite();

    expect(id.host).toBe('library-foo-bar-ab12.book.pub');
    expect(id.privateKey).toBe('PRIV');
    expect(calls[0].url).toBe('https://account.book.pub/api/sites');
    expect(calls[0].auth).toBe('Bearer device-token');
    expect(await keyStore.load()).toMatchObject({siteId: 's1', host: 'library-foo-bar-ab12.book.pub'});
  });

  it('reattaches with a held key instead of provisioning a new site', async () => {
    const kp = await mintSiteKeypair();
    const stored: SiteIdentity = {siteId: 's1', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey, privateKey: kp.privateKey};
    const keyStore = new MemoryKeyStore();
    await keyStore.save(stored);

    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
      if (path === '/api/sites/reattach') return json({ok: true});
      throw new Error(`unexpected ${path}`);
    };
    const id = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite();

    expect(id.siteId).toBe('s1');
    // Reattach path only — never hit POST /api/sites.
    expect(paths).toEqual(['/api/sites/challenge', '/api/sites/reattach']);
  });

  it('re-provisions when reattach fails (stale/rotated key)', async () => {
    const kp = await mintSiteKeypair();
    const keyStore = new MemoryKeyStore();
    await keyStore.save({siteId: 'old', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey, privateKey: kp.privateKey});

    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
      if (path === '/api/sites/reattach') return json({error: 'unknown site'}, 404);
      if (path === '/api/sites') return json({site: {id: 'new', prefix: 'q', host: 'q.book.pub', publicKey: 'P2'}, privateKey: 'K2'}, 201);
      throw new Error(`unexpected ${path}`);
    };
    const id = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite();

    expect(id.siteId).toBe('new');
    expect((await keyStore.load())?.siteId).toBe('new');
  });
});

/** A minimal WebSocket stand-in so start() can open a tunnel without a relay. */
function fakeWebSocket() {
  const sockets: Array<{url: string; onmessage: ((ev: {data: unknown}) => void) | null; sent: unknown[]}> = [];
  class FakeWS {
    static OPEN = 1;
    OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    binaryType = 'blob';
    onmessage: ((ev: {data: unknown}) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    sent: unknown[] = [];
    url: string;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    close(): void {
      this.onclose?.();
    }
  }
  return {ctor: FakeWS as unknown as typeof WebSocket, sockets};
}

describe('ForwardingClient.start (live serving)', () => {
  it('uses fetchImpl for the account API and localFetchImpl for forwarding', async () => {
    const kp = await mintSiteKeypair();
    const accountCalls: string[] = [];
    const accountFetch: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      accountCalls.push(path);
      if (path === '/api/sites') return json({site: {id: 's1', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey}, privateKey: kp.privateKey}, 201);
      if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
      if (path === '/api/sites/attach-ticket') return json({ticket: 'TICKET', relayBase: 'wss://relay.book.pub', host: 'p.book.pub', region: 'iad1'});
      throw new Error(`unexpected ${path}`);
    };
    const localCalls: string[] = [];
    const localFetch: typeof fetch = async (input) => {
      localCalls.push(String(input));
      return new Response('[]', {status: 200});
    };

    const ws = fakeWebSocket();
    const client = new ForwardingClient({
      accountUrl: 'https://account.book.pub',
      authToken: 'tok',
      keyStore: new MemoryKeyStore(),
      localOrigin: '',
      fetchImpl: accountFetch,
      localFetchImpl: localFetch,
      webSocketImpl: ws.ctor,
    });

    const {host} = await client.start();
    expect(host).toBe('p.book.pub');
    expect(accountCalls).toContain('/api/sites/attach-ticket');
    expect(ws.sockets[0].url).toBe('wss://relay.book.pub/__tunnel');

    // The relay pushes an inbound request → the tunnel must serve it via the
    // LOCAL fetch (IPC), never the account fetch.
    ws.sockets[0].onmessage?.({data: JSON.stringify({t: 'req', id: 1, method: 'GET', path: '/api/pages', headers: []})});
    await new Promise((r) => setTimeout(r, 0));
    expect(localCalls).toEqual(['/api/pages']);
  });
});
