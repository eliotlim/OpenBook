// Per-site identity keypair (Ed25519). On first connect account.book.pub mints
// one; the desktop keeps the PRIVATE key (OS keychain), the public key is stored
// on the Site row and the prefix is derived from it. Every reconnect re-proves
// possession of the private key to reattach to the same site.
//
// Implemented on Web Crypto (`crypto.subtle`) so the same code mints in the
// account Node runtime and verifies in the relay Node runtime. Ed25519 is native
// in Node 20+/22 and modern browsers; the edge never runs these (it only does
// HMAC — see principal verification in open.book.pub).

import {b64uDecode, b64uEncode, utf8} from './encoding';

const ED25519 = {name: 'Ed25519'} as const;

export interface SiteKeypair {
  /** Raw 32-byte public key, base64url. Persisted on the Site row; prefix derives from it. */
  publicKey: string;
  /** PKCS#8 private key, base64url. Returned to the desktop ONCE, never stored server-side. */
  privateKey: string;
}

/** Mint a fresh per-site Ed25519 keypair. */
export async function mintSiteKeypair(): Promise<SiteKeypair> {
  const kp = (await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  return {publicKey: b64uEncode(pub), privateKey: b64uEncode(priv)};
}

/** Sign an attach challenge with the site's private key (desktop side). */
export async function signWithSiteKey(privateKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', b64uDecode(privateKey), ED25519, false, ['sign']);
  const sig = await crypto.subtle.sign(ED25519, key, utf8(message));
  return b64uEncode(new Uint8Array(sig));
}

/** Verify an attach signature against the site's public key (relay / account side). */
export async function verifyWithSiteKey(
  publicKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', b64uDecode(publicKey), ED25519, false, ['verify']);
    return await crypto.subtle.verify(ED25519, key, b64uDecode(signature), utf8(message));
  } catch {
    // Malformed key/signature → treat as a failed proof, never throw into the gate.
    return false;
  }
}
