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
 * workspace changes, but it cannot execute arbitrary server code. Signing
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
  /** Agent tools this plugin contributes (read server-side from the manifest). */
  agentTools?: PluginAgentTool[];
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
 * Deterministic bytes for signing: the manifest (sorted-key JSON), then each
 * file in sorted path order, every part length-prefixed so boundaries can't
 * be confused (`a + bc` ≠ `ab + c`).
 */
function canonicalBytes(manifest: PluginManifest, files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (s: string): void => {
    const bytes = te.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    parts.push(len, bytes);
  };
  push(JSON.stringify(manifest, Object.keys(manifest).sort()));
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
 * The pinned first-party registry key. Every OpenBook build trusts this;
 * additional registries are user-added keys on top (Settings → Extensions).
 * NOTE: a placeholder development key until the real registry launches —
 * regenerate and replace before publishing plugins for real.
 */
export const OPENBOOK_REGISTRY = {
  name: 'OpenBook Registry',
  publicKey: 'nI4eBQzqrIyVPEmJSEzGtqC9B0+kfWTXKyN5t8Yki/E=',
};

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
  return null;
}
