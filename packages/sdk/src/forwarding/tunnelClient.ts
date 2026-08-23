// The reusable tunnel client the desktop embeds (Tauri webview/sidecar, Node, or
// any runtime with global `WebSocket` + `fetch`). It dials OUT to the relay,
// completes the double-gated attach (signs the relay's nonce with the site key +
// presents the account ticket), then serves inbound requests against the local
// OpenBook data server, streaming responses — including SSE — back up the tunnel.
//
// No Node-only APIs, so it also runs inside the Tauri webview. On the desktop the
// `fetchImpl` is the IPC transport, so forwarded traffic reaches the portless
// local server without opening a TCP port.

import {globalFetch, type FetchLike} from '../client';
import {LOCAL_OWNER_HEADER} from '../identity';
import {buildRelayAttachMessage} from './challenge';
import {signWithSiteKey} from './siteKey';
import {decodeBody, decodeControl, encodeBody, encodeControl, FORWARDED_HEADER, type ControlFrame} from './tunnelProtocol';

export type TunnelStatus = 'connecting' | 'online' | 'reconnecting' | 'stalled' | 'offline';

export interface TunnelClientOptions {
  /**
   * Mint a FRESH relay URL + attach ticket for each (re)connection. Tickets are
   * short-lived (≈120s), so the tunnel must obtain a new one every time it dials
   * — reusing a single ticket across a reconnect (or a slow first connect) makes
   * the relay reject the attach as expired ("attach failed"), and the tunnel
   * then loops forever on the same dead ticket. The provider re-runs the account
   * challenge → attach-ticket flow; its `relayWsUrl` must include the `?site=`
   * routing hint the relay needs on the WS upgrade.
   */
  ticketProvider: () => Promise<{relayWsUrl: string; ticket: string}>;
  /** The site's private key (base64url PKCS#8) from the OS keychain. */
  privateKey: string;
  /** The local OpenBook data server origin, e.g. http://127.0.0.1:4317 (or '' when
   *  `fetchImpl` resolves paths itself, as the desktop IPC transport does). */
  localOrigin: string;
  onStatus?: (status: TunnelStatus) => void;
  /** Reports every failed mint/open/attach attempt with its original structured error. */
  onDialError?: (error: unknown) => void;
  fetchImpl?: FetchLike;
  webSocketImpl?: typeof WebSocket;
  maxBackoffMs?: number;
}

type ReqFrame = Extract<ControlFrame, {t: 'req'}>;

const HEARTBEAT_INTERVAL_MS = 25_000;
const LIVENESS_DEADLINE_MS = 62_500;
const TICKET_MINT_TIMEOUT_MS = 15_000;

interface Inflight {
  controller: AbortController;
  bodyController?: ReadableStreamDefaultController<Uint8Array>;
}

export class TunnelClient {
  private ws?: WebSocket;
  private status: TunnelStatus = 'offline';
  private backoff = 500;
  private stopped = false;
  private readonly inflight = new Map<number, Inflight>();
  private readonly fetchImpl: FetchLike;
  private readonly WS: typeof WebSocket;
  /** The ticket for the current connection, minted just before the WS opened. */
  private ticket?: string;
  private consecutiveDialFailures = 0;
  private ready = false;
  private failureReportedForDial = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private livenessTimer?: ReturnType<typeof setTimeout>;
  private lastFrameAt = 0;

  constructor(private readonly opts: TunnelClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalFetch;
    this.WS = opts.webSocketImpl ?? WebSocket;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeatTimers();
    this.consecutiveDialFailures = 0;
    this.setStatus('offline');
    this.ws?.close();
  }

  get currentStatus(): TunnelStatus {
    return this.status;
  }

  private setStatus(next: TunnelStatus): void {
    if (next !== this.status) {
      this.status = next;
      this.opts.onStatus?.(next);
    }
  }

  private connect(): void {
    if (this.consecutiveDialFailures < 2) this.setStatus(this.backoff > 500 ? 'reconnecting' : 'connecting');
    void this.dial();
  }

  /** Mint a fresh ticket, then open the relay socket with it. Minting per dial is
   *  what keeps reconnects working — a reused ticket expires and attach fails. */
  private async dial(): Promise<void> {
    this.clearHeartbeatTimers();
    try {
      const info = await this.mintTicket();
      if (this.stopped) return;
      this.ticket = info.ticket;
      this.ready = false;
      this.failureReportedForDial = false;
      const ws = new this.WS(info.relayWsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onmessage = (ev) => void this.onMessage(ev.data);
      ws.onclose = () => this.onClose();
      ws.onerror = () => ws.close();
    } catch (error) {
      if (this.stopped) return;
      this.reportDialError(error);
      this.scheduleReconnect();
    }
  }

  private onClose(): void {
    this.clearHeartbeatTimers();
    for (const f of this.inflight.values()) f.controller.abort();
    this.inflight.clear();
    if (!this.stopped && !this.ready && !this.failureReportedForDial) {
      this.reportDialError(new Error('relay connection closed before the attach completed'));
    }
    this.ready = false;
    this.scheduleReconnect();
  }

  private reportDialError(error: unknown): void {
    this.failureReportedForDial = true;
    this.consecutiveDialFailures += 1;
    this.opts.onDialError?.(error);
    if (this.consecutiveDialFailures >= 2) this.setStatus('stalled');
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      this.setStatus('offline');
      return;
    }
    if (this.consecutiveDialFailures < 2) this.setStatus('reconnecting');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private async mintTicket(): Promise<{relayWsUrl: string; ticket: string}> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.opts.ticketProvider(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('relay attach-ticket mint timed out after 15000ms')), TICKET_MINT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimers();
    this.lastFrameAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.sendControl({t: 'ping'}), HEARTBEAT_INTERVAL_MS);
    this.armLivenessDeadline();
  }

  private armLivenessDeadline(): void {
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    const remaining = LIVENESS_DEADLINE_MS - (Date.now() - this.lastFrameAt);
    this.livenessTimer = setTimeout(() => {
      if (Date.now() - this.lastFrameAt >= LIVENESS_DEADLINE_MS) {
        this.ws?.close();
      } else {
        this.armLivenessDeadline();
      }
    }, Math.max(0, remaining));
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.heartbeatTimer = undefined;
    this.livenessTimer = undefined;
  }

  private sendControl(frame: ControlFrame): void {
    this.ws?.send(encodeControl(frame));
  }

  /** Pause while the socket's send buffer is backed up, so streaming a large
   *  response to a slow viewer can't grow memory without bound. */
  private async drain(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    const HIGH_WATER = 4 * 1024 * 1024; // 4 MB
    while (ws.readyState === ws.OPEN && ws.bufferedAmount > HIGH_WATER) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async onMessage(data: string | ArrayBuffer): Promise<void> {
    if (this.stopped) return;
    this.lastFrameAt = Date.now();
    if (this.ready) this.armLivenessDeadline();
    if (typeof data === 'string') {
      const frame = decodeControl(data);
      if (frame) await this.onControl(frame);
      return;
    }
    const {id, chunk} = decodeBody(new Uint8Array(data));
    this.inflight.get(id)?.bodyController?.enqueue(chunk);
  }

  private async onControl(frame: ControlFrame): Promise<void> {
    switch (frame.t) {
    case 'challenge': {
      if (!this.ticket) {
        this.ws?.close();
        break;
      }
      const signature = await signWithSiteKey(this.opts.privateKey, buildRelayAttachMessage(frame.nonce));
      this.sendControl({t: 'attach', ticket: this.ticket, signature});
      break;
    }
    case 'ready':
      this.backoff = 500;
      this.consecutiveDialFailures = 0;
      this.ready = true;
      this.failureReportedForDial = false;
      this.setStatus('online');
      this.startHeartbeat();
      break;
    case 'error':
      this.reportDialError(new Error(frame.message));
      this.ws?.close();
      break;
    case 'ping':
      this.sendControl({t: 'pong'});
      break;
    case 'req':
      void this.handleRequest(frame);
      break;
    case 'end': {
      const f = this.inflight.get(frame.id);
      f?.bodyController?.close();
      if (f) f.bodyController = undefined;
      break;
    }
    case 'abort': {
      this.inflight.get(frame.id)?.controller.abort();
      this.inflight.delete(frame.id);
      break;
    }
    default:
      break;
    }
  }

  private async handleRequest(frame: ReqFrame): Promise<void> {
    const {id} = frame;
    const controller = new AbortController();
    const inflight: Inflight = {controller};
    this.inflight.set(id, inflight);

    const hasBody = frame.method !== 'GET' && frame.method !== 'HEAD';
    let body: ReadableStream<Uint8Array> | undefined;
    if (hasBody) {
      body = new ReadableStream<Uint8Array>({
        start: (c) => {
          inflight.bodyController = c;
        },
      });
    }

    const url = `${this.opts.localOrigin.replace(/\/$/, '')}${frame.path}`;
    const headers = new Headers();
    const forwardedLk = FORWARDED_HEADER.toLowerCase();
    const localOwnerLk = LOCAL_OWNER_HEADER.toLowerCase();
    for (const [k, v] of frame.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
      // Drop any inbound copy of the forwarded marker — it is OURS to assert, never
      // client-supplied. The origin's exposure backstop trusts it precisely because
      // only this client sets it (OB-209).
      if (lk === forwardedLk) continue;
      // Likewise drop any inbound local-owner secret: it authenticates the app's own
      // webview to the local server, and a remote viewer must never be able to replay
      // one through the tunnel (belt-and-braces — the origin also ignores it on any
      // request carrying the forwarded marker).
      if (lk === localOwnerLk) continue;
      headers.append(k, v);
    }
    // Mark every forwarded request as exposed. Set unconditionally (after the strip
    // above) so the origin can fail closed on the tunnelled path while the instance
    // is still unclaimed, even if the UI claim-on-publish guard were bypassed.
    headers.set(FORWARDED_HEADER, '1');

    const init: RequestInit & {duplex?: 'half'} = {method: frame.method, headers, signal: controller.signal};
    if (hasBody) {
      init.body = body as unknown as BodyInit;
      init.duplex = 'half';
    }

    try {
      // `fetchImpl` MUST resolve as soon as the status+headers are known and stream
      // the body — not buffer it (OB-284). We forward the `res` frame immediately so
      // a tunneled `EventSource` sees HTTP 200 at once, then relay each body chunk as
      // it arrives. An infinite SSE body therefore streams live; a localFetch that
      // buffered to EOF (the old desktop IPC bridge) would never reach this line for
      // `/api/live` and the relay would abort the exchange at 120s.
      const res = await this.fetchImpl(url, init);
      const resHeaders: [string, string][] = [];
      res.headers.forEach((value, key) => resHeaders.push([key, value]));
      this.sendControl({t: 'res', id, status: res.status, headers: resHeaders});
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            this.ws?.send(encodeBody(id, value));
            await this.drain(); // backpressure: don't outrun a slow consumer
          }
        }
      }
      this.sendControl({t: 'end', id});
    } catch {
      // A relay-side `abort` (the viewer left) aborts `controller`, which cancels the
      // localFetch stream — and via `init.signal` the underlying IPC task/socket. We
      // suppress the redundant `abort` frame in that case; any OTHER failure reports one.
      if (!controller.signal.aborted) this.sendControl({t: 'abort', id, reason: 'local fetch failed'});
    } finally {
      this.inflight.delete(id);
    }
  }
}
