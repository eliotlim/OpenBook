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
import {buildRelayAttachMessage} from './challenge';
import {signWithSiteKey} from './siteKey';
import {decodeBody, decodeControl, encodeBody, encodeControl, type ControlFrame} from './tunnelProtocol';

export type TunnelStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface TunnelClientOptions {
  /** wss://relay-host/__tunnel — from the account attach-ticket response. */
  relayWsUrl: string;
  /** The account-issued attach ticket (short-lived). */
  ticket: string;
  /** The site's private key (base64url PKCS#8) from the OS keychain. */
  privateKey: string;
  /** The local OpenBook data server origin, e.g. http://127.0.0.1:4317 (or '' when
   *  `fetchImpl` resolves paths itself, as the desktop IPC transport does). */
  localOrigin: string;
  onStatus?: (status: TunnelStatus) => void;
  fetchImpl?: FetchLike;
  webSocketImpl?: typeof WebSocket;
  maxBackoffMs?: number;
}

type ReqFrame = Extract<ControlFrame, {t: 'req'}>;

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
    this.setStatus(this.backoff > 500 ? 'reconnecting' : 'connecting');
    const ws = new this.WS(this.opts.relayWsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => void this.onMessage(ev.data);
    ws.onclose = () => this.onClose();
    ws.onerror = () => ws.close();
  }

  private onClose(): void {
    for (const f of this.inflight.values()) f.controller.abort();
    this.inflight.clear();
    if (this.stopped) {
      this.setStatus('offline');
      return;
    }
    this.setStatus('reconnecting');
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
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
      const signature = await signWithSiteKey(this.opts.privateKey, buildRelayAttachMessage(frame.nonce));
      this.sendControl({t: 'attach', ticket: this.opts.ticket, signature});
      break;
    }
    case 'ready':
      this.backoff = 500;
      this.setStatus('online');
      break;
    case 'error':
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
    for (const [k, v] of frame.headers) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
      headers.append(k, v);
    }

    const init: RequestInit & {duplex?: 'half'} = {method: frame.method, headers, signal: controller.signal};
    if (hasBody) {
      init.body = body as unknown as BodyInit;
      init.duplex = 'half';
    }

    try {
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
      if (!controller.signal.aborted) this.sendControl({t: 'abort', id, reason: 'local fetch failed'});
    } finally {
      this.inflight.delete(id);
    }
  }
}
