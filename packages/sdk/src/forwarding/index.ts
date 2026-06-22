// *.book.pub forwarding — the desktop-side client + shared protocol core.
//
// Ported wholesale from open.book.pub (`@book.dev/forwarding` + the relay's
// ForwardingClient/TunnelClient) so this repo owns the client. open.book.pub
// keeps only the ForwardingServer (the relay terminator + the account API). The
// whole surface is runtime-agnostic (Web Crypto + global fetch/WebSocket), so it
// runs in the Tauri webview; the desktop supplies a keychain-backed KeyStore and
// the IPC fetch.

export {ForwardingClient, MemoryKeyStore, type KeyStore, type SiteIdentity, type ForwardingClientOptions} from './forwardingClient';
export {TunnelClient, type TunnelStatus, type TunnelClientOptions} from './tunnelClient';
export {mintSiteKeypair, signWithSiteKey, verifyWithSiteKey, type SiteKeypair} from './siteKey';
export {
  buildAttachMessage,
  buildReattachMessage,
  buildRelayAttachMessage,
  newNonce,
  isFreshTimestamp,
  type AttachClaim,
} from './challenge';
export {
  encodeControl,
  decodeControl,
  encodeBody,
  decodeBody,
  type ControlFrame,
} from './tunnelProtocol';
