import {invoke} from '@tauri-apps/api/core';
import {createNamespacedKeyStore, KeychainLockedError, type KeyStore, type RawSecretStore} from '@book.dev/sdk';
import type {AccountSecretStore} from '@book.dev/ui';

/**
 * The forwarding site identity — including the Ed25519 private key — is stored
 * as JSON in the OS keychain (via the Rust `keychain_*` commands), one entry
 * per account: `forwarding.site-identity.<accountId>` (NAME-2), with the bare
 * key as the pre-namespacing legacy slot a first load adopts from. The secret
 * never lands on disk in the clear, and switching accounts switches identities
 * instead of clobbering one with the other (the name — and so the address — is
 * a pure hash of this key).
 */
const SITE_IDENTITY_KEY = 'forwarding.site-identity';

/**
 * The typed error prefix the Rust `keychain_get` uses for a locked keychain /
 * denied access prompt (vs `NoEntry` → `null`). Mapped here to
 * {@link KeychainLockedError} so an unreadable identity surfaces as a retryable
 * "unlock your keychain" failure — NEVER as "no identity", which would send the
 * client down the re-provision path and silently rename the site.
 */
const KEYCHAIN_LOCKED_PREFIX = 'keychain-locked:';

const rethrowKeychainError = (e: unknown): never => {
  const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  if (msg.startsWith(KEYCHAIN_LOCKED_PREFIX)) throw new KeychainLockedError(msg.slice(KEYCHAIN_LOCKED_PREFIX.length).trim());
  throw e instanceof Error ? e : new Error(msg);
};

const keychainBackend: RawSecretStore = {
  async get(key) {
    try {
      return await invoke<string | null>('keychain_get', {key});
    } catch (e) {
      return rethrowKeychainError(e);
    }
  },
  async set(key, value) {
    try {
      await invoke('keychain_set', {key, value});
    } catch (e) {
      rethrowKeychainError(e);
    }
  },
  async delete(key) {
    try {
      await invoke('keychain_delete', {key});
    } catch (e) {
      rethrowKeychainError(e);
    }
  },
};

/** A per-account {@link KeyStore} backed by the OS keychain (see {@link SITE_IDENTITY_KEY}). */
export const createTauriKeyStore = (getAccountId: () => string | null | undefined): KeyStore =>
  createNamespacedKeyStore({backend: keychainBackend, baseKey: SITE_IDENTITY_KEY, getAccountId});

/**
 * A dev-only {@link KeyStore} backed by `localStorage`. Dev builds are adhoc /
 * linker-signed with a cdhash that changes on every relink, and macOS gates
 * keychain access by code identity — so a key saved by one `tauri dev` build
 * can't be reattached by the next (it prompts/denies), and forwarding keeps
 * provisioning a fresh site. `localStorage` lives in the webview data store
 * (keyed by origin, not the binary), so the identity survives rebuilds. It's
 * plaintext on disk — acceptable for dev; a signed release build uses the
 * keychain above, where the identity is stable across versions. Namespaced per
 * account exactly like the keychain store, with the same legacy-slot adoption.
 */
const DEV_SITE_IDENTITY_KEY = 'openbook.dev.forwarding.site-identity';

const localStorageBackend: RawSecretStore = {
  async get(key) {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  },
  async set(key, value) {
    localStorage.setItem(key, value);
  },
  async delete(key) {
    localStorage.removeItem(key);
  },
};

export const createLocalStorageKeyStore = (getAccountId: () => string | null | undefined): KeyStore =>
  createNamespacedKeyStore({backend: localStorageBackend, baseKey: DEV_SITE_IDENTITY_KEY, getAccountId});

/**
 * An {@link AccountSecretStore} backed by the OS keychain (via the `keychain_*`
 * commands), one entry per account id (OB-194). The client can hold several
 * account.book.pub accounts at once, so each device token gets its own namespaced
 * keychain slot — the secret never lands on disk in the clear, and no account can
 * read another's token. A signed release build uses this; dev builds fall back to
 * the UI's namespaced-localStorage store (the per-relink cdhash loses keychain
 * access, exactly as for the forwarding key above).
 */
const ACCOUNT_TOKEN_PREFIX = 'account.token.';

export const createTauriAccountStore = (): AccountSecretStore => ({
  get: (id) => invoke<string | null>('keychain_get', {key: ACCOUNT_TOKEN_PREFIX + id}),
  set: (id, token) => invoke('keychain_set', {key: ACCOUNT_TOKEN_PREFIX + id, value: token}),
  delete: (id) => invoke('keychain_delete', {key: ACCOUNT_TOKEN_PREFIX + id}),
});
