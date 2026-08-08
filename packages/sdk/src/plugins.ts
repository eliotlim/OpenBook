/**
 * The plugin contract: what a plugin package IS (a manifest + TypeScript
 * source files), and the signing scheme that lets a registry vouch for one.
 *
 * Trust model, stated plainly: plugins run with the same privileges as the
 * document's own live code — signing provides **provenance** (this exact
 * content was published by a registry you trust), not sandboxing. Unsigned
 * plugins install fine and are labelled unverified.
 *
 * Signing: Ed25519 over a canonical SHA-256 digest of the manifest + every
 * file (sorted paths, length-prefixed — byte-stable across platforms). The
 * app pins the first-party OpenBook registry key; users can trust additional
 * registry keys, which is all a "third-party registry" needs to be.
 */

/**
 * An agent tool a plugin contributes. Declared in the manifest (so the server
 * can read it from the stored manifest JSON and surface it to the agent without
 * running any plugin code). The tool's `action` maps to a built-in write
 * primitive that the confirm-gate then applies — so a plugin tool can propose
 * library changes, but it cannot execute arbitrary server code. Signing
 * provides provenance, NOT sandboxing — see the module trust note.
 */
export interface PluginAgentTool {
  /** Tool name the agent calls (namespaced to avoid clashing with built-ins). */
  name: string;
  /** What the tool does (shown to the model). */
  description: string;
  /** JSON-Schema for the tool's arguments object. */
  parameters?: Record<string, unknown>;
  /**
   * The built-in primitive this tool drives. `append_blocks` proposes adding
   * the given blocks to a page; `prompt` simply inlines `instructions` into the
   * agent's context (a recipe). Kept deliberately small — no code execution.
   */
  action: 'append_blocks' | 'prompt';
  /** For `action: 'prompt'`: the instructions inlined when the tool is invoked. */
  instructions?: string;
}

/**
 * The current plugin API version this build provides. A single integer,
 * bumped whenever the `PluginApi` surface grows: v1 was the original surface
 * (blocks/commands/pages/storage/fetch); v2 added `databases.*` + `assets.*`.
 * Plugins declare the version they need via {@link PluginManifest.apiVersion};
 * hosts refuse to activate a plugin that needs a NEWER version than they
 * provide (see the host's activation gate). Omitting the field means "v1 is
 * enough" — every existing plugin keeps loading unchanged.
 */
export const PLUGIN_API_VERSION = 2;

export interface PluginManifest {
  /** Stable reverse-DNS-ish identifier, e.g. `openbook.hello-world`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Emoji shown in lists (keeps the gallery dependency-free). */
  icon?: string;
  /** Entry file inside the package, e.g. `src/index.ts`. */
  main: string;
  /**
   * Minimum plugin API version this plugin needs (see
   * {@link PLUGIN_API_VERSION}). Optional — absent means v1, so pre-existing
   * plugins load unchanged. A plugin declaring a version newer than the host
   * fails activation with a clear error instead of crashing mid-run.
   */
  apiVersion?: number;
  /** Agent tools this plugin contributes (read server-side from the manifest). */
  agentTools?: PluginAgentTool[];
  /**
   * The block types this plugin registers at activation (WITHOUT the
   * `<pluginId>/` prefix the host adds). Declared in the manifest so servers —
   * which never run plugin code — can list a plugin's blocks (the agent/MCP
   * `list_block_types` tool) straight from the stored manifest JSON. Optional:
   * a plugin that declares none still works, its block types are simply not
   * enumerable server-side. For bundled first-party plugins the declaration is
   * verified against the source's `blocks.register` calls at bundle time
   * (packages/ui/scripts/bundlePlugins.ts), so it cannot drift.
   */
  blocks?: PluginBlockDeclaration[];
}

/** One manifest-declared plugin block (see {@link PluginManifest.blocks}). */
export interface PluginBlockDeclaration {
  /** The unprefixed block type, e.g. `journal-entry`. */
  type: string;
  /** One-line description surfaced by `list_block_types`. */
  description?: string;
}

/**
 * The host-side activation gate for {@link PluginManifest.apiVersion}:
 * returns a human-readable refusal when the plugin needs a newer plugin API
 * than this build provides, or `null` when it's fine to activate (field
 * absent, or ≤ {@link PLUGIN_API_VERSION}).
 */
export function pluginApiVersionError(manifest: PluginManifest): string | null {
  const needed = manifest.apiVersion;
  if (needed === undefined || needed <= PLUGIN_API_VERSION) return null;
  return `plugin "${manifest.id}" requires plugin API v${needed}, but this app provides v${PLUGIN_API_VERSION} — update OpenBook to use it`;
}

/** A plugin as stored/transported: manifest + its TypeScript source files. */
export interface PluginPackage {
  manifest: PluginManifest;
  /** path → source text (TypeScript or JavaScript). */
  files: Record<string, string>;
  signature?: PluginSignature;
}

export interface PluginSignature {
  /** Human-readable registry name shown in the UI, e.g. `OpenBook Registry`. */
  registry: string;
  /** base64 raw Ed25519 public key of the signing registry. */
  publicKey: string;
  /** base64 Ed25519 signature over {@link canonicalDigest}. */
  signature: string;
  algorithm: 'ed25519';
}

/** An installed plugin row as the server stores/lists it. */
export interface StoredPlugin extends PluginPackage {
  enabled: boolean;
  installedAt: string;
  /** Set by the client after verification — never trusted from the wire. */
  verified?: boolean;
}

const te = new TextEncoder();

/**
 * Canonical JSON for signing: objects emit ALL keys, sorted, at EVERY depth;
 * arrays are positional; primitives follow JSON.stringify semantics.
 * `undefined`, functions, and symbols are rejected outright (never silently
 * dropped) — anything the signer skips is something an attacker can vary for
 * free.
 *
 * Deliberately NOT `JSON.stringify(value, sortedKeysArray)`: a replacer ARRAY
 * allowlists those keys at every depth, so nested keys absent from the top
 * level (e.g. `agentTools[0].action`) silently vanish from the signed bytes.
 *
 * Mirrored byte-for-byte by the store's server-side port
 * (open-book-pub `packages/store/lib/canonical.ts`) — change both together.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .sort()
    .map((k) => {
      if (obj[k] === undefined || typeof obj[k] === 'function' || typeof obj[k] === 'symbol') {
        throw new TypeError(`canonical JSON cannot contain ${typeof obj[k]} (at key "${k}")`);
      }
      return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
    });
  return `{${members.join(',')}}`;
}

/**
 * Deterministic bytes for signing: the manifest (canonical JSON — keys sorted
 * recursively, see {@link canonicalJson}), then each file in sorted path
 * order, every part length-prefixed so boundaries can't be confused
 * (`a + bc` ≠ `ab + c`).
 */
function canonicalBytes(manifest: PluginManifest, files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (s: string): void => {
    const bytes = te.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    parts.push(len, bytes);
  };
  push(canonicalJson(manifest));
  for (const path of Object.keys(files).sort()) {
    push(path);
    push(files[path]);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** SHA-256 of the canonical bytes (hex) — the thing a registry signs. */
export async function canonicalDigest(manifest: PluginManifest, files: Record<string, string>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', canonicalBytes(manifest, files) as BufferSource);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/** Generate a registry keypair (raw public / pkcs8 private, base64). */
export async function generateRegistryKeys(): Promise<{publicKey: string; privateKey: string}> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {publicKey: toBase64(pub), privateKey: toBase64(priv)};
}

/** Sign a package (registry-side tooling — needs the private key). */
export async function signPlugin(
  pkg: {manifest: PluginManifest; files: Record<string, string>},
  privateKeyBase64: string,
  registry: string,
  publicKeyBase64: string,
): Promise<PluginSignature> {
  const key = await crypto.subtle.importKey('pkcs8', fromBase64(privateKeyBase64) as BufferSource, 'Ed25519', false, ['sign']);
  const digest = await canonicalDigest(pkg.manifest, pkg.files);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, te.encode(digest) as BufferSource));
  return {registry, publicKey: publicKeyBase64, signature: toBase64(sig), algorithm: 'ed25519'};
}

/**
 * Verify an Ed25519 signature (base64, raw 64 bytes) over a UTF-8 message
 * with a base64 RAW 32-byte public key. Returns false — never throws — on
 * malformed inputs. The registry protocol signs the UTF-8 bytes of the
 * lowercase hex canonical digest with exactly this scheme, for the publisher
 * signature, the notary countersignature, and revocation entries alike.
 */
export async function verifyEd25519Message(publicKeyBase64: string, message: string, signatureBase64: string): Promise<boolean> {
  try {
    const raw = fromBase64(publicKeyBase64);
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromBase64(signatureBase64) as BufferSource, te.encode(message) as BufferSource);
  } catch {
    return false;
  }
}

/**
 * Verify a package against a set of trusted registry keys. Returns the
 * matching trusted registry name, or null when unsigned, signed by an
 * untrusted key, or tampered with.
 */
export async function verifyPlugin(
  pkg: PluginPackage,
  trustedKeys: Array<{name: string; publicKey: string}>,
): Promise<{registry: string} | null> {
  const sig = pkg.signature;
  if (!sig || sig.algorithm !== 'ed25519') return null;
  const trusted = trustedKeys.find((k) => k.publicKey === sig.publicKey);
  if (!trusted) return null;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64(sig.publicKey) as BufferSource, 'Ed25519', false, ['verify']);
    const digest = await canonicalDigest(pkg.manifest, pkg.files);
    const ok = await crypto.subtle.verify('Ed25519', key, fromBase64(sig.signature) as BufferSource, te.encode(digest) as BufferSource);
    return ok ? {registry: trusted.name} : null;
  } catch {
    return null;
  }
}

/**
 * The pinned first-party registry keys. Every OpenBook build trusts ALL of
 * these; additional registries are user-added keys on top (Settings →
 * Extensions).
 *
 * THIS LIST IS THE ONE PLACE THE PRODUCTION KEY(S) LIVE. The key ceremony
 * (docs/plugin-signing.md) is: run `node scripts/gen-registry-key.mjs`, commit
 * the printed PUBLIC key here, and store the private half as the
 * `OPENBOOK_REGISTRY_PRIVATE_KEY` GitHub Actions secret — the release build
 * signs the bundled first-party plugins with it (packages/ui/scripts/
 * bundlePlugins.ts).
 *
 * A LIST so rotation can overlap (add-then-remove): append the NEW key as a
 * second entry and ship — clients of that build verify signatures from either
 * key. Once the overlap build is broadly installed, cut signing over to the
 * new key (swap the CI secret), and a later release removes the old entry.
 * The signing key SHOULD be entry [0]; extra entries exist only during
 * rotation windows. Full runbook: docs/plugin-signing.md.
 *
 * NOTE: currently a single PLACEHOLDER key whose private half was generated
 * in memory and destroyed — nothing can ever sign for it, so first-party
 * bundles show Unverified until the owner performs the key ceremony. No
 * entry may EVER match scripts/test-registry-key.json (its private half is
 * public); CI guards enforce that for every entry
 * (.github/workflows/release.yml).
 */
export const OPENBOOK_REGISTRY_KEYS: Array<{name: string; publicKey: string}> = [
  {
    name: 'OpenBook Registry',
    publicKey: 'auvZjhjbcZgepWphhILsmuQNl82djsb6dkao+/S+7zU=',
  },
];

/**
 * The primary pinned first-party key — entry [0] of
 * {@link OPENBOOK_REGISTRY_KEYS}.
 * @deprecated trust decisions must consume the whole list
 * ({@link OPENBOOK_REGISTRY_KEYS}); this alias exists for display and
 * back-compat only.
 */
export const OPENBOOK_REGISTRY = OPENBOOK_REGISTRY_KEYS[0];

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Validate a manifest's shape; returns a human-readable problem or null. */
export function validateManifest(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'openbook.json is missing or not an object';
  const man = m as Partial<PluginManifest>;
  if (!man.id || typeof man.id !== 'string' || !PLUGIN_ID_RE.test(man.id)) {
    return 'id must look like "publisher.plugin-name" (lowercase, dots and dashes)';
  }
  if (!man.name || typeof man.name !== 'string') return 'name is required';
  if (!man.version || typeof man.version !== 'string') return 'version is required';
  if (!man.main || typeof man.main !== 'string') return 'main (the entry file) is required';
  if (man.apiVersion !== undefined && (typeof man.apiVersion !== 'number' || !Number.isInteger(man.apiVersion) || man.apiVersion < 1)) {
    return 'apiVersion, when present, must be a positive integer';
  }
  return null;
}
