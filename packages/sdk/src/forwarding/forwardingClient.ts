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

/**
 * The published site's audience scope, mirrored from the account's
 * `@book.dev/forwarding` `SiteVisibility` (the single source of truth on the
 * server). Two scopes admit anonymous traffic at the edge:
 *   - `public` — the whole library is anonymous-readable; the edge forwards every
 *     request and the origin's per-page gate governs from there.
 *   - `published` — the edge admits anonymous traffic too, but the origin exposes
 *     ONLY pages whose visibility resolves to `public`; everything else 404s
 *     (fail-safe). This is the recommended default for a new site: "share the
 *     pages I publish, keep the rest private" with no whole-library exposure.
 * The remaining three (`authenticated`/`members`/`restricted`) require a signed-in
 * principal (fail-closed). A fresh site defaults to `published` on the account, and
 * {@link ForwardingClient.setSiteVisibility} flips the scope through the existing
 * `PATCH /api/sites/:id` route.
 */
export type SiteVisibility = 'public' | 'published' | 'authenticated' | 'members' | 'restricted';

/** Every {@link SiteVisibility}, matching the account's `SITE_VISIBILITIES`. */
export const SITE_VISIBILITIES: readonly SiteVisibility[] = [
  'public',
  'published',
  'authenticated',
  'members',
  'restricted',
];

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
    /** The server's own JSON `{error}` string, when it sent one — kept as a
     *  field (not just folded into the message) so callers can match the
     *  server's VERDICT, not merely its status code (see the reattach
     *  unknown-key discriminator). */
    public readonly detail?: string,
  ) {
    super(detail ? `${path} → ${status} (${detail})` : `${path} → ${status}`);
    this.name = 'ForwardingApiError';
  }
}

/**
 * Why a reattach could not complete — WITHOUT abandoning the stored identity.
 * The instance name is a pure hash of the site key, so silently re-provisioning
 * on any reattach hiccup renames the site. The ONLY legitimate re-provision
 * trigger is the account confirming it has no site for our key (reattach 404);
 * every other failure surfaces as this error, identity intact:
 *   - `unreachable`  — outage / 5xx / network: retry later, the address is kept.
 *   - `wrong-account` — the site exists but belongs to another account (403):
 *     switch accounts, or explicitly reset the saved address.
 *   - `rejected`     — any other refusal (bad signature, malformed request):
 *     surfaced for diagnosis, never auto-replaced.
 */
export type SiteReattachErrorCode = 'unreachable' | 'wrong-account' | 'rejected';

export class SiteReattachError extends Error {
  /** True when a plain retry may succeed (outage / network); the address is kept either way. */
  readonly retryable: boolean;

  constructor(
    public readonly code: SiteReattachErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SiteReattachError';
    this.retryable = code === 'unreachable';
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
  onDialError?: (error: unknown) => void;
  /** Reports the canonical host returned by the first successful attach mint,
   *  and again only if a later mint reports a different host. */
  onHost?: (host: string) => void;
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
  maxBackoffMs?: number;
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

  /**
   * One authorized account-API round-trip. Threads the device bearer token, folds
   * the server's `{error}` JSON into a {@link ForwardingApiError} on non-OK, and is
   * method-agnostic so the site-visibility GET/PATCH share the same error surface as
   * the POST provisioning flow (the {@link api} shorthand keeps the POST callers terse).
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.opts.accountUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {authorization: `Bearer ${this.opts.authToken}`, ...init.headers},
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

  private api<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
  }

  /** Resolve the registered site id without provisioning: the in-memory identity if
   *  the tunnel is up, else the persisted key's — throwing if no site exists yet
   *  (visibility is only meaningful for a site that's been registered). */
  private async requireSiteId(): Promise<string> {
    const id = this.identity ?? (await this.opts.keyStore.load());
    if (!id) throw new Error('no site registered — enable publishing first');
    return id.siteId;
  }

  /**
   * Read the published site's current audience scope from the account
   * (`GET /api/sites/:id`). The account is the source of truth — the desktop UI
   * reflects THIS, never a locally-assumed default, so it can honestly tell the
   * owner whether their address is Public or Private.
   */
  async getSiteVisibility(): Promise<SiteVisibility> {
    const siteId = await this.requireSiteId();
    const data = await this.request<{site: {visibility: SiteVisibility} | null}>(
      `/api/sites/${encodeURIComponent(siteId)}`,
      {method: 'GET'},
    );
    if (!data.site) throw new ForwardingApiError(`/api/sites/${siteId}`, 404, 'site not found');
    return data.site.visibility;
  }

  /**
   * Set the published site's audience scope via the EXISTING free-tier route
   * (`PATCH /api/sites/:id`, body `{visibility}`). The account whitelist-validates
   * the value and enforces owner-only server-side (a non-owner 404s); this client
   * only ever runs on the owner's device under their device bearer token. Returns
   * the persisted scope so the caller reflects the server's truth, not the request.
   */
  async setSiteVisibility(visibility: SiteVisibility): Promise<SiteVisibility> {
    const siteId = await this.requireSiteId();
    const data = await this.request<{site: {visibility: SiteVisibility}}>(
      `/api/sites/${encodeURIComponent(siteId)}`,
      {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({visibility})},
    );
    return data.site.visibility;
  }

  /**
   * Reattach to our existing site (if we hold its key), else provision a new one.
   *
   * The stored identity is the site's NAME (a pure hash of its public key), so
   * replacing it silently renames the published address. Provisioning therefore
   * happens in exactly two cases: no identity is stored, or the account
   * confirmed it has no site for our key (reattach 404 — see {@link reattach}).
   * Every other reattach failure throws a {@link SiteReattachError} with the
   * identity untouched; an on-purpose replacement goes through
   * {@link resetSiteIdentity} instead.
   */
  async ensureSite(): Promise<SiteIdentity> {
    if (this.identity) return this.identity;
    const stored = await this.opts.keyStore.load();
    if (stored) {
      // Throws (identity kept) unless the reattach succeeded or the account
      // confirmed the key is genuinely unknown.
      if ((await this.reattach(stored)) === 'ok') {
        this.identity = stored;
        return stored;
      }
      // 'unknown-key': the account has no site for this key — the one case
      // where replacing the stored identity is correct.
    }
    const provisioned = await this.provision();
    // Refuse to clobber a DIFFERENT identity than the one we just examined —
    // e.g. another window provisioned or an account switch swapped the slot
    // between our load and this save. Only an explicit reset may replace it.
    const current = await this.opts.keyStore.load();
    if (current && current.siteId !== stored?.siteId) {
      throw new SiteReattachError(
        'rejected',
        `a different site identity (${current.siteId}) is already stored — reset it explicitly before provisioning a new address`,
      );
    }
    await this.opts.keyStore.save(provisioned);
    this.identity = provisioned;
    return provisioned;
  }

  /**
   * Explicitly forget the stored site identity (and drop any live tunnel), so
   * the next {@link ensureSite} provisions a fresh address. This is the ONLY
   * sanctioned way to abandon an address besides the account confirming the
   * key unknown — intended to sit behind a user-confirmed "reset my address"
   * affordance, never behind an error handler.
   */
  async resetSiteIdentity(): Promise<void> {
    this.stop();
    this.identity = undefined;
    await this.opts.keyStore.clear();
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

  /**
   * Reattach the held key to its registered site. Returns `'ok'` on success and
   * `'unknown-key'` ONLY when the account itself said no site holds this key
   * (`POST /api/sites/reattach` → 404 "no site for that key") — the single
   * verdict that authorizes {@link ensureSite} to provision a replacement.
   *
   * Everything else keeps the identity and throws a {@link SiteReattachError}:
   *   - reattach 400 (stale / already-consumed challenge nonce) → retry ONCE
   *     with a fresh challenge, mirroring {@link mintAttach} — a slow keychain
   *     sign or clock skew burns the ~120s single-use nonce on a healthy client;
   *   - reattach 403 → `wrong-account` (the site belongs to another account);
   *   - any 5xx (challenge-store outage 503 included) or a network/transport
   *     failure → `unreachable` (retryable — the address is kept);
   *   - any other refusal (e.g. 401 bad signature) → `rejected`.
   */
  private async reattach(id: SiteIdentity): Promise<'ok' | 'unknown-key'> {
    try {
      await this.reattachOnce(id);
      return 'ok';
    } catch (e) {
      const staleNonce = e instanceof ForwardingApiError && e.status === 400 && e.path === '/api/sites/reattach';
      if (!staleNonce) return this.classifyReattachFailure(e);
      try {
        await this.reattachOnce(id); // one fresh-challenge retry, then surface
        return 'ok';
      } catch (retryErr) {
        return this.classifyReattachFailure(retryErr);
      }
    }
  }

  /** One challenge → sign → reattach pass (see {@link reattach} for the retry). */
  private async reattachOnce(id: SiteIdentity): Promise<void> {
    const {nonce, ts} = await this.challenge(id.publicKey);
    const signature = await signWithSiteKey(id.privateKey, buildReattachMessage({publicKey: id.publicKey, nonce, ts}));
    await this.api('/api/sites/reattach', {publicKey: id.publicKey, nonce, ts, signature});
  }

  /** Map a reattach failure to the one re-provision verdict or a kept-identity error (see {@link reattach}). */
  private classifyReattachFailure(e: unknown): 'unknown-key' {
    if (e instanceof ForwardingApiError) {
      // The unknown-key verdict must be the SERVER's, not the transport's: a
      // bare route-level 404 (account rollback/misdeploy where the reattach
      // route itself is missing) also arrives as status 404, and treating it
      // as "no site holds this key" would provision a replacement — a silent
      // rename. So require the reattach route's own body string too.
      // Cross-repo contract: open.book.pub packages/account/app/api/sites/
      // reattach/route.ts responds `{error: 'no site for that key'}` (404).
      // Follow-up (server-side, not this repo): also return a structured
      // `{code: 'unknown-key'}` and match that first, keeping this string as
      // the fallback.
      if (e.path === '/api/sites/reattach' && e.status === 404 && e.detail === 'no site for that key') {
        return 'unknown-key';
      }
      if (e.path === '/api/sites/reattach' && e.status === 403) {
        throw new SiteReattachError(
          'wrong-account',
          'this saved address belongs to a different account — switch to that account, or reset the saved address to publish a new one here',
        );
      }
      if (e.status >= 500) {
        throw new SiteReattachError('unreachable', `couldn't reconnect — your address is kept; try again shortly (${e.message})`);
      }
      throw new SiteReattachError('rejected', `reattach was refused (${e.message}) — your address is kept`);
    }
    // Transport-level failure (fetch threw): nothing said the key is unknown.
    const detail = e instanceof Error ? e.message : String(e);
    throw new SiteReattachError('unreachable', `couldn't reconnect — your address is kept; try again shortly (${detail})`);
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

  /** Adopt the account's canonical host without ever overwriting another account's keychain slot. */
  private async adoptCanonicalHost(stored: SiteIdentity, host: string): Promise<void> {
    const active = this.identity ?? stored;
    if (!host || active.siteId !== stored.siteId || host === active.host) return;
    const healed = {...active, host};
    // An account switch can re-point the per-account slot while a dial is in
    // flight. The in-memory client can still heal, but must not write its private
    // key into a slot that is now empty or belongs to another site.
    const current = await this.opts.keyStore.load();
    if (current?.siteId === stored.siteId) await this.opts.keyStore.save(healed);
    this.identity = healed;
  }

  /** Begin forwarding the local instance. Ticket minting happens inside the
   *  reconnecting tunnel, so a failed first mint cannot abort this start call. */
  async start(): Promise<{host: string}> {
    const id = await this.ensureSite();
    let reportedHost: string | undefined;
    this.tunnel = new TunnelClient({
      ticketProvider: async () => {
        const info = await this.mintAttach(id); // fresh ticket per (re)connect
        if (info.host && info.host !== reportedHost) {
          try {
            await this.adoptCanonicalHost(id, info.host);
          } catch {
            this.identity = {...(this.identity ?? id), host: info.host};
          }
          reportedHost = info.host;
          this.opts.onHost?.(info.host);
        }
        return info;
      },
      privateKey: id.privateKey,
      localOrigin: this.opts.localOrigin,
      onStatus: this.opts.onStatus,
      onDialError: this.opts.onDialError,
      // The tunnel forwards to the LOCAL server; the desktop routes that over IPC
      // (no port), separate from the account API's global fetch.
      fetchImpl: this.opts.localFetchImpl ?? this.opts.fetchImpl,
      webSocketImpl: this.opts.webSocketImpl,
      maxBackoffMs: this.opts.maxBackoffMs,
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
