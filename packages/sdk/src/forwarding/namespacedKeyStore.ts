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
 * lose the identity. While signed out (`getAccountId()` → null) READS fall
 * back to the legacy global slot (forwarding requires an account, so this only
 * covers incidental reads like showing the reserved address); WRITES refuse —
 * `save()`/`clear()` throw rather than touch the shared legacy slot, which the
 * next account to sign in would adopt as its own.
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
      // Residual trade-off (accepted): a crash BETWEEN the confirmed adopt and
      // this delete leaves the legacy entry behind, so a LATER account's first
      // load adopts the same key too — its reattach then 403s (wrong-account,
      // surfaced, identity kept) until that account resets explicitly. Two
      // copies recoverable-by-reset beats any window where the only copy of
      // the private key can be lost ("two copies, never zero").
      if ((await opts.backend.get(key)) === legacy) await opts.backend.delete(opts.baseKey);
      return identity;
    },
    async save(identity) {
      // Writes are per-account ONLY. Resolving the slot at call time means a
      // sign-out RACE (e.g. mid-ensureSite) would otherwise land this
      // account's identity in the shared legacy slot — which the NEXT account
      // to sign in adopts as its own. Refuse instead; reads stay permitted.
      const accountId = opts.getAccountId();
      if (!accountId) throw new Error('no active account — refusing to write the shared legacy slot');
      await opts.backend.set(`${opts.baseKey}.${accountId}`, JSON.stringify(identity));
    },
    async clear() {
      // Same guard as save(): a signed-out clear would delete the legacy slot
      // — an identity no account has adopted yet — instead of "this account's".
      const accountId = opts.getAccountId();
      if (!accountId) throw new Error('no active account — refusing to write the shared legacy slot');
      await opts.backend.delete(`${opts.baseKey}.${accountId}`);
    },
  };
}
