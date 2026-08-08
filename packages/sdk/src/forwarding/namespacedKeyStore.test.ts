/**
 * Per-account site-identity storage (NAME-2). The forwarded instance name is a
 * pure hash of the site key, so the keystore slot layout IS name stability:
 * one slot per account (an account switch selects, never clobbers), a one-time
 * adoption of the legacy global slot that can never lose the only copy of the
 * key, and a locked keychain that reads as "unreadable" — never as "absent"
 * (the re-provision path).
 */

import {describe, expect, it} from 'vitest';
import type {SiteIdentity} from './forwardingClient';
import {createNamespacedKeyStore, KeychainLockedError, type RawSecretStore} from './namespacedKeyStore';

const BASE = 'forwarding.site-identity';

const identity = (siteId: string): SiteIdentity => ({
  siteId,
  prefix: `${siteId}-prefix`,
  host: `${siteId}.book.cloud`,
  publicKey: `pub-${siteId}`,
  privateKey: `priv-${siteId}`,
});

/** An in-memory RawSecretStore that records every mutation, in order. */
function memoryBackend(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const ops: string[] = [];
  const backend: RawSecretStore = {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      ops.push(`set:${key}`);
      map.set(key, value);
    },
    async delete(key) {
      ops.push(`delete:${key}`);
      map.delete(key);
    },
  };
  return {backend, map, ops};
}

describe('createNamespacedKeyStore — per-account slots', () => {
  it('keeps two accounts’ identities in distinct slots (round-trip, no clobber)', async () => {
    const {backend, map} = memoryBackend();
    let account = 'A';
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => account});

    await store.save(identity('site-a'));
    account = 'B';
    await store.save(identity('site-b')); // the switch must NOT overwrite A's slot

    expect((await store.load())?.siteId).toBe('site-b');
    account = 'A';
    expect((await store.load())?.siteId).toBe('site-a'); // A's identity survived intact
    expect(map.has(`${BASE}.A`)).toBe(true);
    expect(map.has(`${BASE}.B`)).toBe(true);

    account = 'B';
    await store.clear(); // clearing B leaves A alone
    expect(await store.load()).toBeNull();
    account = 'A';
    expect((await store.load())?.siteId).toBe('site-a');
  });

  it('falls back to the legacy global slot while signed out (null account id)', async () => {
    const {backend, map} = memoryBackend({[BASE]: JSON.stringify(identity('legacy'))});
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => null});

    expect((await store.load())?.siteId).toBe('legacy');
    expect(map.has(BASE)).toBe(true); // no adoption without an account to adopt into
  });

  it('refuses to save while signed out — never writes the shared legacy slot', async () => {
    // save() resolves the slot at call time, so a sign-out RACE mid-flight
    // (e.g. during ensureSite) would otherwise land THIS account's identity in
    // the legacy global slot — which the next account to sign in adopts.
    const {backend, map, ops} = memoryBackend();
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => null});

    await expect(store.save(identity('site-a'))).rejects.toThrow('no active account');
    expect(map.size).toBe(0);
    expect(ops).toEqual([]); // nothing written anywhere
  });

  it('refuses to clear while signed out — never deletes a not-yet-adopted legacy identity', async () => {
    const legacy = JSON.stringify(identity('legacy'));
    const {backend, map, ops} = memoryBackend({[BASE]: legacy});
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => null});

    await expect(store.clear()).rejects.toThrow('no active account');
    expect(map.get(BASE)).toBe(legacy); // the sole copy survives
    expect(ops).toEqual([]);
  });

  it('returns null for a corrupt entry instead of guessing at a private key', async () => {
    const {backend} = memoryBackend({[`${BASE}.A`]: 'not-json'});
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => 'A'});
    expect(await store.load()).toBeNull();
  });
});

describe('createNamespacedKeyStore — legacy-slot migration', () => {
  it('adopts the legacy global identity into the current account’s slot on first load', async () => {
    const legacy = identity('legacy');
    const {backend, map, ops} = memoryBackend({[BASE]: JSON.stringify(legacy)});
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => 'A'});

    const loaded = await store.load();

    expect(loaded).toEqual(legacy);
    expect(map.get(`${BASE}.A`)).toBe(JSON.stringify(legacy)); // adopted…
    expect(map.has(BASE)).toBe(false); // …and the legacy slot retired
    // Ordering is the guarantee: the namespaced WRITE lands before the legacy
    // DELETE — a crash in between leaves two copies, never zero.
    expect(ops).toEqual([`set:${BASE}.A`, `delete:${BASE}`]);

    // Subsequent loads hit the namespaced slot directly; no further mutation.
    await store.load();
    expect(ops).toEqual([`set:${BASE}.A`, `delete:${BASE}`]);
  });

  it('account B loading AFTER A’s adoption gets a fresh start (null), not A’s key', async () => {
    const legacy = identity('legacy');
    const {backend} = memoryBackend({[BASE]: JSON.stringify(legacy)});
    let account = 'A';
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => account});

    expect((await store.load())?.siteId).toBe('legacy'); // A adopts + retires the legacy slot
    account = 'B';
    expect(await store.load()).toBeNull(); // B provisions its own identity — no shared key
  });

  it('never deletes the legacy slot before the namespaced write is confirmed', async () => {
    const legacy = identity('legacy');
    const {backend, map, ops} = memoryBackend({[BASE]: JSON.stringify(legacy)});
    // A backend whose writes silently vanish (e.g. a keychain that "succeeds"
    // but drops the entry): the read-back confirm fails → the legacy slot stays.
    const lossy: RawSecretStore = {...backend, set: async (key) => void ops.push(`set:${key}`)};
    const store = createNamespacedKeyStore({backend: lossy, baseKey: BASE, getAccountId: () => 'A'});

    const loaded = await store.load();

    expect(loaded).toEqual(legacy); // still served from the legacy copy
    expect(map.get(BASE)).toBe(JSON.stringify(legacy)); // the only copy is intact
    expect(ops).not.toContain(`delete:${BASE}`);
  });

  it('a failing namespaced write surfaces AND keeps the legacy slot', async () => {
    const legacy = identity('legacy');
    const {backend, map} = memoryBackend({[BASE]: JSON.stringify(legacy)});
    const failing: RawSecretStore = {
      ...backend,
      set: async () => {
        throw new Error('keychain write failed');
      },
    };
    const store = createNamespacedKeyStore({backend: failing, baseKey: BASE, getAccountId: () => 'A'});

    await expect(store.load()).rejects.toThrow('keychain write failed');
    expect(map.get(BASE)).toBe(JSON.stringify(legacy)); // never deleted first
  });

  it('ignores a corrupt legacy entry (nothing worth adopting)', async () => {
    const {backend, map, ops} = memoryBackend({[BASE]: '{broken'});
    const store = createNamespacedKeyStore({backend, baseKey: BASE, getAccountId: () => 'A'});

    expect(await store.load()).toBeNull();
    expect(map.has(BASE)).toBe(true); // left in place for diagnosis
    expect(ops).toEqual([]);
  });
});

describe('createNamespacedKeyStore — locked keychain (NAME-2)', () => {
  it('propagates KeychainLockedError from load — unreadable is NOT absent', async () => {
    const locked: RawSecretStore = {
      get: async () => {
        throw new KeychainLockedError('user denied the prompt');
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const store = createNamespacedKeyStore({backend: locked, baseKey: BASE, getAccountId: () => 'A'});

    const err = await store.load().catch((e: unknown) => e);

    // The caller (ensureSite) sees a throw, not `null` — so a denied prompt can
    // never read as "no identity stored" and trigger a renaming re-provision.
    expect(err).toBeInstanceOf(KeychainLockedError);
    expect((err as KeychainLockedError).code).toBe('keychain-locked');
  });
});
