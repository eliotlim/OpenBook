import {describe, expect, it} from 'vitest';
import {
  ForwardingClient,
  FORWARDED_HEADER,
  MemoryKeyStore,
  SiteReattachError,
  mintSiteKeypair,
  type KeyStore,
  type SiteIdentity,
} from '@book.dev/sdk';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'X-OpenBook-Client': '1'}});

/** Poll until `pred` holds. The tunnel's dial chain spans several async hops
 *  (challenge → WebCrypto sign → attach-ticket → open) plus a reconnect backoff,
 *  so a single fixed tick races it and flakes. */
const waitFor = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const opts = (keyStore: KeyStore, fetchImpl: typeof fetch) => ({
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

  // The instance name is a pure hash of the site key, so replacing the stored
  // identity RENAMES the published address. ensureSite may provision over a held
  // identity in exactly one case: the account itself confirmed no site holds the
  // key (reattach 404). Every other reattach failure keeps the identity and
  // surfaces a SiteReattachError (NAME-1).
  describe('reattach failures (name stability)', () => {
    const seeded = async (): Promise<{keyStore: MemoryKeyStore; stored: SiteIdentity}> => {
      const kp = await mintSiteKeypair();
      const stored: SiteIdentity = {siteId: 'old', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey, privateKey: kp.privateKey};
      const keyStore = new MemoryKeyStore();
      await keyStore.save(stored);
      return {keyStore, stored};
    };

    it('re-provisions ONLY on 404 — the account confirmed no site holds this key', async () => {
      const {keyStore} = await seeded();
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
        if (path === '/api/sites/reattach') return json({error: 'no site for that key'}, 404);
        if (path === '/api/sites') return json({site: {id: 'new', prefix: 'q', host: 'q.book.pub', publicKey: 'P2'}, privateKey: 'K2'}, 201);
        throw new Error(`unexpected ${path}`);
      };
      const id = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite();

      expect(id.siteId).toBe('new');
      expect((await keyStore.load())?.siteId).toBe('new');
    });

    it('503 (challenge-store outage) → retryable error, NO provision, identity intact', async () => {
      const {keyStore, stored} = await seeded();
      const paths: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
        if (path === '/api/sites/reattach') return json({error: 'challenge store unavailable'}, 503);
        throw new Error(`unexpected ${path}`);
      };
      const err = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SiteReattachError);
      expect((err as SiteReattachError).code).toBe('unreachable');
      expect((err as SiteReattachError).retryable).toBe(true);
      expect(paths).not.toContain('/api/sites'); // never provisioned
      expect((await keyStore.load())?.siteId).toBe(stored.siteId); // address kept
    });

    it('network failure → retryable error, NO provision, identity intact', async () => {
      const {keyStore, stored} = await seeded();
      const fetchImpl: typeof fetch = async () => {
        throw new TypeError('fetch failed');
      };
      const err = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SiteReattachError);
      expect((err as SiteReattachError).code).toBe('unreachable');
      expect((await keyStore.load())?.siteId).toBe(stored.siteId);
    });

    it('403 (site belongs to another account) → distinct error, NO provision, NO overwrite', async () => {
      const {keyStore, stored} = await seeded();
      const paths: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
        if (path === '/api/sites/reattach') return json({error: 'site belongs to another account'}, 403);
        throw new Error(`unexpected ${path}`);
      };
      const err = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SiteReattachError);
      expect((err as SiteReattachError).code).toBe('wrong-account');
      expect((err as SiteReattachError).retryable).toBe(false);
      expect(paths).not.toContain('/api/sites');
      expect((await keyStore.load())?.siteId).toBe(stored.siteId);
    });

    it('400 (stale nonce) → ONE fresh-challenge retry, then reattaches without provisioning', async () => {
      const {keyStore, stored} = await seeded();
      let challenges = 0;
      let reattaches = 0;
      const paths: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path === '/api/sites/challenge') return json({nonce: `n${++challenges}`, ts: Date.now()});
        if (path === '/api/sites/reattach') {
          reattaches += 1;
          return reattaches === 1 ? json({error: 'unknown or already-used challenge'}, 400) : json({ok: true});
        }
        throw new Error(`unexpected ${path}`);
      };
      const id = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite();

      expect(id.siteId).toBe(stored.siteId); // same site, same name
      expect(challenges).toBe(2); // the retry minted a FRESH challenge
      expect(reattaches).toBe(2); // exactly one retry, not a loop
      expect(paths).not.toContain('/api/sites');
    });

    it('refuses to save over a DIFFERENT identity that appeared mid-provision', async () => {
      const kp = await mintSiteKeypair();
      const other: SiteIdentity = {siteId: 'other', prefix: 'o', host: 'o.book.pub', publicKey: kp.publicKey, privateKey: kp.privateKey};
      // load() reports empty (→ provision path), but by save time the slot holds
      // ANOTHER account's identity (e.g. an account switch swapped the namespaced
      // slot mid-flight) — ensureSite must refuse rather than clobber it.
      let loads = 0;
      let saved: SiteIdentity | null = null;
      const keyStore: KeyStore = {
        load: async () => (++loads === 1 ? null : other),
        save: async (id) => {
          saved = id;
        },
        clear: async () => undefined,
      };
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/sites') return json({site: {id: 'new', prefix: 'q', host: 'q.book.pub', publicKey: 'P2'}, privateKey: 'K2'}, 201);
        throw new Error(`unexpected ${path}`);
      };
      const err = await new ForwardingClient(opts(keyStore, fetchImpl)).ensureSite().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SiteReattachError);
      expect(saved).toBeNull(); // the held identity was never overwritten
    });

    it('resetSiteIdentity() is the explicit path to a fresh address', async () => {
      const {keyStore, stored} = await seeded();
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/sites') return json({site: {id: 'new', prefix: 'q', host: 'q.book.pub', publicKey: 'P2'}, privateKey: 'K2'}, 201);
        throw new Error(`unexpected ${path}`);
      };
      const client = new ForwardingClient(opts(keyStore, fetchImpl));

      await client.resetSiteIdentity();
      expect(await keyStore.load()).toBeNull(); // slot cleared, on purpose

      const id = await client.ensureSite(); // now — and only now — a new name
      expect(id.siteId).toBe('new');
      expect(id.siteId).not.toBe(stored.siteId);
    });
  });
});

/** A minimal WebSocket stand-in so start() can open a tunnel without a relay. */
function fakeWebSocket() {
  const sockets: Array<{
    url: string;
    onmessage: ((ev: {data: unknown}) => void) | null;
    onclose: (() => void) | null;
    sent: unknown[];
  }> = [];
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

    // The tunnel mints its attach ticket lazily, per dial (so a reconnect always
    // gets a fresh, unexpired one), then opens the WS — let that async work run.
    await waitFor(() => ws.sockets.length === 1);
    expect(accountCalls).toContain('/api/sites/attach-ticket');
    // …with the `?site=` routing hint the relay needs on the WS upgrade (else it
    // rejects with 400 "missing site").
    expect(ws.sockets[0].url).toBe('wss://relay.book.pub/__tunnel?site=s1');
    expect(new URL(ws.sockets[0].url).searchParams.get('site')).toBe('s1');

    // The relay pushes an inbound request → the tunnel must serve it via the
    // LOCAL fetch (IPC), never the account fetch.
    ws.sockets[0].onmessage?.({data: JSON.stringify({t: 'req', id: 1, method: 'GET', path: '/api/pages', headers: []})});
    await waitFor(() => localCalls.length === 1);
    expect(localCalls).toEqual(['/api/pages']);
  });

  it('marks every forwarded request as exposed, overriding any inbound marker (OB-209)', async () => {
    const kp = await mintSiteKeypair();
    const accountFetch: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/sites') return json({site: {id: 's1', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey}, privateKey: kp.privateKey}, 201);
      if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
      if (path === '/api/sites/attach-ticket') return json({ticket: 'TICKET', relayBase: 'wss://relay.book.pub', host: 'p.book.pub', region: 'iad1'});
      throw new Error(`unexpected ${path}`);
    };
    const seen: Headers[] = [];
    const localFetch: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
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
    await client.start();
    await waitFor(() => ws.sockets.length === 1);

    // A relay-forwarded request carrying a SPOOFED marker value + a real identity
    // header. The tunnel must (a) pass the identity through, and (b) overwrite the
    // marker with its own '1' — it is never client-supplied, so the origin can trust
    // it to fail closed while unclaimed.
    ws.sockets[0].onmessage?.({
      data: JSON.stringify({
        t: 'req',
        id: 1,
        method: 'GET',
        path: '/api/pages',
        headers: [
          [FORWARDED_HEADER, 'spoofed-0'],
          ['X-OpenBook-Identity', 'a.b.c'],
        ],
      }),
    });
    await waitFor(() => seen.length === 1);
    expect(seen[0].get(FORWARDED_HEADER)).toBe('1'); // our marker, not the spoof
    expect(seen[0].get('X-OpenBook-Identity')).toBe('a.b.c'); // identity still flows through
  });

  it('mints a FRESH ticket on every reconnect (no stale-ticket attach loop)', async () => {
    const kp = await mintSiteKeypair();
    let ticketMints = 0;
    const accountFetch: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/sites') {
        return json({site: {id: 's1', prefix: 'p', host: 'p.book.pub', publicKey: kp.publicKey}, privateKey: kp.privateKey}, 201);
      }
      if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
      if (path === '/api/sites/attach-ticket') {
        ticketMints += 1;
        return json({ticket: `T${ticketMints}`, relayBase: 'wss://relay.book.pub', host: 'p.book.pub', region: 'iad1'});
      }
      throw new Error(`unexpected ${path}`);
    };

    const ws = fakeWebSocket();
    const client = new ForwardingClient({
      accountUrl: 'https://account.book.pub',
      authToken: 'tok',
      keyStore: new MemoryKeyStore(),
      localOrigin: '',
      fetchImpl: accountFetch,
      localFetchImpl: async () => new Response('[]', {status: 200}),
      webSocketImpl: ws.ctor,
    });

    await client.start();
    await waitFor(() => ws.sockets.length === 1); // first dial: mint + open
    expect(ws.sockets).toHaveLength(1);
    // Two mints by now: start() mints once up front to learn the canonical host
    // (the stale-host audience heal), then the first dial mints its own ticket.
    expect(ticketMints).toBe(2);

    // The relay drops the socket (expired ticket / takeover / network blip). The
    // tunnel must reconnect AND mint a brand-new ticket — reusing the first one
    // would fail attach forever once it expires (the bug this guards).
    ws.sockets[0].onclose?.();
    await waitFor(() => ws.sockets.length === 2); // reconnect (500ms backoff) + fresh mint
    expect(ws.sockets).toHaveLength(2);
    expect(ticketMints).toBe(3); // up-front heal mint + one per dial (2 dials)
    expect(ws.sockets[1].url).toBe('wss://relay.book.pub/__tunnel?site=s1');
  });
});

/**
 * After the book.pub→book.cloud root-domain migration, an identity persisted at
 * provision time carries a stale host (`<prefix>.book.pub`), but the edge now
 * mints `aud=<prefix>.book.cloud` — so the origin rejects every forwarded request
 * as `identity rejected: wrong-audience`. The account returns the canonical host
 * on attach; start() mints once up front to learn it, then adopts + persists the
 * refreshed identity so the recorded audience heals itself.
 */
describe('ForwardingClient.start (stale-host audience heal)', () => {
  // A keystore seeded with `host`, whose save() calls are counted (the seed save
  // happens before the spy is installed, so only a heal write registers).
  const spyKeyStore = async (host: string): Promise<{store: MemoryKeyStore; saves: () => number}> => {
    const store = new MemoryKeyStore();
    const kp = await mintSiteKeypair();
    await store.save({siteId: 's1', prefix: 'p', host, publicKey: kp.publicKey, privateKey: kp.privateKey});
    let saves = 0;
    const orig = store.save.bind(store);
    store.save = async (id: SiteIdentity): Promise<void> => {
      saves += 1;
      await orig(id);
    };
    return {store, saves: () => saves};
  };

  // Account API for a held key: reattach succeeds, attach-ticket reports
  // `attachHost` as the canonical host for this prefix.
  const healFetch =
    (attachHost: string): typeof fetch =>
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/sites/challenge') return json({nonce: 'n', ts: Date.now()});
        if (path === '/api/sites/reattach') return json({ok: true});
        if (path === '/api/sites/attach-ticket')
          return json({ticket: 'TICKET', relayBase: 'wss://relay.book.cloud', host: attachHost, region: 'iad1'});
        throw new Error(`unexpected ${path}`);
      };

  const healClient = (keyStore: MemoryKeyStore, attachHost: string): ForwardingClient => {
    const ws = fakeWebSocket();
    return new ForwardingClient({
      accountUrl: 'https://account.book.cloud',
      authToken: 'tok',
      keyStore,
      localOrigin: '',
      fetchImpl: healFetch(attachHost),
      localFetchImpl: async () => new Response('[]', {status: 200}),
      webSocketImpl: ws.ctor,
    });
  };

  it('adopts + persists the fresh host when the stored one is stale', async () => {
    const {store, saves} = await spyKeyStore('p.book.pub'); // pre-migration host
    const client = healClient(store, 'p.book.cloud'); // account now reports book.cloud

    const result = await client.start();
    client.stop();

    expect(result).toEqual({host: 'p.book.cloud'}); // start() returns the canonical host
    expect(saves()).toBe(1); // healed identity persisted exactly once
    const reloaded = await store.load();
    expect(reloaded?.host).toBe('p.book.cloud');
    expect(reloaded?.siteId).toBe('s1'); // only the host changed; the key is preserved
    expect(client.site?.host).toBe('p.book.cloud'); // in-memory identity updated too
  });

  it('does not re-persist when the stored host is already canonical', async () => {
    const {store, saves} = await spyKeyStore('p.book.cloud');
    const client = healClient(store, 'p.book.cloud');

    const result = await client.start();
    client.stop();

    expect(result).toEqual({host: 'p.book.cloud'});
    expect(saves()).toBe(0); // nothing to heal → no keychain write
  });
});
