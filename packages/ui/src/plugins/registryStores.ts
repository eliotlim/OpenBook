import {
  RegistryClient,
  RegistryError,
  revocationMatches,
  type DataClient,
  type RegistryIndexEntry,
  type RegistryRevocation,
  type StoredPlugin,
  type VerifiedDownload,
} from '@book.dev/sdk';

/**
 * The user's pinned plugin stores (registries speaking `openbook-registry/1`)
 * and the revocation state learned from them. Pins live in localStorage —
 * per-user trust decisions, like `openbook.trustedRegistries` — and follow
 * PROTOCOL.md §6.2: a pin is `(baseUrl, keys)` captured at the moment the
 * user confirmed the fingerprints; afterwards nothing a fetch returns can
 * silently change it.
 */

export interface PluginStore {
  /** Display name (advisory — the pin is the identity). */
  name: string;
  baseUrl: string;
  notaryPublicKey: string | null;
  registryPublicKey: string | null;
}

/** Where a store resolution came from: the entry plus the pinned store. */
export interface StoreResolution {
  store: PluginStore;
  entry: RegistryIndexEntry;
}

const STORES_KEY = 'openbook.pluginStores';
const REVOCATIONS_KEY = 'openbook.storeRevocations';

/** How stale the cached revocation list may get before a sync re-polls. */
const REVOCATION_TTL_MS = 5 * 60 * 1000;

interface RevocationCacheEntry {
  maxSeq: number;
  entries: RegistryRevocation[];
  fetchedAt: string;
}

type RevocationCache = Record<string, RevocationCacheEntry>;

// ── Pinned stores ────────────────────────────────────────────────────────────

export function listPluginStores(): PluginStore[] {
  try {
    const raw = localStorage.getItem(STORES_KEY);
    const list = raw ? (JSON.parse(raw) as PluginStore[]) : [];
    return Array.isArray(list)
      ? list.filter((s) => s && typeof s.baseUrl === 'string' && typeof s.name === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Pin a store (the caller has ALREADY shown fingerprints for confirmation). */
export function addPluginStore(store: PluginStore): void {
  const list = listPluginStores().filter((s) => s.baseUrl !== store.baseUrl);
  localStorage.setItem(STORES_KEY, JSON.stringify([...list, store]));
}

export function removePluginStore(baseUrl: string): void {
  localStorage.setItem(STORES_KEY, JSON.stringify(listPluginStores().filter((s) => s.baseUrl !== baseUrl)));
}

/** A protocol client for one pinned store (verification anchored on the pin). */
export function storeClient(store: PluginStore): RegistryClient {
  return new RegistryClient({
    baseUrl: store.baseUrl,
    name: store.name,
    notaryPublicKey: store.notaryPublicKey,
    registryPublicKey: store.registryPublicKey,
  });
}

// ── Revocations (§6.6: poll, cache append-only, honour before install) ──────

function readRevocationCache(): RevocationCache {
  try {
    const raw = localStorage.getItem(REVOCATIONS_KEY);
    const cache = raw ? (JSON.parse(raw) as RevocationCache) : {};
    return cache && typeof cache === 'object' ? cache : {};
  } catch {
    return {};
  }
}

function writeRevocationCache(cache: RevocationCache): void {
  try {
    localStorage.setItem(REVOCATIONS_KEY, JSON.stringify(cache));
  } catch {
    // storage quota / private mode — the in-memory copy still served this session
  }
}

/**
 * Poll every pinned store's revocation feed and fold new entries into the
 * cache. Entries are APPEND-ONLY: once seen, an entry keeps being honoured
 * even if a later response omits it. An unreachable store keeps its
 * last-known-good copy. `force` skips the staleness window (used right
 * before an install, where the check must be fresh).
 */
export async function refreshRevocations(opts: {force?: boolean} = {}): Promise<void> {
  const cache = readRevocationCache();
  let changed = false;
  for (const store of listPluginStores()) {
    const cached = cache[store.baseUrl];
    if (!opts.force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < REVOCATION_TTL_MS) continue;
    try {
      const {maxSeq, entries} = await storeClient(store).revocations(cached?.maxSeq);
      const known = new Set((cached?.entries ?? []).map((e) => e.id));
      cache[store.baseUrl] = {
        maxSeq: Math.max(maxSeq, cached?.maxSeq ?? 0),
        entries: [...(cached?.entries ?? []), ...entries.filter((e) => !known.has(e.id))],
        fetchedAt: new Date().toISOString(),
      };
      changed = true;
    } catch {
      // Unreachable/broken feed: keep the last-known-good copy (never treat
      // an unreachable list as "nothing is revoked").
    }
  }
  if (changed) writeRevocationCache(cache);
}

/** The cached revocation entry covering `(pluginId, version)`, if any. */
export function revokedEntryFor(pluginId: string, version: string): RegistryRevocation | null {
  const cache = readRevocationCache();
  for (const store of Object.values(cache)) {
    for (const entry of store.entries) {
      if (revocationMatches(entry, pluginId, version)) return entry;
    }
  }
  return null;
}

// ── Resolution + verified install ───────────────────────────────────────────

/** Find a plugin id across the pinned stores (first store that has it wins). */
export async function resolvePlugin(pluginId: string): Promise<StoreResolution | null> {
  for (const store of listPluginStores()) {
    try {
      const entry = await storeClient(store).findIndexEntry(pluginId);
      if (entry) return {store, entry};
    } catch {
      // A broken store must not stop resolution against the others.
    }
  }
  return null;
}

/** The whole (filtered) catalogue of every pinned store, annotated by store. */
export async function browseStores(q?: string): Promise<StoreResolution[]> {
  const out: StoreResolution[] = [];
  const seen = new Set<string>();
  for (const store of listPluginStores()) {
    try {
      for (const entry of await storeClient(store).indexAll({q})) {
        if (seen.has(entry.id)) continue; // first pinned store wins an id clash
        seen.add(entry.id);
        out.push({store, entry});
      }
    } catch {
      // Skip an unreachable store; the rest still browse.
    }
  }
  return out;
}

/**
 * Download + verify a resolved plugin WITHOUT installing it (PROTOCOL.md
 * §6.3, all offline checks), with a FRESH revocation check before and after:
 * a revoked version must never install. The caller shows the returned trust
 * outcome to the user and only installs on explicit consent — no plugin code
 * runs before both have happened.
 */
export async function verifyFromStore(resolution: StoreResolution): Promise<VerifiedDownload> {
  const {store, entry} = resolution;
  await refreshRevocations({force: true});
  const revoked = revokedEntryFor(entry.id, entry.latestVersion);
  if (revoked) {
    throw new RegistryError('revoked', `${entry.id}@${entry.latestVersion} was revoked by the registry: ${revoked.reason}`);
  }
  return storeClient(store).download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKey: entry.pinnedKey});
}

/**
 * Install a verified download the user has consented to. Re-checks the
 * revocation cache at the last moment; the server preserves enabled state on
 * upgrade (never a downgrade from the store path — the index only serves the
 * latest approved version, and the server 409s regressions).
 */
export async function installVerified(client: DataClient, download: VerifiedDownload): Promise<StoredPlugin> {
  const {manifest} = download.pkg;
  const revoked = revokedEntryFor(manifest.id, manifest.version);
  if (revoked) {
    throw new RegistryError('revoked', `${manifest.id}@${manifest.version} was revoked by the registry: ${revoked.reason}`);
  }
  return client.installPlugin(download.pkg);
}
