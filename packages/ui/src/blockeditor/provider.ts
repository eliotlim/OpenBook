import * as Y from 'yjs';

/**
 * Collaboration transport. The editor only ever talks Y updates, so any
 * channel that ferries `Uint8Array`s works. This provider syncs every tab /
 * window of the same browser through a BroadcastChannel — real CRDT
 * convergence with presence, no server changes. A websocket relay can later
 * implement the same three messages (`hello` / `state` / `update`) to take
 * collaboration cross-device.
 */

interface WireMessage {
  type: 'hello' | 'state' | 'update' | 'presence';
  payload?: ArrayBuffer | Uint8Array | unknown;
}

export interface PresencePeer {
  clientId: number;
  name: string;
  color: string;
  blockId: string | null;
  at: number;
}

export interface BroadcastConnection {
  disconnect(): void;
  /** Update this client's presence (focused block). */
  setPresence(blockId: string | null): void;
  /** Subscribe to the live peer list (excluding self). */
  onPeers(cb: (peers: PresencePeer[]) => void): () => void;
}

const COLORS = ['#e4a33c', '#5b8def', '#4fae6e', '#c96bd6', '#e0635c', '#3aa6a6'];

export function connectBroadcast(doc: Y.Doc, channelName: string, userName = 'Guest'): BroadcastConnection {
  const bc = new BroadcastChannel(`obe:${channelName}`);
  const peers = new Map<number, PresencePeer>();
  const peerSubs = new Set<(peers: PresencePeer[]) => void>();
  const self: PresencePeer = {
    clientId: doc.clientID,
    name: userName,
    color: COLORS[doc.clientID % COLORS.length],
    blockId: null,
    at: Date.now(),
  };

  const post = (msg: WireMessage): void => {
    try {
      bc.postMessage(msg);
    } catch {
      // channel closed mid-flight (tab teardown) — nothing to do
    }
  };

  const notifyPeers = (): void => {
    const now = Date.now();
    const live = [...peers.values()].filter((p) => now - p.at < 30_000);
    peerSubs.forEach((cb) => cb(live));
  };

  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== 'bc-remote') post({type: 'update', payload: update});
  };
  doc.on('update', onUpdate);

  bc.onmessage = (e: MessageEvent<WireMessage>) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      post({type: 'state', payload: Y.encodeStateAsUpdate(doc)});
      post({type: 'presence', payload: self});
      return;
    }
    if (msg.type === 'state' || msg.type === 'update') {
      const bytes = msg.payload instanceof Uint8Array ? msg.payload : new Uint8Array(msg.payload as ArrayBuffer);
      Y.applyUpdate(doc, bytes, 'bc-remote');
      return;
    }
    if (msg.type === 'presence') {
      const peer = msg.payload as PresencePeer;
      if (peer.clientId === doc.clientID) return;
      peers.set(peer.clientId, {...peer, at: Date.now()});
      notifyPeers();
    }
  };

  // Join: ask peers for state, announce ourselves, heartbeat presence.
  post({type: 'hello'});
  const heartbeat = setInterval(() => {
    self.at = Date.now();
    post({type: 'presence', payload: self});
    notifyPeers(); // also expires the silent
  }, 10_000);

  return {
    disconnect() {
      clearInterval(heartbeat);
      doc.off('update', onUpdate);
      bc.close();
    },
    setPresence(blockId) {
      self.blockId = blockId;
      self.at = Date.now();
      post({type: 'presence', payload: self});
    },
    onPeers(cb) {
      peerSubs.add(cb);
      notifyPeers();
      return () => peerSubs.delete(cb);
    },
  };
}
