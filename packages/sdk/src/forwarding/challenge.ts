// The site-key half of the double-gated tunnel attach.
//
// To attach, the desktop must present BOTH a valid account.book.pub principal AND
// a fresh signature from the site's device private key over a server-issued
// challenge. The relay mints a nonce (stored in Redis, single-use), the desktop
// signs the canonical attach message, and the relay verifies it against the Site
// row's public key. The nonce + timestamp window stop replay.

import {b64uEncode} from './encoding';

export const ATTACH_MESSAGE_VERSION = 'openbook.attach.v1';

/** Default freshness window for a signed attach (ms). */
export const ATTACH_SKEW_MS = 2 * 60 * 1000;

export interface AttachClaim {
  siteId: string;
  region: string;
  nonce: string;
  /** epoch millis the desktop stamped when signing. */
  ts: number;
}

/**
 * The exact bytes both sides sign/verify. Order and separators are fixed so the
 * desktop and relay never disagree about the message.
 */
export function buildAttachMessage(claim: AttachClaim): string {
  return [ATTACH_MESSAGE_VERSION, claim.siteId, claim.region, claim.nonce, claim.ts].join(':');
}

export const REATTACH_MESSAGE_VERSION = 'openbook.reattach.v1';

/**
 * The message a desktop signs to reattach to its existing site by proving key
 * possession (keyed on the public key, since the client may know its key before
 * its site id). Distinct from the tunnel-attach message so a signature for one
 * can never be replayed as the other.
 */
export function buildReattachMessage(claim: {publicKey: string; nonce: string; ts: number}): string {
  return [REATTACH_MESSAGE_VERSION, claim.publicKey, claim.nonce, claim.ts].join(':');
}

export const RELAY_ATTACH_VERSION = 'openbook.relay.v1';

/** The message a desktop signs against the relay's connection nonce — the relay's
 *  own per-connection key proof, on top of verifying the account-issued ticket. */
export function buildRelayAttachMessage(nonce: string): string {
  return `${RELAY_ATTACH_VERSION}:${nonce}`;
}

/** A single-use, high-entropy challenge nonce. */
export function newNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return b64uEncode(bytes);
}

/** Reject stamps too far from now in either direction (clock skew tolerant). */
export function isFreshTimestamp(ts: number, now: number = Date.now(), skewMs: number = ATTACH_SKEW_MS): boolean {
  return Number.isFinite(ts) && Math.abs(now - ts) <= skewMs;
}
