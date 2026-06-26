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

/**
 * A dev-only {@link KeyStore} backed by `localStorage`. Dev builds are adhoc /
 * linker-signed with a cdhash that changes on every relink, and macOS gates
 * keychain access by code identity — so a key saved by one `tauri dev` build
 * can't be reattached by the next (it prompts/denies), and forwarding keeps
 * provisioning a fresh site. `localStorage` lives in the webview data store
 * (keyed by origin, not the binary), so the identity survives rebuilds. It's
 * plaintext on disk — acceptable for dev; a signed release build uses the
 * keychain above, where the identity is stable across versions.
 */
const DEV_SITE_IDENTITY_KEY = 'openbook.dev.forwarding.site-identity';

export const createLocalStorageKeyStore = (): KeyStore => ({
  async load() {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DEV_SITE_IDENTITY_KEY) : null;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SiteIdentity;
    } catch {
      return null;
    }
  },
  async save(identity) {
    localStorage.setItem(DEV_SITE_IDENTITY_KEY, JSON.stringify(identity));
  },
  async clear() {
    localStorage.removeItem(DEV_SITE_IDENTITY_KEY);
  },
});
