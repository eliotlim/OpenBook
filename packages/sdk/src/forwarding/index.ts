// *.book.pub forwarding — the desktop-side client + shared protocol core.
//
// Ported wholesale from open.book.pub (`@book.dev/forwarding` + the relay's
// ForwardingClient/TunnelClient) so this repo owns the client. open.book.pub
// keeps only the ForwardingServer (the relay terminator + the account API). The
// whole surface is runtime-agnostic (Web Crypto + global fetch/WebSocket), so it
// runs in the Tauri webview; the desktop supplies a keychain-backed KeyStore and
// the IPC fetch.

export {
  ForwardingApiError,
  ForwardingClient,
  MemoryKeyStore,
  SITE_VISIBILITIES,
  SiteReattachError,
  type SiteReattachErrorCode,
  type KeyStore,
  type SiteIdentity,
  type SiteVisibility,
  type ForwardingClientOptions,
} from './forwardingClient';
export {TunnelClient, type TunnelStatus, type TunnelClientOptions} from './tunnelClient';
export {mintSiteKeypair, signWithSiteKey, verifyWithSiteKey, type SiteKeypair} from './siteKey';
export {
  signRosterAssertion,
  verifyRosterAssertion,
  isAcceptedRosterVersion,
  ROSTER_ASSERTION_VERSION,
  ROSTER_ASSERTION_V2,
  ACCEPTED_ROSTER_VERSIONS,
  ROSTER_ASSERTION_SKEW_MS,
  type RosterAssertionVersion,
  type RosterAssertionPayload,
  type RosterAssertionV1Payload,
  type RosterAssertionV2Payload,
  type SignRosterAssertionInput,
  type VerifyRosterAssertionInput,
  type VerifiedRosterAssertion,
} from './rosterAssertion';
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
  FORWARDED_HEADER,
  type ControlFrame,
} from './tunnelProtocol';
