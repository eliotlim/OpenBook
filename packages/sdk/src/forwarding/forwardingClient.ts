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

import type {FetchLike} from '../client';
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
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get site(): SiteIdentity | undefined {
    return this.identity;
  }

  private get region(): string {
    return this.opts.region ?? 'iad1';
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.accountUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {authorization: `Bearer ${this.opts.authToken}`, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
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

  /** Begin forwarding the local instance. Resolves with the public host. */
  async start(): Promise<{host: string}> {
    const id = await this.ensureSite();
    const {nonce, ts} = await this.challenge(id.publicKey);
    const signature = await signWithSiteKey(
      id.privateKey,
      buildAttachMessage({siteId: id.siteId, region: this.region, nonce, ts}),
    );
    const ticketRes = await this.api<{ticket: string; relayBase: string; host: string; region: string}>(
      '/api/sites/attach-ticket',
      {siteId: id.siteId, nonce, ts, signature, region: this.region},
    );

    this.tunnel = new TunnelClient({
      relayWsUrl: `${ticketRes.relayBase.replace(/\/$/, '')}/__tunnel`,
      ticket: ticketRes.ticket,
      privateKey: id.privateKey,
      localOrigin: this.opts.localOrigin,
      onStatus: this.opts.onStatus,
      // The tunnel forwards to the LOCAL server; the desktop routes that over IPC
      // (no port), separate from the account API's global fetch.
      fetchImpl: this.opts.localFetchImpl ?? this.opts.fetchImpl,
      webSocketImpl: this.opts.webSocketImpl,
    });
    this.tunnel.start();
    return {host: ticketRes.host};
  }

  /** Stop forwarding (the site stays registered; reconnect later with the same key). */
  stop(): void {
    this.tunnel?.stop();
    this.tunnel = undefined;
  }
}
