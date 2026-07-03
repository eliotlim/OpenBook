// The desktop-side orchestrator — a thin client over the key-provisioning and
// relay APIs. The Tauri app wraps this: it supplies a keychain-backed KeyStore and
// the local OpenBook origin, and gets back a one-call "forward this instance".
//
// Flow:
//   ensureSite() → reattach if we already hold a site key, else provision a new one
//                  (private key is returned ONCE and handed to the KeyStore).
//   start()      → challenge + sign + attach-ticket, then open the tunnel.
//
// Runtime-agnostic (fetch + WebSocket globals); no Node-only APIs, so it runs in
// the Tauri webview or a sidecar alike.

import {globalFetch, type FetchLike} from '../client';
import {buildAttachMessage, buildReattachMessage} from './challenge';
import {signWithSiteKey} from './siteKey';
import {TunnelClient, type TunnelStatus} from './tunnelClient';

export interface SiteIdentity {
  siteId: string;
  prefix: string;
  host: string;
  publicKey: string;
  /** base64url PKCS#8 — the secret. Persist ONLY in the OS keychain. */
  privateKey: string;
}

/** Where the site identity (incl. private key) is persisted. The desktop backs
 *  this with the OS keychain; tests can use MemoryKeyStore. */
export interface KeyStore {
  load(): Promise<SiteIdentity | null>;
  save(identity: SiteIdentity): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryKeyStore implements KeyStore {
  private identity: SiteIdentity | null = null;
  async load(): Promise<SiteIdentity | null> {
    return this.identity;
  }
  async save(identity: SiteIdentity): Promise<void> {
    this.identity = identity;
  }
  async clear(): Promise<void> {
    this.identity = null;
  }
}

/**
 * Thrown on a non-OK account-API response. Carries the `path` + `status` so
 * callers can branch structurally (e.g. the attach-ticket 400 retry below)
 * instead of string-matching, and folds the server's own JSON `{error}` detail
 * into the message — "nonce expired" vs a bare 400 is the difference between a
 * diagnosable failure and a dead end.
 */
export class ForwardingApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    detail?: string,
  ) {
    super(detail ? `${path} → ${status} (${detail})` : `${path} → ${status}`);
    this.name = 'ForwardingApiError';
  }
}

export interface ForwardingClientOptions {
  /** https://account.book.pub */
  accountUrl: string;
  /** A device bearer token for the account API (the desktop already holds one). */
  authToken: string;
  keyStore: KeyStore;
  /** Local OpenBook data-server origin to forward, e.g. http://127.0.0.1:4317, or
   *  '' when {@link localFetchImpl} resolves paths itself (the desktop IPC transport). */
  localOrigin: string;
  /** The cell to attach in (nearest region). Defaults to the platform home cell. */
  region?: string;
  onStatus?: (status: TunnelStatus) => void;
  /** `fetch` for the account API (account.book.pub). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /**
   * `fetch` the tunnel uses to serve inbound requests against the local origin.
   * Distinct from {@link fetchImpl} so the desktop can route the account API to
   * account.book.pub (global fetch) while the tunnel forwards to the *portless*
   * local server over its IPC transport. Defaults to {@link fetchImpl}.
   */
  localFetchImpl?: FetchLike;
  webSocketImpl?: typeof WebSocket;
}

export class ForwardingClient {
  private tunnel?: TunnelClient;
  private identity?: SiteIdentity;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: ForwardingClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
  }

  get site(): SiteIdentity | undefined {
    return this.identity;
  }

  private get region(): string {
    return this.opts.region ?? 'sin1';
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.accountUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {authorization: `Bearer ${this.opts.authToken}`, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const body = (await res.json()) as {error?: unknown};
        if (typeof body.error === 'string' && body.error) detail = body.error;
      } catch {
        /* non-JSON error body — the path + status alone will have to do */
      }
      throw new ForwardingApiError(path, res.status, detail);
    }
    return (await res.json()) as T;
  }

  /** Reattach to our existing site (if we hold its key), else provision a new one. */
  async ensureSite(): Promise<SiteIdentity> {
    if (this.identity) return this.identity;
    const stored = await this.opts.keyStore.load();
    if (stored && (await this.reattach(stored))) {
      this.identity = stored;
      return stored;
    }
    const provisioned = await this.provision();
    await this.opts.keyStore.save(provisioned);
    this.identity = provisioned;
    return provisioned;
  }

  private async provision(): Promise<SiteIdentity> {
    const data = await this.api<{
      site: {id: string; prefix: string; host: string; publicKey: string};
      privateKey: string;
    }>('/api/sites', {});
    return {
      siteId: data.site.id,
      prefix: data.site.prefix,
      host: data.site.host,
      publicKey: data.site.publicKey,
      privateKey: data.privateKey,
    };
  }

  private async challenge(publicKey: string): Promise<{nonce: string; ts: number}> {
    return this.api<{nonce: string; ts: number}>('/api/sites/challenge', {publicKey});
  }

  private async reattach(id: SiteIdentity): Promise<boolean> {
    try {
      const {nonce, ts} = await this.challenge(id.publicKey);
      const signature = await signWithSiteKey(id.privateKey, buildReattachMessage({publicKey: id.publicKey, nonce, ts}));
      await this.api('/api/sites/reattach', {publicKey: id.publicKey, nonce, ts, signature});
      return true;
    } catch {
      return false; // key unknown/rotated → caller re-provisions
    }
  }

  /**
   * Mint a fresh attach ticket + relay WS URL. Run once per (re)connection: the
   * ticket is short-lived (≈120s), so the tunnel re-mints every time it dials
   * rather than reusing a stale one (which the relay rejects as expired). The
   * `?site=` query is the relay's Durable-Object routing hint on the WS upgrade
   * (an untrusted hint — the relay still verifies the ticket + site-key signature
   * after connecting); omitting it makes the upgrade fail with 400 "missing site".
   */
  private async mintAttach(id: SiteIdentity): Promise<{relayWsUrl: string; ticket: string; host: string}> {
    try {
      return await this.mintAttachOnce(id);
    } catch (e) {
      // The challenge nonce is single-use with a ~120s TTL, so a slow keychain
      // sign or clock skew can burn it before the attach POST lands — the account
      // then 400s a perfectly healthy client. The sequence is cheap and safe to
      // re-run (each attempt mints its own nonce), so retry ONCE with a fresh
      // challenge before surfacing the failure.
      const staleChallenge = e instanceof ForwardingApiError && e.status === 400 && e.path === '/api/sites/attach-ticket';
      if (!staleChallenge) throw e;
      return this.mintAttachOnce(id);
    }
  }

  /** One challenge → sign → attach-ticket pass (see {@link mintAttach} for the retry). */
  private async mintAttachOnce(id: SiteIdentity): Promise<{relayWsUrl: string; ticket: string; host: string}> {
    const {nonce, ts} = await this.challenge(id.publicKey);
    const signature = await signWithSiteKey(
      id.privateKey,
      buildAttachMessage({siteId: id.siteId, region: this.region, nonce, ts}),
    );
    const res = await this.api<{ticket: string; relayBase: string; host: string; region: string}>(
      '/api/sites/attach-ticket',
      {siteId: id.siteId, nonce, ts, signature, region: this.region},
    );
    return {
      relayWsUrl: `${res.relayBase.replace(/\/$/, '')}/__tunnel?site=${encodeURIComponent(id.siteId)}`,
      ticket: res.ticket,
      host: res.host, // canonical host for this prefix; heals a stale book.pub→book.cloud
    };
  }

  /** Begin forwarding the local instance. Resolves with the public host. */
  async start(): Promise<{host: string}> {
    const stored = await this.ensureSite();
    // Mint once up front to learn the canonical host for our prefix. After the
    // book.pub→book.cloud root migration, a persisted identity can carry a stale
    // host while the edge now mints aud=<prefix>.book.cloud — the origin would then
    // reject every forwarded request as `wrong-audience`. The account returns the
    // fresh host on attach; adopt + persist it so the recorded aud heals itself.
    const {host} = await this.mintAttach(stored);
    const id = host && host !== stored.host ? {...stored, host} : stored;
    if (id !== stored) {
      await this.opts.keyStore.save(id);
      this.identity = id;
    }
    this.tunnel = new TunnelClient({
      ticketProvider: () => this.mintAttach(id), // fresh ticket per (re)connect
      privateKey: id.privateKey,
      localOrigin: this.opts.localOrigin,
      onStatus: this.opts.onStatus,
      // The tunnel forwards to the LOCAL server; the desktop routes that over IPC
      // (no port), separate from the account API's global fetch.
      fetchImpl: this.opts.localFetchImpl ?? this.opts.fetchImpl,
      webSocketImpl: this.opts.webSocketImpl,
    });
    this.tunnel.start();
    return {host: id.host};
  }

  /** Stop forwarding (the site stays registered; reconnect later with the same key). */
  stop(): void {
    this.tunnel?.stop();
    this.tunnel = undefined;
  }
}
