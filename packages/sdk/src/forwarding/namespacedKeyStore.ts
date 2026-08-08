// Per-account site-identity storage (NAME-2). The forwarded instance name is a
// pure hash of the site key, and the desktop can hold several accounts at once —
// a single global keystore slot means an account switch silently clobbers the
// other account's identity (and with it, their address). This wraps any raw
// string store (OS keychain via Tauri, localStorage in dev) into a KeyStore
// whose slot is namespaced by the CURRENT account id, with a one-time adoption
// of the legacy global slot.

import type {KeyStore, SiteIdentity} from './forwardingClient';

/**
 * A raw string secret store the namespaced KeyStore sits on: the OS keychain
 * (via the Tauri `keychain_*` commands) in a release build, `localStorage` in
 * dev. `get` resolves `null` for a genuinely absent entry — a store that cannot
 * answer (locked keychain, denied prompt) must THROW (ideally
 * {@link KeychainLockedError}), never resolve `null`: an unreadable identity
 * reported as absent would send the client down the re-provision path and
 * rename the site.
 */
export interface RawSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The OS keychain is locked or the user denied the access prompt — the stored
 * identity is unreadable, NOT absent. Callers surface this as a retryable
 * "unlock your keychain" state; no code path may treat it as "no identity" (the
 * re-provision path), which would silently rename the site.
 */
export class KeychainLockedError extends Error {
  readonly code = 'keychain-locked';

  constructor(detail?: string) {
    super(
      detail
        ? `the keychain is locked or access was denied (${detail}) — unlock it and try again; your address is kept`
        : 'the keychain is locked or access was denied — unlock it and try again; your address is kept',
    );
    this.name = 'KeychainLockedError';
  }
}

export interface NamespacedKeyStoreOptions {
  backend: RawSecretStore;
  /**
   * The pre-namespacing global slot (e.g. `forwarding.site-identity`), which
   * also prefixes the per-account slots (`<baseKey>.<accountId>`).
   */
  baseKey: string;
  /** The CURRENT account id, read at each call (it changes on account switch);
   *  null/undefined while signed out. */
  getAccountId: () => string | null | undefined;
}

/**
 * A {@link KeyStore} whose slot is `<baseKey>.<accountId>` — one site identity
 * per account, so switching accounts switches identities instead of
 * overwriting one with the other.
 *
 * Migration: the first `load()` for an account whose slot is empty adopts the
 * legacy global `<baseKey>` entry (pre-NAME-2 installs stored the identity
 * there): it is copied into the account's slot and the legacy entry is deleted
 * ONLY after a read-back confirms the copy landed — a failed write can never
 * lose the identity. While signed out (`getAccountId()` → null) the legacy
 * global slot is used as-is; forwarding requires an account, so this only
 * covers incidental reads (e.g. showing the reserved address).
 */
export function createNamespacedKeyStore(opts: NamespacedKeyStoreOptions): KeyStore {
  const slot = (): string => {
    const accountId = opts.getAccountId();
    return accountId ? `${opts.baseKey}.${accountId}` : opts.baseKey;
  };
  const parse = (raw: string): SiteIdentity | null => {
    try {
      return JSON.parse(raw) as SiteIdentity;
    } catch {
      return null; // corrupt entry — treat as none (never guess at a private key)
    }
  };
  return {
    async load() {
      const key = slot();
      const raw = await opts.backend.get(key);
      if (raw !== null) return parse(raw);
      if (key === opts.baseKey) return null; // signed out — the legacy slot IS the slot
      // One-time adoption of the legacy global slot into this account's slot.
      const legacy = await opts.backend.get(opts.baseKey);
      if (legacy === null) return null;
      const identity = parse(legacy);
      if (!identity) return null; // corrupt legacy entry — nothing worth adopting
      await opts.backend.set(key, legacy);
      // Delete the legacy entry ONLY once the namespaced copy is confirmed —
      // an unconfirmed write must never orphan the sole copy of the key.
      if ((await opts.backend.get(key)) === legacy) await opts.backend.delete(opts.baseKey);
      return identity;
    },
    async save(identity) {
      await opts.backend.set(slot(), JSON.stringify(identity));
    },
    async clear() {
      await opts.backend.delete(slot());
    },
  };
}
