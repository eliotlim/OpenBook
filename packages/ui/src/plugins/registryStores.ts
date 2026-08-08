import {
  canonicalJson,
  RegistryClient,
  RegistryError,
  REVOCATION_STALENESS_MS,
  revocationMatches,
  verifyEd25519Message,
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
 *
 * Residual threat: this cache is browser-local and plugin-writable. Rechecking
 * cached signatures prevents passive localStorage tampering before plugin code
 * starts, but revocation cannot contain a plugin that is already live and has
 * compromised the page. The kill switch primarily defends not-yet-running
 * deployments; containment of live-compromised code needs a stronger process
 * boundary than the current plugin host provides.
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

/** First-seen store + publisher-key continuity for one installed plugin id. */
export interface StorePluginProvenance {
  baseUrl: string;
  pluginId: string;
  pinnedKeys: string[];
}

/** A verified package carrying the pinned store provenance that supplied it. */
export interface VerifiedStoreDownload extends VerifiedDownload {
  provenance: StorePluginProvenance;
}

const STORES_KEY = 'openbook.pluginStores';
const REVOCATIONS_KEY = 'openbook.storeRevocations';
const PROVENANCE_KEY = 'openbook.storePluginProvenance';

/** How stale the cached revocation list may get before a sync re-polls. */
const REVOCATION_TTL_MS = 5 * 60 * 1000;

interface RevocationCacheEntry {
  maxSeq: number;
  entries: RegistryRevocation[];
  /** Client time of the most recent successful verified fetch. */
  fetchedAt: string | null;
  /** Signed server time for notarising registries; null for unsigned feeds. */
  generatedAt: string | null;
  lastFailureAt?: string;
  lastFailure?: string;
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
  const cache = readRevocationCache();
  if (cache[baseUrl]) {
    delete cache[baseUrl];
    writeRevocationCache(cache);
  }
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
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
    const valid: RevocationCache = {};
    for (const [baseUrl, entry] of Object.entries(cache)) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.entries)) continue;
      valid[baseUrl] = {
        maxSeq: Number.isSafeInteger(entry.maxSeq) && entry.maxSeq >= 0 ? entry.maxSeq : 0,
        entries: entry.entries,
        fetchedAt: typeof entry.fetchedAt === 'string' ? entry.fetchedAt : null,
        generatedAt: typeof entry.generatedAt === 'string' ? entry.generatedAt : null,
        ...(typeof entry.lastFailureAt === 'string' ? {lastFailureAt: entry.lastFailureAt} : {}),
        ...(typeof entry.lastFailure === 'string' ? {lastFailure: entry.lastFailure} : {}),
      };
    }
    return valid;
  } catch {
    return {};
  }
}

function writeRevocationCache(cache: RevocationCache): void {
  try {
    localStorage.setItem(REVOCATIONS_KEY, JSON.stringify(cache));
  } catch {
    // storage quota / private mode — the caller still fails closed on install
  }
}

export interface RevocationFeedStatus {
  state: 'fresh' | 'stale' | 'unavailable';
  fetchedAt: string | null;
  lastFailure: string | null;
}

/** User-facing freshness state for one store's last-known-good feed. */
export function revocationFeedStatus(baseUrl: string): RevocationFeedStatus {
  const cached = readRevocationCache()[baseUrl];
  if (!cached?.fetchedAt) {
    return {state: 'unavailable', fetchedAt: null, lastFailure: cached?.lastFailure ?? null};
  }
  const freshnessAt = cached.generatedAt ?? cached.fetchedAt;
  const freshnessMs = Date.parse(freshnessAt);
  const fresh = Number.isFinite(freshnessMs) && Date.now() - freshnessMs <= REVOCATION_STALENESS_MS;
  return {
    state: fresh ? 'fresh' : 'stale',
    fetchedAt: cached.fetchedAt,
    lastFailure: cached.lastFailure ?? null,
  };
}

export interface RevocationRefreshResult {
  ok: boolean;
  error?: unknown;
}

/**
 * Poll every pinned store's revocation feed and fold new entries into the
 * cache. Entries are APPEND-ONLY: once seen, an entry keeps being honoured
 * even if a later response omits it. An unreachable store keeps its
 * last-known-good copy. `force` skips the staleness window (used right
 * before an install, where the check must be fresh).
 */
export async function refreshRevocations(opts: {force?: boolean; baseUrl?: string} = {}): Promise<Map<string, RevocationRefreshResult>> {
  const cache = readRevocationCache();
  const outcomes = new Map<string, RevocationRefreshResult>();
  let changed = false;
  const stores = listPluginStores().filter((store) => !opts.baseUrl || store.baseUrl === opts.baseUrl);
  for (const store of stores) {
    const cached = cache[store.baseUrl];
    if (!opts.force && cached?.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < REVOCATION_TTL_MS) {
      outcomes.set(store.baseUrl, {ok: revocationFeedStatus(store.baseUrl).state === 'fresh'});
      continue;
    }
    try {
      const {maxSeq, entries, generatedAt} = await storeClient(store).revocations(cached?.maxSeq);
      if (maxSeq < (cached?.maxSeq ?? 0)) {
        throw new RegistryError('bad_response', `the revocation feed rolled back from sequence ${cached!.maxSeq} to ${maxSeq}`);
      }
      const known = new Set((cached?.entries ?? []).map((e) => e.id));
      cache[store.baseUrl] = {
        maxSeq,
        entries: [...(cached?.entries ?? []), ...entries.filter((e) => !known.has(e.id))],
        fetchedAt: new Date().toISOString(),
        generatedAt,
      };
      outcomes.set(store.baseUrl, {ok: true});
      changed = true;
    } catch (error) {
      // Unreachable/broken feed: keep the last-known-good copy (never treat
      // an unreachable list as "nothing is revoked").
      cache[store.baseUrl] = {
        maxSeq: cached?.maxSeq ?? 0,
        entries: cached?.entries ?? [],
        fetchedAt: cached?.fetchedAt ?? null,
        generatedAt: cached?.generatedAt ?? null,
        lastFailureAt: new Date().toISOString(),
        lastFailure: error instanceof Error ? error.message : String(error),
      };
      outcomes.set(store.baseUrl, {ok: false, error});
      changed = true;
    }
  }
  if (changed) writeRevocationCache(cache);
  return outcomes;
}

/**
 * The cached revocation covering `(pluginId, version)`, if any. Cached entries
 * are untrusted bytes: re-verify them against their store's PIN on every read.
 */
export async function revokedEntryFor(pluginId: string, version: string, opts: {baseUrl?: string} = {}): Promise<RegistryRevocation | null> {
  const cache = readRevocationCache();
  const stores = listPluginStores().filter((store) => !opts.baseUrl || store.baseUrl === opts.baseUrl);
  for (const store of stores) {
    for (const entry of cache[store.baseUrl]?.entries ?? []) {
      if (!revocationMatches(entry, pluginId, version)) continue;
      if (store.notaryPublicKey) {
        if (!entry.signature) continue;
        const payload = canonicalJson({
          id: entry.id,
          pluginId: entry.pluginId,
          reason: entry.reason,
          revokedAt: entry.createdAt,
          seq: entry.seq,
          version: entry.version ?? null,
        });
        if (!(await verifyEd25519Message(store.notaryPublicKey, payload, entry.signature))) continue;
      }
      return entry;
    }
  }
  return null;
}

async function requireFreshRevocations(store: PluginStore): Promise<void> {
  const outcome = (await refreshRevocations({force: true, baseUrl: store.baseUrl})).get(store.baseUrl);
  const status = revocationFeedStatus(store.baseUrl);
  if (!outcome?.ok || status.state !== 'fresh') {
    const detail = outcome?.error instanceof Error ? `: ${outcome.error.message}` : '';
    throw new RegistryError(
      'revocation_unavailable',
      `cannot confirm a fresh revocation feed for ${store.name}; installation is blocked${detail}`,
    );
  }
}

/** `pinnedKeys` is authoritative; old registries fall back to `pinnedKey`. */
export function registryEntryPinnedKeys(entry: RegistryIndexEntry): string[] {
  const keys = entry.pinnedKeys?.filter((key): key is string => typeof key === 'string' && key.length > 0) ?? [];
  return keys.length > 0 ? [...new Set(keys)] : [entry.pinnedKey];
}

type ProvenanceCache = Record<string, StorePluginProvenance>;

function readProvenanceCache(): ProvenanceCache {
  try {
    const raw = localStorage.getItem(PROVENANCE_KEY);
    const cache = raw ? (JSON.parse(raw) as ProvenanceCache) : {};
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return {};
    const valid: ProvenanceCache = {};
    for (const [pluginId, entry] of Object.entries(cache)) {
      if (
        entry
        && typeof entry.baseUrl === 'string'
        && entry.pluginId === pluginId
        && Array.isArray(entry.pinnedKeys)
        && entry.pinnedKeys.every((key) => typeof key === 'string')
      ) valid[pluginId] = entry;
    }
    return valid;
  } catch {
    return {};
  }
}

function sameKeySet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/** Whether an update changes its first-seen store/key set or publisher key. */
export function storeProvenanceChanged(download: VerifiedStoreDownload, installed?: StoredPlugin): boolean {
  const firstSeen = readProvenanceCache()[download.provenance.pluginId];
  // Existing installs that predate provenance persistence have an unknown
  // store origin. Treat their first store update as a trust event too.
  if (installed && !firstSeen) return true;
  if (firstSeen && (
    firstSeen.baseUrl !== download.provenance.baseUrl
    || !sameKeySet(firstSeen.pinnedKeys, download.provenance.pinnedKeys)
  )) return true;
  const installedPublisherKey = installed?.signature?.publicKey;
  return !!installedPublisherKey && !download.provenance.pinnedKeys.includes(installedPublisherKey);
}

function persistFirstSeenProvenance(provenance: StorePluginProvenance): void {
  const cache = readProvenanceCache();
  if (cache[provenance.pluginId]) return;
  try {
    localStorage.setItem(PROVENANCE_KEY, JSON.stringify({...cache, [provenance.pluginId]: provenance}));
  } catch {
    // A missing continuity record causes future updates to warn from the
    // installed publisher key when possible; it never grants more trust.
  }
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
export async function verifyFromStore(resolution: StoreResolution): Promise<VerifiedStoreDownload> {
  const {store, entry} = resolution;
  await requireFreshRevocations(store);
  const revoked = await revokedEntryFor(entry.id, entry.latestVersion, {baseUrl: store.baseUrl});
  if (revoked) {
    throw new RegistryError('revoked', `${entry.id}@${entry.latestVersion} was revoked by the registry: ${revoked.reason}`);
  }
  const pinnedKeys = registryEntryPinnedKeys(entry);
  const download = await storeClient(store).download(entry.id, entry.latestVersion, {digest: entry.digest, pinnedKeys});
  // Close the download window: a revocation published while the artifact was
  // in flight must be visible before the consent UI treats verification as done.
  await requireFreshRevocations(store);
  const revokedAfterDownload = await revokedEntryFor(entry.id, entry.latestVersion, {baseUrl: store.baseUrl});
  if (revokedAfterDownload) {
    throw new RegistryError('revoked', `${entry.id}@${entry.latestVersion} was revoked by the registry: ${revokedAfterDownload.reason}`);
  }
  return {...download, provenance: {baseUrl: store.baseUrl, pluginId: entry.id, pinnedKeys}};
}

/**
 * Install a verified download the user has consented to. Re-checks the
 * revocation cache at the last moment; the server preserves enabled state on
 * upgrade (never a downgrade from the store path — the index only serves the
 * latest approved version, and the server 409s regressions).
 */
export async function installVerified(client: DataClient, download: VerifiedStoreDownload): Promise<StoredPlugin> {
  const {manifest} = download.pkg;
  const store = listPluginStores().find((candidate) => candidate.baseUrl === download.provenance.baseUrl);
  if (!store) {
    throw new RegistryError('revocation_unavailable', 'the store that verified this download is no longer pinned; installation is blocked');
  }
  await requireFreshRevocations(store);
  const revoked = await revokedEntryFor(manifest.id, manifest.version, {baseUrl: store.baseUrl});
  if (revoked) {
    throw new RegistryError('revoked', `${manifest.id}@${manifest.version} was revoked by the registry: ${revoked.reason}`);
  }
  const installed = await client.installPlugin(download.pkg);
  persistFirstSeenProvenance(download.provenance);
  return installed;
}
