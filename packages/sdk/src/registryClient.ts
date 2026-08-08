/**
 * Client for the OpenBook registry protocol (`openbook-registry/1`) — the
 * read side a store-browsing app needs: the registry identity document, the
 * paginated install index, per-plugin metadata, verified downloads, and the
 * signed revocation feed.
 *
 * Trust model (PROTOCOL.md §6): a registry is identified by its pinned
 * `(baseUrl, keys)`, never by anything a fetch returned. The caller supplies
 * the pin; this client verifies everything it downloads against it —
 * digest recomputed from the bytes, publisher signature against the index's
 * `pinnedKey`, notary countersignature and revocation entries against the
 * pinned notary key. Any failed step throws: there is no partial trust.
 */

import {
  canonicalDigest,
  canonicalJson,
  verifyEd25519Message,
  type PluginManifest,
  type PluginPackage,
  type PluginSignature,
} from './plugins';
import type {FetchLike} from './client';

export type {FetchLike};

// ── Semver (the protocol's version ordering) ─────────────────────────────────

// Strict-enough semver: MAJOR.MINOR.PATCH with optional -prerelease/+build.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;

export function isSemver(v: string): boolean {
  return SEMVER_RE.test(v);
}

/**
 * Semver precedence compare (spec §11): numeric MAJOR.MINOR.PATCH, then
 * prerelease (absent > present; numeric identifiers numerically, and lower
 * than alphanumeric ones). Build metadata is ignored. Returns <0, 0, >0.
 * Inputs must already satisfy {@link isSemver}. Byte-for-byte port of the
 * store's `compareSemver` (open-book-pub `packages/store/lib/canonical.ts`).
 */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new TypeError(`compareSemver: not semver: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const prea = pa[4]?.slice(1);
  const preb = pb[4]?.slice(1);
  if (prea === undefined && preb === undefined) return 0;
  if (prea === undefined) return 1; // a release outranks any prerelease
  if (preb === undefined) return -1;
  const as = prea.split('.');
  const bs = preb.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1; // fewer identifiers = lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── Wire types (PROTOCOL.md §5) ──────────────────────────────────────────────

/** `GET /api/v1/registry` — the identity document a client pins. */
export interface RegistryDocument {
  protocol: string;
  name: string;
  baseUrl: string;
  apiVersion: number;
  algorithms: string[];
  notaryPublicKey: string | null;
  registryPublicKey: string | null;
  fingerprints: {notary: string | null; registry: string | null};
  endpoints: Record<string, string>;
}

/** One row of `GET /api/v1/index` — a plugin at its latest approved version. */
export interface RegistryIndexEntry {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  category: string | null;
  publisher: string | null;
  /** The publisher key this plugin id is pinned to (TOFU) — the signature anchor. */
  pinnedKey: string;
  latestVersion: string;
  /** Canonical digest of the latest approved version — what both signatures cover. */
  digest: string;
  /** Content address of the publisher's uploaded document (pre-splice). */
  artifactSha256: string;
}

export interface RegistryIndexPage {
  plugins: RegistryIndexEntry[];
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/** The notary countersignature spliced into approved downloads (§5.4.1). */
export interface RegistryNotarization {
  registry: string;
  publicKey: string;
  signature: string;
  algorithm: string;
  timestamp: string;
}

export interface RegistryPluginVersion {
  version: string;
  digest: string;
  artifactSha256: string;
  status: string;
  createdAt: string;
  manifest: PluginManifest;
  notarization: RegistryNotarization | null;
}

/** `GET /api/v1/plugins/{id}` — a plugin's version history. */
export interface RegistryPluginMeta {
  id: string;
  pinnedKey: string;
  createdAt: string;
  versions: RegistryPluginVersion[];
}

/** One signed entry of the revocation feed (§5.5). */
export interface RegistryRevocation {
  id: string;
  seq: number;
  pluginId: string;
  /** The revoked version, or null = every version, including future ones. */
  version: string | null;
  reason: string;
  signerPublicKey: string | null;
  signature: string | null;
  createdAt: string;
}

/** The trust states a verified download can earn (§6.5). */
export interface RegistryTrust {
  /** Package signature verifies with the pinned `registryPublicKey`. */
  firstParty: boolean;
  /** Notary countersignature verifies with the pinned `notaryPublicKey`. */
  notarised: boolean;
}

/** A fully verified download: the package plus what the verification proved. */
export interface VerifiedDownload {
  pkg: PluginPackage;
  /** The recomputed canonical digest the signatures were checked over. */
  digest: string;
  trust: RegistryTrust;
  notarization: RegistryNotarization | null;
}

/** The pin a client persists for a registry: base URL + keys, per §6.2. */
export interface RegistryPin {
  baseUrl: string;
  name?: string;
  notaryPublicKey?: string | null;
  registryPublicKey?: string | null;
}


/** A typed failure from the registry client; `code` is stable for branching. */
export class RegistryError extends Error {
  constructor(
    readonly code:
      | 'unsupported_protocol'
      | 'insecure_base_url'
      | 'http_error'
      | 'revoked'
      | 'not_found'
      | 'digest_mismatch'
      | 'etag_mismatch'
      | 'signature_invalid'
      | 'notarization_invalid'
      | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
  registry: '/api/v1/registry',
  index: '/api/v1/index',
  plugin: '/api/v1/plugins/{id}',
  download: '/api/v1/plugins/{id}/versions/{version}/download',
  revocations: '/api/v1/revocations',
};

const PROTOCOL_MAJOR = 1;

/** HTTPS only, except an explicit developer-local http://localhost (§3). */
export function registryBaseUrlProblem(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return null;
  return 'a registry must be served over https:// (http is allowed only for localhost)';
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Human-comparable fingerprint of a raw Ed25519 key (§6.2): SHA-256 of the
 * raw 32 bytes, truncated to 128 bits, as eight dash-separated hex quads.
 */
export async function registryKeyFingerprint(publicKeyBase64: string): Promise<string> {
  const raw = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0));
  const hex = (await sha256Hex(raw)).slice(0, 32);
  return hex.replace(/(.{4})(?=.)/g, '$1-');
}

/** Does a revocation entry cover this `(pluginId, version)`? `version: null` covers all. */
export function revocationMatches(entry: Pick<RegistryRevocation, 'pluginId' | 'version'>, pluginId: string, version: string): boolean {
  return entry.pluginId === pluginId && (entry.version === null || entry.version === version);
}

/**
 * Fetch + validate a registry's identity document WITHOUT a pin — the
 * add-a-registry flow (§6.2): the caller must display the fingerprints for
 * out-of-band confirmation before pinning anything from this response.
 */
export async function fetchRegistryDocument(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<RegistryDocument> {
  const problem = registryBaseUrlProblem(baseUrl);
  if (problem) throw new RegistryError('insecure_base_url', problem);
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${DEFAULT_ENDPOINTS.registry}`);
  if (!res.ok) throw new RegistryError('http_error', `registry document fetch failed (${res.status})`);
  const doc = (await res.json()) as RegistryDocument;
  const match = /^openbook-registry\/(\d+)$/.exec(doc?.protocol ?? '');
  if (!match || Number(match[1]) !== PROTOCOL_MAJOR) {
    throw new RegistryError('unsupported_protocol', `unsupported registry protocol ${JSON.stringify(doc?.protocol)} — this app speaks openbook-registry/${PROTOCOL_MAJOR}`);
  }
  if (!Array.isArray(doc.algorithms) || !doc.algorithms.includes('ed25519')) {
    throw new RegistryError('unsupported_protocol', 'the registry offers no signature algorithm this app supports (ed25519)');
  }
  return doc;
}

/**
 * The read client for one pinned registry. All verification happens against
 * the PIN handed to the constructor — never against keys learned from the
 * network afterwards.
 */
export class RegistryClient {
  private readonly fetchImpl: FetchLike;
  private doc: RegistryDocument | null = null;

  constructor(
    readonly pin: RegistryPin,
    opts: {fetch?: FetchLike} = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    const problem = registryBaseUrlProblem(pin.baseUrl);
    if (problem) throw new RegistryError('insecure_base_url', problem);
  }

  private get base(): string {
    return this.pin.baseUrl.replace(/\/$/, '');
  }

  private async endpoint(name: keyof typeof DEFAULT_ENDPOINTS, subst: Record<string, string> = {}): Promise<string> {
    const doc = await this.document().catch(() => null);
    let template = doc?.endpoints?.[name] ?? DEFAULT_ENDPOINTS[name];
    for (const [k, v] of Object.entries(subst)) template = template.replace(`{${k}}`, encodeURIComponent(v));
    return `${this.base}${template}`;
  }

  private async json<T>(url: string): Promise<{body: T; res: Response}> {
    const res = await this.fetchImpl(url);
    if (res.status === 404) throw new RegistryError('not_found', `not found: ${url}`);
    if (res.status === 410) throw new RegistryError('revoked', 'this version has been revoked by the registry');
    if (!res.ok) throw new RegistryError('http_error', `registry request failed (${res.status}): ${url}`);
    return {body: (await res.json()) as T, res};
  }

  /**
   * The registry's identity document (fetched once, cached). Checked against
   * the pin: a protocol this client does not speak is refused, and a document
   * whose keys disagree with pinned keys is refused as a possible attack
   * (§6.2 — a pin change is a NEW trust decision, never a silent update).
   */
  async document(): Promise<RegistryDocument> {
    if (this.doc) return this.doc;
    const doc = await fetchRegistryDocument(this.base, this.fetchImpl);
    if (this.pin.notaryPublicKey && doc.notaryPublicKey && doc.notaryPublicKey !== this.pin.notaryPublicKey) {
      throw new RegistryError('unsupported_protocol', 'the registry\'s notary key no longer matches the pinned key — refusing (re-confirm the registry out of band)');
    }
    if (this.pin.registryPublicKey && doc.registryPublicKey && doc.registryPublicKey !== this.pin.registryPublicKey) {
      throw new RegistryError('unsupported_protocol', 'the registry\'s first-party key no longer matches the pinned key — refusing (re-confirm the registry out of band)');
    }
    this.doc = doc;
    return doc;
  }

  /** One page of the install index (§5.2). */
  async indexPage(opts: {limit?: number; cursor?: string; q?: string; category?: string} = {}): Promise<RegistryIndexPage> {
    const url = new URL(await this.endpoint('index'));
    if (opts.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
    if (opts.q) url.searchParams.set('q', opts.q);
    if (opts.category) url.searchParams.set('category', opts.category);
    const {body} = await this.json<RegistryIndexPage>(url.toString());
    if (!Array.isArray(body?.plugins)) throw new RegistryError('bad_response', 'index response has no plugins array');
    return body;
  }

  /**
   * Walk the whole (filtered) index, one page at a time — cursors are walked
   * sequentially per §9, capped defensively against a cursor loop.
   */
  async indexAll(opts: {q?: string; category?: string; limit?: number} = {}): Promise<RegistryIndexEntry[]> {
    const all: RegistryIndexEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const {plugins, nextCursor} = await this.indexPage({...opts, cursor});
      all.push(...plugins);
      if (!nextCursor) return all;
      cursor = nextCursor;
    }
    throw new RegistryError('bad_response', 'index walk exceeded 100 pages — refusing a possible cursor loop');
  }

  /** Find one plugin's index row by exact id (via the substring search filter). */
  async findIndexEntry(pluginId: string): Promise<RegistryIndexEntry | null> {
    const matches = await this.indexAll({q: pluginId});
    return matches.find((p) => p.id === pluginId) ?? null;
  }

  /** A plugin's version history (§5.3). Null when the registry doesn't know the id. */
  async pluginMeta(pluginId: string): Promise<RegistryPluginMeta | null> {
    try {
      const {body} = await this.json<RegistryPluginMeta>(await this.endpoint('plugin', {id: pluginId}));
      return body;
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /**
   * Download one version and verify it offline (§6.3). Every step must pass:
   *
   * 1. sha256(served bytes) equals the strong `ETag` (transport integrity).
   * 2. The canonical digest RECOMPUTED from manifest+files equals `expect.digest`
   *    (the value the index/metadata promised) and the `X-Canonical-Digest` hint.
   * 3. The publisher signature verifies over that digest with `expect.pinnedKey`
   *    — never with the key that travelled inside the package.
   * 4. A present notary countersignature verifies with the PINNED notary key —
   *    present-but-invalid is a hard failure, not a downgrade to "unnotarised".
   *
   * Revocations are the caller's step (§6.6): check {@link revocations} before
   * installing what this returns.
   */
  async download(pluginId: string, version: string, expect: {digest: string; pinnedKey: string}): Promise<VerifiedDownload> {
    const res = await this.fetchImpl(await this.endpoint('download', {id: pluginId, version}));
    if (res.status === 410) throw new RegistryError('revoked', `${pluginId}@${version} has been revoked by the registry`);
    if (res.status === 404) throw new RegistryError('not_found', `${pluginId}@${version} is not downloadable from this registry`);
    if (!res.ok) throw new RegistryError('http_error', `download failed (${res.status})`);
    const served = new Uint8Array(await res.arrayBuffer());

    const etag = res.headers.get('etag');
    if (etag) {
      const tag = etag.replace(/^W\//, '').replace(/^"|"$/g, '');
      if ((await sha256Hex(served)) !== tag) {
        throw new RegistryError('etag_mismatch', 'the downloaded bytes do not hash to the served ETag — corrupted or tampered in transit');
      }
    }

    let doc: PluginPackage & {notarization?: RegistryNotarization | null};
    try {
      doc = JSON.parse(new TextDecoder().decode(served)) as PluginPackage & {notarization?: RegistryNotarization | null};
    } catch {
      throw new RegistryError('bad_response', 'the download is not a JSON plugin package');
    }
    if (!doc || typeof doc !== 'object' || !doc.manifest || !doc.files) {
      throw new RegistryError('bad_response', 'the download is missing manifest or files');
    }

    const digest = await canonicalDigest(doc.manifest, doc.files);
    if (digest !== expect.digest) {
      throw new RegistryError('digest_mismatch', 'the recomputed canonical digest does not match what the registry index promised');
    }
    const digestHeader = res.headers.get('x-canonical-digest');
    if (digestHeader && digestHeader !== digest) {
      throw new RegistryError('digest_mismatch', 'the X-Canonical-Digest header disagrees with the recomputed digest');
    }

    const sig: PluginSignature | undefined = doc.signature;
    if (!sig || sig.algorithm !== 'ed25519' || !(await verifyEd25519Message(expect.pinnedKey, digest, sig.signature))) {
      throw new RegistryError('signature_invalid', 'the publisher signature does not verify against the key this plugin id is pinned to');
    }

    const notarization = doc.notarization ?? null;
    let notarised = false;
    if (notarization) {
      // Verify with the PINNED notary key only. Without a pinned key the
      // member is unverifiable and earns nothing (notarised stays false); a
      // pinned key + failing signature is a hard failure.
      if (this.pin.notaryPublicKey) {
        if (!(await verifyEd25519Message(this.pin.notaryPublicKey, digest, notarization.signature))) {
          throw new RegistryError('notarization_invalid', 'the notary countersignature does not verify against the pinned notary key');
        }
        notarised = true;
      }
    }

    const firstParty = !!this.pin.registryPublicKey && (await verifyEd25519Message(this.pin.registryPublicKey, digest, sig.signature));

    return {
      pkg: {manifest: doc.manifest, files: doc.files, signature: sig},
      digest,
      trust: {firstParty, notarised},
      notarization,
    };
  }

  /**
   * The revocation feed (§5.5, §6.6), from `since` (exclusive). Entries are
   * verified against the pinned notary key; on a registry that advertises a
   * notary key, unsigned or badly-signed entries are IGNORED (an injection is
   * not a kill switch). Only a registry with no notary key at all has its
   * unsigned entries honoured — failing open on the kill switch is the
   * dangerous direction.
   */
  async revocations(since?: number): Promise<{maxSeq: number; entries: RegistryRevocation[]}> {
    const url = new URL(await this.endpoint('revocations'));
    if (since !== undefined && since > 0) url.searchParams.set('since', String(since));
    const {body} = await this.json<{maxSeq: number; revocations: RegistryRevocation[]}>(url.toString());
    if (!Array.isArray(body?.revocations) || typeof body.maxSeq !== 'number') {
      throw new RegistryError('bad_response', 'malformed revocations response');
    }
    const notaryKey = this.pin.notaryPublicKey ?? null;
    const entries: RegistryRevocation[] = [];
    for (const entry of body.revocations) {
      if (!entry || typeof entry.pluginId !== 'string') continue;
      if (notaryKey) {
        if (!entry.signature) continue; // unsigned on a signing registry = injection, not revocation
        const payload = canonicalJson({
          id: entry.id,
          pluginId: entry.pluginId,
          reason: entry.reason,
          revokedAt: entry.createdAt,
          seq: entry.seq,
          version: entry.version ?? null,
        });
        if (!(await verifyEd25519Message(notaryKey, payload, entry.signature))) continue;
      }
      entries.push(entry);
    }
    return {maxSeq: body.maxSeq, entries};
  }
}
