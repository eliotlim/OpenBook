import {invoke} from '@tauri-apps/api/core';
import type {KeyStore, SiteIdentity} from '@book.dev/sdk';

/**
 * A {@link KeyStore} backed by the OS keychain (via the Rust `keychain_*`
 * commands). The forwarding site identity — including the Ed25519 private key —
 * is stored here as JSON, so the secret never lands on disk in the clear.
 */
const SITE_IDENTITY_KEY = 'forwarding.site-identity';

export const createTauriKeyStore = (): KeyStore => ({
  async load() {
    const raw = await invoke<string | null>('keychain_get', {key: SITE_IDENTITY_KEY});
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SiteIdentity;
    } catch {
      return null; // corrupt entry — treat as none, the client re-provisions
    }
  },
  async save(identity) {
    await invoke('keychain_set', {key: SITE_IDENTITY_KEY, value: JSON.stringify(identity)});
  },
  async clear() {
    await invoke('keychain_delete', {key: SITE_IDENTITY_KEY});
  },
});
